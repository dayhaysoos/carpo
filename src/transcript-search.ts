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
  type SourceVideoRecord,
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
  transcriptStatus: "available";
  query: string;
  language: string | null;
  automatic: boolean | null;
  cached: boolean;
  matches: TranscriptSearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface TranscriptBlock {
  id: string;
  startCueId: string;
  endCueId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptDocumentResult {
  transcriptStatus: "available";
  language: string;
  automatic: boolean;
  cached: boolean;
  blocks: TranscriptBlock[];
}

export interface TranscriptClipRange {
  startSeconds: number;
  endSeconds: number;
}

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

async function loadVideoTranscript(
  env: Env,
  video: SourceVideoRecord,
): Promise<{ transcript: StoredTranscript; cached: boolean }> {
  const videoId = video.id;
  const cached = await readCachedTranscript(env, videoId);
  if (cached) {
    return { transcript: cached, cached: true };
  }

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

export function buildTranscriptClipRange(input: {
  spokenStartSeconds: number;
  spokenEndSeconds: number;
  beforeSeconds: number;
  afterSeconds: number;
  durationSeconds: number | null;
}): TranscriptClipRange | null {
  if (
    input.spokenEndSeconds <= input.spokenStartSeconds ||
    input.spokenEndSeconds - input.spokenStartSeconds >
      MAX_CLIP_LENGTH_SECONDS ||
    (input.durationSeconds !== null &&
      (input.spokenStartSeconds >= input.durationSeconds ||
        input.spokenEndSeconds > input.durationSeconds))
  ) {
    return null;
  }

  let startSeconds = Math.max(
    0,
    input.spokenStartSeconds - input.beforeSeconds,
  );
  const paddedEnd = input.spokenEndSeconds + input.afterSeconds;
  let endSeconds =
    input.durationSeconds === null
      ? paddedEnd
      : Math.min(input.durationSeconds, paddedEnd);

  if (endSeconds - startSeconds > MAX_CLIP_LENGTH_SECONDS) {
    endSeconds = Math.min(
      input.durationSeconds ?? Number.POSITIVE_INFINITY,
      startSeconds + MAX_CLIP_LENGTH_SECONDS,
    );
    if (endSeconds < input.spokenEndSeconds) {
      endSeconds = input.spokenEndSeconds;
      startSeconds = Math.max(0, endSeconds - MAX_CLIP_LENGTH_SECONDS);
    }
  }

  if (
    endSeconds <= startSeconds ||
    endSeconds - startSeconds > MAX_CLIP_LENGTH_SECONDS
  ) {
    return null;
  }
  return { startSeconds, endSeconds };
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
    const dedupeKey = `${firstCue.startSeconds}:${lastCue.endSeconds}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const range = buildTranscriptClipRange({
      spokenStartSeconds: firstCue.startSeconds,
      spokenEndSeconds: lastCue.endSeconds,
      beforeSeconds: options.beforeSeconds,
      afterSeconds: options.afterSeconds,
      durationSeconds: options.durationSeconds,
    });
    if (!range) continue;
    matches.push({
      ...range,
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

function transcriptBlocks(transcript: StoredTranscript): TranscriptBlock[] {
  const groups: Array<{
    startIndex: number;
    endIndex: number;
    startSeconds: number;
    endSeconds: number;
    texts: string[];
  }> = [];

  transcript.cues.forEach((cue, index) => {
    const current = groups.at(-1);
    const canAppend =
      current &&
      cue.startSeconds - current.endSeconds <= MAX_PHRASE_GAP_SECONDS &&
      cue.endSeconds - current.startSeconds <= 12 &&
      current.texts.join(" ").length + cue.text.length + 1 <= 240;
    if (canAppend) {
      current.endIndex = index;
      current.endSeconds = cue.endSeconds;
      current.texts.push(cue.text);
      return;
    }
    groups.push({
      startIndex: index,
      endIndex: index,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      texts: [cue.text],
    });
  });

  return groups.map((group) => ({
    id: `cue-${group.startIndex}-${group.endIndex}`,
    startCueId: `cue-${group.startIndex}`,
    endCueId: `cue-${group.endIndex}`,
    startSeconds: group.startSeconds,
    endSeconds: group.endSeconds,
    text: group.texts.join(" "),
  }));
}

export async function getVideoTranscript(
  env: Env,
  videoId: string,
): Promise<TranscriptDocumentResult> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const loaded = await loadVideoTranscript(env, video);
  return {
    transcriptStatus: "available",
    language: loaded.transcript.language,
    automatic: loaded.transcript.automatic,
    cached: loaded.cached,
    blocks: transcriptBlocks(loaded.transcript),
  };
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

  const loaded = await loadVideoTranscript(env, video);

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
