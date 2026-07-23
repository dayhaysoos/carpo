import {
  getSourceVideoById,
  updateSourceVideoTranscriptContext,
} from "./db";
import { inspectYoutubeVideo } from "./encoder-pool";
import type { Env } from "./env";
import type { SourceVideoRecord } from "./types";

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
      "unsupported",
    );
    return getSourceVideoById(env.DB, videoId);
  }

  await updateSourceVideoTranscriptContext(env.DB, videoId, "checking");
  try {
    const metadata = await inspectYoutubeVideo(env, video.source_ref);
    await updateSourceVideoTranscriptContext(
      env.DB,
      videoId,
      metadata.transcriptAvailable ? "available" : "unavailable",
      metadata.durationSeconds,
    );
  } catch (error) {
    await updateSourceVideoTranscriptContext(env.DB, videoId, "failed");
    throw error;
  }

  return getSourceVideoById(env.DB, videoId);
}
