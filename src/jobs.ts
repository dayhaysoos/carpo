import {
  deleteClipArtifacts,
  getClipById,
  insertClip,
  markClipComplete,
  markClipFailed,
  outputKeysForClip,
  updateClipStatus,
} from "./db";
import type { Env } from "./env";
import type { ClipStatus, CreateClipRequest, EncoderJobSpec } from "./types";

const ACTIVITY_RENEWAL_MS = 30_000;
const TERMINAL_STATUSES = new Set<ClipStatus>(["complete", "failed"]);

function isTerminalStatus(status: ClipStatus): boolean {
  return TERMINAL_STATUSES.has(status);
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
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    throw new Error(`Clip ${clipId} not found for encoding dispatch`);
  }

  const container = env.ENCODER_CONTAINER.getByName(clipId);
  const outputKeys = outputKeysForClip(clipId);
  const workerBaseUrl = workerOrigin || env.WORKER_BASE_URL || "http://localhost:8787";
  const callbackUrl = `${workerBaseUrl}/api/internal/jobs/${clipId}/status`;

  const jobSpec: EncoderJobSpec = {
    jobId: clipId,
    source: request.source,
    trimStart: request.trimStart,
    trimEnd: request.trimEnd,
    caption: request.caption ?? null,
    filters: request.filters ?? [],
    maxClipLengthSeconds: Number(env.MAX_CLIP_LENGTH_SECONDS) || 60,
    outputs: outputKeys,
    callbackUrl,
    callbackSecret: record.callback_secret,
    artifactUploadUrls: {
      mp4: `${workerBaseUrl}/api/internal/jobs/${clipId}/artifacts/mp4`,
      thumbnail: `${workerBaseUrl}/api/internal/jobs/${clipId}/artifacts/thumbnail`,
    },
  };

  try {
    await container.fetch("http://encoder/__carpo/start", { method: "POST" });
    await markContainerJobRunning(container, true);
    const keepAlive = startActivityRenewal(container);

    try {
      const response = await container.fetch("http://encoder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobSpec),
      });

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

      // Authoritative completion: trust the successful /run body over callbacks.
      const mp4Key = result.outputs?.mp4Key ?? outputKeys.mp4Key;
      const thumbnailKey =
        result.outputs?.thumbnailKey ?? outputKeys.thumbnailKey;
      await markClipComplete(env.DB, clipId, mp4Key, thumbnailKey);
    } finally {
      clearInterval(keepAlive);
      await markContainerJobRunning(container, false);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown encoding error";
    // Transport/parse failures after a long /run are ambiguous; keep artifacts.
    await failClipAmbiguous(env, clipId, message);
  }
}

export async function failClip(
  env: Env,
  clipId: string,
  errorMessage: string,
): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  if (!record || isTerminalStatus(record.status)) {
    return;
  }

  await deleteClipArtifacts(env.CLIPS_BUCKET, clipId);
  await markClipFailed(env.DB, clipId, errorMessage);
}

async function failClipAmbiguous(
  env: Env,
  clipId: string,
  errorMessage: string,
): Promise<void> {
  const record = await getClipById(env.DB, clipId);
  if (!record || isTerminalStatus(record.status)) {
    return;
  }

  // /run outcome unknown (transport error or unreadable body). Do not delete
  // artifacts that may have been uploaded before the worker lost contact.
  await markClipFailed(env.DB, clipId, errorMessage);
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
  if (!record || isTerminalStatus(record.status)) {
    return;
  }

  if (status === "complete") {
    const keys = outputKeysForClip(clipId);
    await markClipComplete(env.DB, clipId, keys.mp4Key, keys.thumbnailKey);
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

function startActivityRenewal(
  container: DurableObjectStub,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void container.fetch("http://encoder/__carpo/renew-activity", {
      method: "POST",
    });
  }, ACTIVITY_RENEWAL_MS);
}
