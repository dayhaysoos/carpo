import {
  deleteClipArtifacts,
  deleteHelperUploadSource,
  getClipById,
  markGifComplete,
  markGifFailed,
  markClipComplete,
  markClipDownloadingIfQueued,
  markClipFailed,
  outputKeysForClip,
  updateClipStatus,
} from "./db";
import { ENCODER_POOL_INSTANCE } from "./encoder-pool";
import type { Env } from "./env";
import type { ClipStatus, CreateClipRequest, EncoderJobSpec, FailureMode, GifEncoderJobSpec } from "./types";
import { extractCaptionFromFilters } from "./validation";

function isStickyTerminal(
  status: ClipStatus,
  failureMode: FailureMode | null,
): boolean {
  if (status === "complete") {
    return true;
  }
  if (status === "failed" && failureMode === "confirmed") {
    return true;
  }
  return false;
}

interface EncoderRunResult {
  status?: string;
  errorMessage?: string;
  outputs?: {
    mp4Key?: string;
    thumbnailKey?: string;
  };
}

export type EncoderRunHttpOutcome =
  | { kind: "ok"; result: EncoderRunResult; httpOk: boolean }
  | { kind: "http_error"; status: number; body: string }
  | { kind: "parse_error"; status: number; body: string }
  | {
      kind: "complete";
      outputs: { mp4Key: string; thumbnailKey: string };
    };

export function classifyEncoderRunResponse(
  httpOk: boolean,
  status: number,
  body: string,
): EncoderRunHttpOutcome {
  const parsed = parseEncoderRunResult(body);
  if (parsed) {
    return { kind: "ok", result: parsed, httpOk };
  }
  if (!httpOk) {
    return { kind: "http_error", status, body };
  }
  return { kind: "parse_error", status, body };
}

export async function recordEncoderRunOutcome(
  env: Env,
  clipId: string,
  outcome: EncoderRunHttpOutcome,
): Promise<void> {
  const outputKeys = outputKeysForClip(clipId);

  if (outcome.kind === "complete") {
    await markClipComplete(
      env.DB,
      clipId,
      outcome.outputs.mp4Key,
      outcome.outputs.thumbnailKey,
    );
    await cleanupUploadSource(env, clipId);
    return;
  }

  if (outcome.kind === "parse_error") {
    await failClipAmbiguous(
      env,
      clipId,
      `Encoder rejected job: ${outcome.body}`,
    );
    return;
  }

  if (outcome.kind === "http_error") {
    const parsed = parseEncoderRunResult(outcome.body);
    if (parsed?.status === "failed") {
      await failClip(
        env,
        clipId,
        parsed.errorMessage ?? "Encoding failed",
      );
      return;
    }
    await failClipAmbiguous(
      env,
      clipId,
      `Encoder rejected job: ${outcome.body}`,
    );
    return;
  }

  const result = outcome.result;
  if (result.status === "failed") {
    await failClip(env, clipId, result.errorMessage ?? "Encoding failed");
    return;
  }

  if (result.status === "complete") {
    const mp4Key = result.outputs?.mp4Key ?? outputKeys.mp4Key;
    const thumbnailKey =
      result.outputs?.thumbnailKey ?? outputKeys.thumbnailKey;
    await markClipComplete(env.DB, clipId, mp4Key, thumbnailKey);
    await cleanupUploadSource(env, clipId);
    return;
  }

  if (!outcome.httpOk) {
    await failClipAmbiguous(
      env,
      clipId,
      `Encoder rejected job: ${JSON.stringify(result)}`,
    );
    return;
  }

  await failClipAmbiguous(
    env,
    clipId,
    `Unexpected encoder status: ${result.status ?? "unknown"}`,
  );
}

export async function dispatchEncodingJob(
  env: Env,
  clipId: string,
  request: CreateClipRequest,
  workerOrigin: string,
): Promise<void> {
  let runPosted = false;

  try {
    const record = await getClipById(env.DB, clipId);
    if (!record) {
      console.warn(
        `Clip ${clipId} not found for encoding dispatch; skipping`,
      );
      return;
    }

    const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
    const outputKeys = outputKeysForClip(clipId);
    const workerBaseUrl =
      env.WORKER_BASE_URL || workerOrigin || "http://localhost:8787";
    const callbackUrl = `${workerBaseUrl}/api/internal/jobs/${clipId}/status`;

    const jobSpec: EncoderJobSpec = {
      jobId: clipId,
      source: request.source,
      trimStart: request.trimStart,
      trimEnd: request.trimEnd,
      quality: request.quality ?? "1080p",
      caption: extractCaptionFromFilters(request.filters),
      filters: request.filters,
      maxClipLengthSeconds: Number(env.MAX_CLIP_LENGTH_SECONDS) || 60,
      outputs: outputKeys,
      callbackUrl,
      callbackSecret: record.callback_secret,
      artifactUploadUrls: {
        mp4: `${workerBaseUrl}/api/internal/jobs/${clipId}/artifacts/mp4`,
        thumbnail: `${workerBaseUrl}/api/internal/jobs/${clipId}/artifacts/thumbnail`,
      },
    };
    const startResponse = await container.fetch("http://encoder/__carpo/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: request.source }),
    });
    if (!startResponse.ok) {
      const detail = await startResponse.text();
      throw new Error(
        detail || `Encoder container start failed (${startResponse.status})`,
      );
    }
    // Hand off to the DO; it returns 202 immediately and runs the job in
    // waitUntil behind a FIFO queue. Keepalive and queue lifecycle live in the
    // DO — the worker only warms the container via /__carpo/start.
    runPosted = true;
    const dispatchResponse = await container.fetch(
      "http://encoder/__carpo/dispatch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobSpec),
      },
    );
    if (!dispatchResponse.ok) {
      const detail = await dispatchResponse.text();
      throw new Error(
        detail || `Encoder dispatch failed (${dispatchResponse.status})`,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown encoding error";
    if (runPosted) {
      // Transport/parse failures after /run was posted are ambiguous; keep artifacts.
      await failClipAmbiguous(
        env,
        clipId,
        `Dispatch error — encoding may not have started: ${message}`,
      );
    } else {
      // Pre-/run failures (container start, etc.) cannot have produced artifacts.
      await failClip(env, clipId, message);
    }
  }
}

