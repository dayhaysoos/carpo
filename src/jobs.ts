import {
  deleteClipArtifacts,
  deleteUploadSource,
  getClipById,
  markGifComplete,
  markGifFailed,
  markClipComplete,
  markClipDownloadingIfQueued,
  markClipFailed,
  outputKeysForClip,
  updateClipStatus,
} from "./db";
import type { Env } from "./env";
import type { ClipStatus, CreateClipRequest, EncoderJobSpec, FailureMode, GifEncoderJobSpec } from "./types";
import { extractCaptionFromFilters } from "./validation";

const ACTIVITY_RENEWAL_MS = 30_000;

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

    const container = env.ENCODER_CONTAINER.getByName(clipId);
    const outputKeys = outputKeysForClip(clipId);
    const workerBaseUrl =
      env.WORKER_BASE_URL || workerOrigin || "http://localhost:8787";
    const callbackUrl = `${workerBaseUrl}/api/internal/jobs/${clipId}/status`;

    const jobSpec: EncoderJobSpec = {
      jobId: clipId,
      source: request.source,
      trimStart: request.trimStart,
      trimEnd: request.trimEnd,
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
    await markContainerJobRunningSafe(container, true);
    const keepAlive = startActivityRenewal(container);

    try {
      // Set before fetch, not after response: a thrown fetch does not prove the
      // encoder never received /run (the connection may drop after delivery).
      // Ambiguous failure preserves artifacts and allows late callback recovery.
      runPosted = true;
      const responsePromise = container.fetch("http://encoder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobSpec),
      });
      // Optimistic in-progress status: polling stays truthful while /run blocks
      // even when encoder callbacks never reach the worker.
      await markClipDownloadingIfQueued(env.DB, clipId);
      const response = await responsePromise;

      if (!response.ok) {
        const detail = await response.text();
        const parsed = parseEncoderRunResult(detail);
        if (parsed?.status === "failed") {
          await failClip(
            env,
            clipId,
            parsed.errorMessage ?? "Encoding failed",
          );
          return;
        }

        // Non-JSON or non-failed /run responses are ambiguous; artifacts may exist.
        await failClipAmbiguous(
          env,
          clipId,
          `Encoder rejected job: ${detail}`,
        );
        return;
      }

      const result = (await response.json()) as EncoderRunResult;

      if (result.status === "failed") {
        await failClip(
          env,
          clipId,
          result.errorMessage ?? "Encoding failed",
        );
        return;
      }

      if (result.status !== "complete") {
        await failClipAmbiguous(
          env,
          clipId,
          `Unexpected encoder status: ${result.status ?? "unknown"}`,
        );
        return;
      }

      // Authoritative completion: trust the successful /run body over callbacks.
      const mp4Key = result.outputs?.mp4Key ?? outputKeys.mp4Key;
      const thumbnailKey =
        result.outputs?.thumbnailKey ?? outputKeys.thumbnailKey;
      await markClipComplete(env.DB, clipId, mp4Key, thumbnailKey);
      await cleanupUploadSource(env, clipId);
    } finally {
      clearInterval(keepAlive);
      await markContainerJobRunningSafe(container, false);
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
    await deleteUploadSource(env.CLIPS_BUCKET, record);
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

async function markContainerJobRunning(
  container: DurableObjectStub,
  running: boolean,
): Promise<void> {
  await container.fetch("http://encoder/__carpo/job-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ running }),
  });
}

async function markContainerJobRunningSafe(
  container: DurableObjectStub,
  running: boolean,
): Promise<void> {
  try {
    await markContainerJobRunning(container, running);
  } catch (error) {
    console.error(
      `Failed to mark container job running=${running}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function startActivityRenewal(
  container: DurableObjectStub,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void container.fetch("http://encoder/__carpo/renew-activity", {
      method: "POST",
    });
  }, ACTIVITY_RENEWAL_MS);
}

async function cleanupUploadSource(env: Env, clipId: string): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return;
  }
  await deleteUploadSource(env.CLIPS_BUCKET, record);
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

    const container = env.ENCODER_CONTAINER.getByName(`gif-${clipId}`);
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
    await markContainerJobRunningSafe(container, true);
    const keepAlive = startActivityRenewal(container);

    try {
      const jobSpec: GifEncoderJobSpec = {
        jobId: clipId,
        jobType: "gif",
        sourceMp4Key: record.output_mp4_key,
        source: { type: "file", path: "/tmp/carpo-upload-source.mp4" },
        outputs: { gifKey },
      };

      const response = await container.fetch("http://encoder/run", {
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
    } finally {
      clearInterval(keepAlive);
      await markContainerJobRunningSafe(container, false);
    }
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
