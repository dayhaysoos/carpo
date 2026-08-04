import {
  fetchYoutubeTranscript,
  transcribeSourceVideo,
  type TranscriptCue,
  type YoutubeTranscript,
} from "./encoder-pool";
import { updateSourceVideoTranscriptContext } from "./db";
import type { Env } from "./env";
import { transcriptObjectKey } from "./source-videos";
import type { SourceVideoRecord } from "./types";
import { nextTranscriptRetryAt } from "./video-context";

const TRANSCRIPT_FORMAT_VERSION = 1;

export interface StoredTranscript extends YoutubeTranscript {
  version: typeof TRANSCRIPT_FORMAT_VERSION;
  fetchedAt: string;
}

function isTranscriptCue(value: unknown): value is TranscriptCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Partial<TranscriptCue>;
  return (
    typeof cue.startSeconds === "number" &&
    Number.isFinite(cue.startSeconds) &&
    cue.startSeconds >= 0 &&
    typeof cue.endSeconds === "number" &&
    Number.isFinite(cue.endSeconds) &&
    cue.endSeconds > cue.startSeconds &&
    typeof cue.text === "string" &&
    cue.text.trim().length > 0
  );
}

function parseStoredTranscript(value: unknown): StoredTranscript | null {
  if (!value || typeof value !== "object") return null;
  const transcript = value as Partial<StoredTranscript>;
  if (
    transcript.version !== TRANSCRIPT_FORMAT_VERSION ||
    typeof transcript.fetchedAt !== "string" ||
    typeof transcript.language !== "string" ||
    typeof transcript.automatic !== "boolean" ||
    !Array.isArray(transcript.cues) ||
    !transcript.cues.every(isTranscriptCue)
  ) {
    return null;
  }
  return transcript as StoredTranscript;
}

export async function readCachedTranscript(
  env: Env,
  videoId: string,
): Promise<StoredTranscript | null> {
  const object = await env.CLIPS_BUCKET.get(transcriptObjectKey(videoId));
  if (!object) return null;
  try {
    return parseStoredTranscript(JSON.parse(await object.text()));
  } catch {
    return null;
  }
}

export async function prepareVideoTranscript(
  env: Env,
  video: SourceVideoRecord,
): Promise<{ transcript: StoredTranscript; cached: boolean }> {
  const videoId = video.id;
  const cached = await readCachedTranscript(env, videoId);
  if (cached) return { transcript: cached, cached: true };

  await updateSourceVideoTranscriptContext(env.DB, videoId, {
    status: "checking",
  });

  let fetched: YoutubeTranscript;
  if (video.source_type === "youtube") {
    try {
      fetched = await fetchYoutubeTranscript(env, video.source_ref);
    } catch (captionError) {
      try {
        fetched = await transcribeSourceVideo(env, videoId);
      } catch (transcriptionError) {
        const captionMessage =
          captionError instanceof Error
            ? captionError.message
            : "YouTube caption fetch failed";
        const transcriptionMessage =
          transcriptionError instanceof Error
            ? transcriptionError.message
            : "Retained-source transcription failed";
        const message =
          `Caption retrieval failed (${captionMessage}); ` +
          `retained-source transcription failed (${transcriptionMessage})`;
        await updateSourceVideoTranscriptContext(env.DB, videoId, {
          status: "failed",
          error: message,
          retryAt: nextTranscriptRetryAt(),
        });
        throw new Error(message);
      }
    }
  } else {
    try {
      fetched = await transcribeSourceVideo(env, videoId);
    } catch (transcriptionError) {
      const message =
        transcriptionError instanceof Error
          ? transcriptionError.message
          : "Uploaded-source transcription failed";
      await updateSourceVideoTranscriptContext(env.DB, videoId, {
        status: "failed",
        error: message,
        retryAt: nextTranscriptRetryAt(),
      });
      throw new Error(message);
    }
  }

  try {
    if (
      typeof fetched.language !== "string" ||
      typeof fetched.automatic !== "boolean" ||
      !Array.isArray(fetched.cues) ||
      !fetched.cues.every(isTranscriptCue)
    ) {
      throw new Error("Transcript fetch returned invalid data");
    }
    const transcript: StoredTranscript = {
      version: TRANSCRIPT_FORMAT_VERSION,
      fetchedAt: new Date().toISOString(),
      language: fetched.language,
      automatic: fetched.automatic,
      cues: fetched.cues,
    };
    const objectKey = transcriptObjectKey(videoId);
    await env.CLIPS_BUCKET.put(objectKey, JSON.stringify(transcript), {
      httpMetadata: { contentType: "application/json" },
    });
    const updated = await updateSourceVideoTranscriptContext(env.DB, videoId, {
      status: "available",
    });
    if (!updated) {
      await env.CLIPS_BUCKET.delete(objectKey);
      throw new Error("Video not found");
    }
    return { transcript, cached: false };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcript fetch failed";
    await updateSourceVideoTranscriptContext(env.DB, videoId, {
      status: "failed",
      error: message,
      retryAt: nextTranscriptRetryAt(),
    });
    throw error;
  }
}