export async function failClip(
  env: Env,
  clipId: string,
  errorMessage: string,
): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  const marked = await markClipFailed(
    env.DB,
    clipId,
    errorMessage,
    "confirmed",
  );
  if (!marked) {
    return;
  }

  await deleteClipArtifacts(env.CLIPS_BUCKET, clipId);
  if (record) {
    await deleteHelperUploadSource(env.CLIPS_BUCKET, record);
  }
}

export async function failClipAmbiguous(
  env: Env,
  clipId: string,
  errorMessage: string,
): Promise<void> {
  // /run outcome unknown (transport error or unreadable body). Do not delete
  // artifacts that may have been uploaded before the worker lost contact.
  await markClipFailed(env.DB, clipId, errorMessage, "ambiguous");
}

function parseEncoderRunResult(
  body: string,
): EncoderRunResult | null {
  try {
    const parsed = JSON.parse(body) as EncoderRunResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function applyStatusUpdate(
  env: Env,
  clipId: string,
  status: ClipStatus,
  errorMessage?: string | null,
): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return;
  }

  // Terminal state machine: complete and confirmed-failed are sticky. A late
  // complete callback may recover an ambiguous-failed clip when the encoder
  // finished after the worker lost the /run response.
  if (isStickyTerminal(record.status, record.failure_mode)) {
    return;
  }
  if (record.status === "failed" && record.failure_mode === "ambiguous") {
    if (status === "complete") {
      const keys = outputKeysForClip(clipId);
      await markClipComplete(env.DB, clipId, keys.mp4Key, keys.thumbnailKey);
      await cleanupUploadSource(env, clipId);
      return;
    }
    if (status === "failed") {
      await failClip(env, clipId, errorMessage ?? "Encoding failed");
      return;
    }
    return;
  }

  if (status === "complete") {
    const keys = outputKeysForClip(clipId);
    await markClipComplete(env.DB, clipId, keys.mp4Key, keys.thumbnailKey);
    await cleanupUploadSource(env, clipId);
    return;
  }

  if (status === "failed") {
    await failClip(env, clipId, errorMessage ?? "Encoding failed");
    return;
  }

  await updateClipStatus(env.DB, clipId, status, errorMessage ?? null);
}

async function cleanupUploadSource(env: Env, clipId: string): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return;
  }
  await deleteHelperUploadSource(env.CLIPS_BUCKET, record);
}

interface GifEncoderRunResult {
  status?: string;
  errorMessage?: string;
  outputs?: {
    gifKey?: string;
  };
}

export async function dispatchGifExportJob(
  env: Env,
  clipId: string,
): Promise<void> {
  try {
    const record = await getClipById(env.DB, clipId);
    if (!record || record.status !== "complete" || !record.output_mp4_key) {
      return;
    }

    const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
    const gifKey = outputKeysForClip(clipId).gifKey;

    const startResponse = await container.fetch("http://encoder/__carpo/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!startResponse.ok) {
      const detail = await startResponse.text();
      throw new Error(
        detail || `GIF encoder container start failed (${startResponse.status})`,
      );
    }
    const jobSpec: GifEncoderJobSpec = {
      jobId: clipId,
      jobType: "gif",
      sourceMp4Key: record.output_mp4_key,
      source: { type: "file", path: `/tmp/carpo-src-${clipId}` },
      outputs: { gifKey },
    };

    const response = await container.fetch("http://encoder/__carpo/gif-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jobSpec),
    });

    if (!response.ok) {
      const detail = await response.text();
      const parsed = parseGifEncoderRunResult(detail);
      await markGifFailed(
        env.DB,
        clipId,
        parsed?.errorMessage ?? `GIF encoder rejected job: ${detail}`,
      );
      return;
    }

    const result = (await response.json()) as GifEncoderRunResult;

    if (result.status === "failed") {
      await markGifFailed(
        env.DB,
        clipId,
        result.errorMessage ?? "GIF encoding failed",
      );
      return;
    }

    if (result.status !== "complete") {
      await markGifFailed(
        env.DB,
        clipId,
        `Unexpected GIF encoder status: ${result.status ?? "unknown"}`,
      );
      return;
    }

    const storedGifKey = result.outputs?.gifKey ?? gifKey;
    await markGifComplete(env.DB, clipId, storedGifKey);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown GIF encoding error";
    await markGifFailed(env.DB, clipId, message);
  }
}

function parseGifEncoderRunResult(
  body: string,
): GifEncoderRunResult | null {
  try {
    const parsed = JSON.parse(body) as GifEncoderRunResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
