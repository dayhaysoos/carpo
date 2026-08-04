import { z } from "zod";
import { getSourceVideoById, listClipsByVideoId } from "./db";
import type { Env } from "./env";
import {
  buildTranscriptClipRange,
  requestVideoTranscript,
  type TranscriptBlock,
} from "./transcript-search";

const SEMANTIC_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_BATCH_CHARACTERS = 12_000;
const MAX_CONCURRENT_BATCHES = 3;
const BATCH_OVERLAP_BLOCKS = 2;

const modelCandidateSchema = z.object({
  blockIds: z.array(z.string()).min(1).max(12),
  title: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(300),
  score: z.number().min(0).max(1),
});

const modelResultEnvelopeSchema = z.object({
  matches: z.array(z.unknown()).max(20),
});

export interface SemanticTranscriptInput {
  intent: string;
  count: number;
  beforeSeconds: number;
  afterSeconds: number;
}

export interface SemanticTranscriptMatch {
  startSeconds: number;
  endSeconds: number;
  spokenStartSeconds: number;
  spokenEndSeconds: number;
  quote: string;
  title: string;
  reason: string;
  blockIds: string[];
}

export interface SemanticTranscriptResult {
  transcriptStatus: "available";
  intent: string;
  matches: SemanticTranscriptMatch[];
  requestedCount: number;
  totalMatches: number;
}

export interface SemanticTranscriptPreparationResult {
  transcriptStatus: "checking";
  intent: string;
  requestedCount: number;
  retryAfterMs: number;
}

interface ModelCandidate {
  blockIds: string[];
  title: string;
  reason: string;
  score: number;
}

function makeBatches(blocks: TranscriptBlock[]): TranscriptBlock[][] {
  const batches: TranscriptBlock[][] = [];
  let nextIndex = 0;
  while (nextIndex < blocks.length) {
    const overlap = batches.at(-1)?.slice(-BATCH_OVERLAP_BLOCKS) ?? [];
    const batch = [...overlap];
    let serializedLength = batch.reduce(
      (length, block) => length + JSON.stringify(block).length,
      0,
    );
    let added = 0;
    while (nextIndex < blocks.length) {
      const block = blocks[nextIndex];
      const blockLength = JSON.stringify(block).length;
      if (
        added > 0 &&
        serializedLength + blockLength > MAX_BATCH_CHARACTERS
      ) {
        break;
      }
      batch.push(block);
      serializedLength += blockLength;
      nextIndex += 1;
      added += 1;
    }
    batches.push(batch);
  }
  return batches;
}

function parseModelResponse(response: string | undefined): ModelCandidate[] {
  if (!response) return [];
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  try {
    const parsed = modelResultEnvelopeSchema.safeParse(
      JSON.parse(response.slice(start, end + 1)),
    );
    if (!parsed.success) return [];
    return parsed.data.matches.flatMap((candidate) => {
      const result = modelCandidateSchema.safeParse(candidate);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

async function rankBatch(
  env: Env,
  blocks: TranscriptBlock[],
  intent: string,
  count: number,
): Promise<ModelCandidate[]> {
  const result = await env.AI.run(SEMANTIC_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Find transcript passages that directly satisfy the user's clipping intent. Return only real block IDs from the supplied transcript. Prefer self-contained passages with clear spoken evidence. Do not invent IDs or timestamps.",
      },
      {
        role: "user",
        content: JSON.stringify({
          intent,
          maximumMatches: Math.min(count * 2, 10),
          transcriptBlocks: blocks,
        }),
      },
    ],
    temperature: 0,
    max_tokens: 1800,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          matches: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                blockIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 12,
                  items: { type: "string" },
                },
                title: { type: "string", minLength: 1, maxLength: 120 },
                reason: { type: "string", minLength: 1, maxLength: 300 },
                score: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["blockIds", "title", "reason", "score"],
              additionalProperties: false,
            },
          },
        },
        required: ["matches"],
        additionalProperties: false,
      },
    },
  });
  const response =
    typeof result === "string"
      ? result
      : "response" in result && typeof result.response === "string"
        ? result.response
        : undefined;
  return parseModelResponse(response);
}

