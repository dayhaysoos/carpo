import {
  fetchYoutubeTranscript,
  transcribeSourceVideo,
  type TranscriptCue,
  type YoutubeTranscript,
} from "./encoder-pool";
import {
  getSourceVideoById,
  updateSourceVideoTranscriptContext,
} from "./db";
import type { Env } from "./env";
import { transcriptObjectKey } from "./source-videos";
import {
  MAX_CLIP_LENGTH_SECONDS,
  type TranscriptStatus,
} from "./types";
import { nextTranscriptRetryAt } from "./video-context";

const TRANSCRIPT_FORMAT_VERSION = 1;
const MAX_PHRASE_GAP_SECONDS = 2;
export const MAX_TRANSCRIPT_SEARCH_RESULTS = 50;
export const MAX_TRANSCRIPT_QUERY_LENGTH = 200;
export const MAX_TRANSCRIPT_PADDING_SECONDS = 10;

interface StoredTranscript extends YoutubeTranscript {
  version: typeof TRANSCRIPT_FORMAT_VERSION;
  fetchedAt: string;
}

export interface TranscriptSearchMatch {
  startSeconds: number;
  endSeconds: number;
  spokenStartSeconds: number;
  spokenEndSeconds: number;
  text: string;
}

export interface TranscriptSearchResult {
  transcriptStatus: TranscriptSearchStatus;
  query: string;
  language: string | null;
  automatic: boolean | null;
  cached: boolean;
  matches: TranscriptSearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

type TranscriptSearchStatus = Extract<
  TranscriptStatus,
  "available" | "unavailable" | "unsupported"
>;

export interface TranscriptSearchInput {
  query: string;
  beforeSeconds?: number;
  afterSeconds?: number;
  limit?: number;
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

async function readCachedTranscript(
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

async function loadYoutubeTranscript(
  env: Env,
  videoId: string,
  sourceUrl: string,
): Promise<{ transcript: StoredTranscript; cached: boolean }> {
  const cached = await readCachedTranscript(env, videoId);
  if (cached) {
    return { transcript: cached, cached: true };
  }

  await updateSourceVideoTranscriptContext(env.DB, videoId, {
    status: "checking",
  });

  let fetched: YoutubeTranscript;
  try {
    fetched = await fetchYoutubeTranscript(env, sourceUrl);
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
    await env.CLIPS_BUCKET.put(
      objectKey,
      JSON.stringify(transcript),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
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

function normalizedTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

function emptyTranscriptSearchResult(
  transcriptStatus: Exclude<TranscriptSearchStatus, "available">,
  query: string,
): TranscriptSearchResult {
  return {
    transcriptStatus,
    query,
    language: null,
    automatic: null,
    cached: false,
    matches: [],
    totalMatches: 0,
    truncated: false,
  };
}

function mergeTranscriptMatchRanges(
  matches: TranscriptSearchMatch[],
): TranscriptSearchMatch[] {
  return matches.reduce<TranscriptSearchMatch[]>((merged, match) => {
    const previous = merged.at(-1);
    const mergedEnd = previous
      ? Math.max(previous.endSeconds, match.endSeconds)
      : match.endSeconds;
    if (
      previous &&
      match.startSeconds <= previous.endSeconds &&
      mergedEnd - previous.startSeconds <= MAX_CLIP_LENGTH_SECONDS
    ) {
      previous.endSeconds = mergedEnd;
      previous.spokenEndSeconds = Math.max(
        previous.spokenEndSeconds,
        match.spokenEndSeconds,
      );
      previous.text = `${previous.text} ${match.text}`;
    } else {
      merged.push({ ...match });
    }
    return merged;
  }, []);
}

function findTranscriptMatches(
  transcript: StoredTranscript,
  query: string,
  options: {
    beforeSeconds: number;
    afterSeconds: number;
    durationSeconds: number | null;
  },
): TranscriptSearchMatch[] {
  const queryTokens = normalizedTokens(query);
  if (queryTokens.length === 0) return [];

  const tokens: Array<{ value: string; cueIndex: number }> = [];
  transcript.cues.forEach((cue, cueIndex) => {
    normalizedTokens(cue.text).forEach((value) => {
      tokens.push({ value, cueIndex });
    });
  });

  const matches: TranscriptSearchMatch[] = [];
  const seen = new Set<string>();
  for (
    let index = 0;
    index <= tokens.length - queryTokens.length;
    index += 1
  ) {
    const matched = queryTokens.every((value, offset) => {
      const current = tokens[index + offset];
      if (current?.value !== value) return false;
      if (offset === 0) return true;
      const previous = tokens[index + offset - 1];
      if (previous.cueIndex === current.cueIndex) return true;
      return (
        transcript.cues[current.cueIndex].startSeconds -
          transcript.cues[previous.cueIndex].endSeconds <=
        MAX_PHRASE_GAP_SECONDS
      );
    });
    if (!matched) continue;

    const firstCueIndex = tokens[index].cueIndex;
    const lastCueIndex = tokens[index + queryTokens.length - 1].cueIndex;
    const firstCue = transcript.cues[firstCueIndex];
    const lastCue = transcript.cues[lastCueIndex];
    if (
      lastCue.endSeconds - firstCue.startSeconds >
      MAX_CLIP_LENGTH_SECONDS
    ) {
      continue;
    }
    const dedupeKey = `${firstCue.startSeconds}:${lastCue.endSeconds}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const paddedEnd = lastCue.endSeconds + options.afterSeconds;
    let startSeconds = Math.max(
      0,
      firstCue.startSeconds - options.beforeSeconds,
    );
    let endSeconds =
      options.durationSeconds === null
        ? paddedEnd
        : Math.min(options.durationSeconds, paddedEnd);
    if (endSeconds - startSeconds > MAX_CLIP_LENGTH_SECONDS) {
      endSeconds = startSeconds + MAX_CLIP_LENGTH_SECONDS;
      if (endSeconds < lastCue.endSeconds) {
        endSeconds = lastCue.endSeconds;
        startSeconds = Math.max(
          0,
          endSeconds - MAX_CLIP_LENGTH_SECONDS,
        );
      }
    }
    matches.push({
      startSeconds,
      endSeconds,
      spokenStartSeconds: firstCue.startSeconds,
      spokenEndSeconds: lastCue.endSeconds,
      text: transcript.cues
        .slice(firstCueIndex, lastCueIndex + 1)
        .map((cue) => cue.text)
        .join(" "),
    });
  }
  return mergeTranscriptMatchRanges(matches);
}

export async function searchVideoTranscript(
  env: Env,
  videoId: string,
  input: TranscriptSearchInput,
): Promise<TranscriptSearchResult> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const query = input.query.trim();
  const beforeSeconds = input.beforeSeconds ?? 1;
  const afterSeconds = input.afterSeconds ?? 2;
  const limit = input.limit ?? 20;

  if (video.source_type !== "youtube") {
    return emptyTranscriptSearchResult("unsupported", query);
  }

  const loaded = await loadYoutubeTranscript(
    env,
    videoId,
    video.source_ref,
  );

  const matches = findTranscriptMatches(loaded.transcript, query, {
    beforeSeconds,
    afterSeconds,
    durationSeconds: video.duration_seconds,
  });
  return {
    transcriptStatus: "available",
    query,
    language: loaded.transcript.language,
    automatic: loaded.transcript.automatic,
    cached: loaded.cached,
    matches: matches.slice(0, limit),
    totalMatches: matches.length,
    truncated: matches.length > limit,
  };
}
