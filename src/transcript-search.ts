import { getSourceVideoById } from "./db";
import type { Env } from "./env";
import type { SourceVideoRecord } from "./types";
import {
  readCachedTranscript,
  type StoredTranscript,
} from "./transcript-store";
import { dispatchTranscriptPreparation } from "./transcript-preparation";

const MAX_PHRASE_GAP_SECONDS = 2;
export const MAX_TRANSCRIPT_SEARCH_RESULTS = 50;
export const MAX_TRANSCRIPT_QUERY_LENGTH = 200;
export const MAX_TRANSCRIPT_PADDING_SECONDS = 10;

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

export interface TranscriptPreparationResult {
  transcriptStatus: "checking";
  retryAfterMs: number;
}

export interface TranscriptSearchPreparationResult
  extends TranscriptPreparationResult {
  query: string;
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
  if (endSeconds <= startSeconds) {
    return null;
  }
  return { startSeconds, endSeconds };
}

function mergeTranscriptMatchRanges(
  matches: TranscriptSearchMatch[],
): TranscriptSearchMatch[] {
  return matches.reduce<TranscriptSearchMatch[]>((merged, match) => {
    const previous = merged.at(-1);
    if (previous && match.startSeconds <= previous.endSeconds) {
      const mergedEnd = Math.max(previous.endSeconds, match.endSeconds);
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

export function findTranscriptMatches(
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

export function buildTranscriptBlocks(transcript: StoredTranscript): TranscriptBlock[] {
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

function transcriptDocument(
  transcript: StoredTranscript,
  cached: boolean,
): TranscriptDocumentResult {
  return {
    transcriptStatus: "available",
    language: transcript.language,
    automatic: transcript.automatic,
    cached,
    blocks: buildTranscriptBlocks(transcript),
  };
}

function transcriptPreparationError(
  video: SourceVideoRecord,
): string | null {
  if (video.transcript_status !== "failed") return null;
  const retryAt = video.transcript_retry_at;
  if (
    retryAt &&
    Number.isFinite(Date.parse(retryAt)) &&
    Date.parse(retryAt) <= Date.now()
  ) {
    return null;
  }
  return video.transcript_check_error ?? "Transcript preparation failed";
}

export async function requestVideoTranscript(
  env: Env,
  videoId: string,
  options: { retryFailed?: boolean } = {},
): Promise<TranscriptDocumentResult | TranscriptPreparationResult> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const cached = await readCachedTranscript(env, videoId);
  if (cached) {
    return transcriptDocument(cached, true);
  }
  const preparationError = transcriptPreparationError(video);
  if (preparationError && !options.retryFailed) throw new Error(preparationError);

  await dispatchTranscriptPreparation(env, videoId);
  return { transcriptStatus: "checking", retryAfterMs: 1_000 };
}

export async function searchVideoTranscript(
  env: Env,
  videoId: string,
  input: TranscriptSearchInput,
): Promise<TranscriptSearchResult | TranscriptSearchPreparationResult> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const query = input.query.trim();
  const beforeSeconds = input.beforeSeconds ?? 1;
  const afterSeconds = input.afterSeconds ?? 2;
  const limit = input.limit ?? 20;

  const cached = await readCachedTranscript(env, videoId);
  if (!cached) {
    const preparationError = transcriptPreparationError(video);
    if (preparationError) throw new Error(preparationError);
    await dispatchTranscriptPreparation(env, videoId);
    return {
      transcriptStatus: "checking",
      retryAfterMs: 1_000,
      query,
    };
  }

  const matches = findTranscriptMatches(cached, query, {
    beforeSeconds,
    afterSeconds,
    durationSeconds: video.duration_seconds,
  });
  return {
    transcriptStatus: "available",
    query,
    language: cached.language,
    automatic: cached.automatic,
    cached: true,
    matches: matches.slice(0, limit),
    totalMatches: matches.length,
    truncated: matches.length > limit,
  };
}
