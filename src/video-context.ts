import {
  getSourceVideoById,
  updateSourceVideoTranscriptContext,
} from "./db";
import { inspectYoutubeVideo } from "./encoder-pool";
import type { Env } from "./env";
import type { SourceVideoRecord } from "./types";

const TRANSCRIPT_CHECK_ATTEMPTS = 3;
const TRANSCRIPT_RETRY_DELAYS_MS = [250, 750];
const TRANSCRIPT_RECHECK_COOLDOWN_MS = 15 * 60 * 1000;
const PERMANENT_TRANSCRIPT_ERROR_MARKERS = [
  "private",
  "members-only",
  "video is unavailable",
  "not available in your region",
  "not a supported youtube link",
  "valid youtube url",
  "youtube url is required",
];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableTranscriptError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return !PERMANENT_TRANSCRIPT_ERROR_MARKERS.some((marker) =>
    message.includes(marker),
  );
}

export function nextTranscriptRetryAt(now = Date.now()): string {
  return new Date(now + TRANSCRIPT_RECHECK_COOLDOWN_MS).toISOString();
}

async function inspectYoutubeVideoWithRetry(
  env: Env,
  url: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSCRIPT_CHECK_ATTEMPTS; attempt += 1) {
    try {
      return await inspectYoutubeVideo(env, url);
    } catch (error) {
      lastError = error;
      if (!isRetryableTranscriptError(error)) break;
      const retryDelay = TRANSCRIPT_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await wait(retryDelay);
    }
  }
  throw lastError;
}

export async function checkSourceVideoTranscript(
  env: Env,
  videoId: string,
): Promise<SourceVideoRecord | null> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) return null;

  if (video.source_type !== "youtube") {
    await updateSourceVideoTranscriptContext(
      env.DB,
      videoId,
      { status: "unsupported" },
    );
    return getSourceVideoById(env.DB, videoId);
  }

  try {
    const metadata = await inspectYoutubeVideoWithRetry(
      env,
      video.source_ref,
    );
    await updateSourceVideoTranscriptContext(
      env.DB,
      videoId,
      {
        status: metadata.transcriptAvailable ? "available" : "unavailable",
        durationSeconds: metadata.durationSeconds,
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Transcript availability check failed";
    await updateSourceVideoTranscriptContext(env.DB, videoId, {
      status: "failed",
      error: message,
      retryAt: isRetryableTranscriptError(error)
        ? nextTranscriptRetryAt()
        : null,
    });
    throw error;
  }

  return getSourceVideoById(env.DB, videoId);
}