async function rankBatches(
  env: Env,
  batches: TranscriptBlock[][],
  intent: string,
  count: number,
): Promise<ModelCandidate[]> {
  const results = new Array<ModelCandidate[]>(batches.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) },
    async () => {
      while (nextIndex < batches.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await rankBatch(env, batches[index], intent, count);
      }
    },
  );
  await Promise.all(workers);
  return results.flat();
}

function rangesOverlap(
  left: { startSeconds: number; endSeconds: number },
  right: { startSeconds: number; endSeconds: number },
): boolean {
  return left.startSeconds < right.endSeconds &&
    left.endSeconds > right.startSeconds;
}

export async function findSemanticTranscriptMoments(
  env: Env,
  videoId: string,
  input: SemanticTranscriptInput,
): Promise<
  SemanticTranscriptResult | SemanticTranscriptPreparationResult
> {
  const [video, transcript, clips] = await Promise.all([
    getSourceVideoById(env.DB, videoId),
    requestVideoTranscript(env, videoId),
    listClipsByVideoId(env.DB, videoId),
  ]);
  if (!video) throw new Error("Video not found");
  if (transcript.transcriptStatus === "checking") {
    return {
      transcriptStatus: "checking",
      intent: input.intent,
      requestedCount: input.count,
      retryAfterMs: transcript.retryAfterMs,
    };
  }

  const candidates = await rankBatches(
    env,
    makeBatches(transcript.blocks),
    input.intent,
    input.count,
  );
  const blockIndex = new Map(
    transcript.blocks.map((block, index) => [block.id, { block, index }]),
  );
  const occupied = clips
    .filter((clip) => clip.status !== "failed")
    .map((clip) => ({
      startSeconds: clip.trim_start,
      endSeconds: clip.trim_end,
    }));
  const seen = new Set<string>();
  const grounded = candidates.flatMap<
    SemanticTranscriptMatch & { score: number }
  >((candidate) => {
    const referenced = candidate.blockIds.map((id) => blockIndex.get(id));
    if (referenced.some((item) => !item)) return [];
    const groundedBlocks = referenced.filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
    const indexes = groundedBlocks.map((item) => item.index);
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some(
        (index, position) =>
          position > 0 && index !== indexes[position - 1] + 1,
      )
    ) {
      return [];
    }
    const first = groundedBlocks[0].block;
    const last = groundedBlocks.at(-1)!.block;
    const range = buildTranscriptClipRange({
      spokenStartSeconds: first.startSeconds,
      spokenEndSeconds: last.endSeconds,
      beforeSeconds: input.beforeSeconds,
      afterSeconds: input.afterSeconds,
      durationSeconds: video.duration_seconds,
    });
    if (!range) return [];
    if (
      occupied.some((existing) => rangesOverlap(range, existing))
    ) {
      return [];
    }
    const rangeKey = `${range.startSeconds}:${range.endSeconds}`;
    if (seen.has(rangeKey)) return [];
    seen.add(rangeKey);

    const firstIndex = groundedBlocks[0].index;
    const lastIndex = groundedBlocks.at(-1)!.index;
    const includedBlocks = transcript.blocks.slice(firstIndex, lastIndex + 1);
    return [
      {
        ...range,
        spokenStartSeconds: first.startSeconds,
        spokenEndSeconds: last.endSeconds,
        quote: includedBlocks.map((block) => block.text).join(" "),
        title: candidate.title,
        reason: candidate.reason,
        blockIds: includedBlocks.map((block) => block.id),
        score: candidate.score,
      },
    ];
  });

  const totalMatches = grounded.length;
  const matches = grounded
    .sort((left, right) => right.score - left.score)
    .slice(0, input.count)
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .map(({ score: _score, ...match }) => match);
  return {
    transcriptStatus: "available",
    intent: input.intent,
    matches,
    requestedCount: input.count,
    totalMatches,
  };
}
