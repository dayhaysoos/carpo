import { z } from "zod";
import { getSourceVideoById, listClipsByVideoId } from "./db";
import type { Env } from "./env";
import {
  buildTranscriptClipRange,
  getVideoTranscript,
  type TranscriptBlock,
} from "./transcript-search";

const SEMANTIC_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_BATCH_CHARACTERS = 12_000;
const MAX_CONCURRENT_BATCHES = 3;

const modelResultSchema = z.object({
  matches: z
    .array(
      z.object({
        blockIds: z.array(z.string()).min(1).max(12),
        title: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(1).max(300),
        score: z.number().min(0).max(1),
      }),
    )
    .max(20),
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

interface ModelCandidate {
  blockIds: string[];
  title: string;
  reason: string;
  score: number;
}

function makeBatches(blocks: TranscriptBlock[]): TranscriptBlock[][] {
  return blocks.reduce<TranscriptBlock[][]>((batches, block) => {
    const current = batches.at(-1);
    const serializedLength = JSON.stringify(block).length;
    const currentLength = current
      ? current.reduce(
          (length, item) => length + JSON.stringify(item).length,
          0,
        )
      : 0;
    if (current && currentLength + serializedLength <= MAX_BATCH_CHARACTERS) {
      current.push(block);
    } else {
      batches.push([block]);
    }
    return batches;
  }, []);
}

function parseModelResponse(response: string | undefined): ModelCandidate[] {
  if (!response) return [];
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  try {
    const parsed = modelResultSchema.safeParse(
      JSON.parse(response.slice(start, end + 1)),
    );
    return parsed.success ? parsed.data.matches : [];
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
            items: {
              type: "object",
              properties: {
                blockIds: {
                  type: "array",
                  items: { type: "string" },
                },
                title: { type: "string" },
                reason: { type: "string" },
                score: { type: "number" },
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
): Promise<SemanticTranscriptResult> {
  const [video, transcript, clips] = await Promise.all([
    getSourceVideoById(env.DB, videoId),
    getVideoTranscript(env, videoId),
    listClipsByVideoId(env.DB, videoId),
  ]);
  if (!video) throw new Error("Video not found");

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
