import {
  Think,
  type PrepareStepContext,
  type TurnContext,
} from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import {
  claimSourceVideoTranscriptRetry,
  getSourceVideoById,
  listClipsByVideoId,
  updateSourceVideoDuration,
} from "./db";
import { inspectStoredVideo } from "./encoder-pool";
import type { Env } from "./env";
import {
  MAX_CAPTION_LENGTH,
  MAX_CLIP_LENGTH_SECONDS,
  type TranscriptStatus,
} from "./types";
import {
  checkSourceVideoTranscript,
  nextTranscriptRetryAt,
} from "./video-context";
import {
  MAX_TRANSCRIPT_PADDING_SECONDS,
  MAX_TRANSCRIPT_QUERY_LENGTH,
  MAX_TRANSCRIPT_SEARCH_RESULTS,
  searchVideoTranscript,
} from "./transcript-search";

const MAX_AGENT_OCCUPIED_RANGES = 200;

interface AgentVideoContext {
  title: string;
  durationSeconds: number | null;
  sourceType: "youtube" | "upload";
  retainedSourceReady: boolean;
  transcriptStatus: TranscriptStatus;
  transcriptCheckedAt: string | null;
  transcriptCheckError: string | null;
  transcriptRetryAt: string | null;
  metadataCheckError: string | null;
  constraints: {
    maximumClipLengthSeconds: number;
    qualities: string[];
  };
  existingClips: Array<{ startSeconds: number; endSeconds: number }>;
  existingClipRangeCount: number;
  existingClipRangesTruncated: boolean;
}

function occupiedRangeContext(
  clips: Array<{
    status: string;
    trim_start: number;
    trim_end: number;
  }>,
) {
  const occupiedRanges = clips
    .filter((clip) => clip.status !== "failed")
    .map((clip) => ({
      startSeconds: clip.trim_start,
      endSeconds: clip.trim_end,
    }))
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .reduce<Array<{ startSeconds: number; endSeconds: number }>>(
      (merged, range) => {
        const previous = merged.at(-1);
        if (previous && range.startSeconds <= previous.endSeconds) {
          previous.endSeconds = Math.max(
            previous.endSeconds,
            range.endSeconds,
          );
        } else {
          merged.push({ ...range });
        }
        return merged;
      },
      [],
    );

  return {
    existingClips: occupiedRanges.slice(0, MAX_AGENT_OCCUPIED_RANGES),
    existingClipRangeCount: occupiedRanges.length,
    existingClipRangesTruncated:
      occupiedRanges.length > MAX_AGENT_OCCUPIED_RANGES,
  };
}

function transcriptRetryIsDue(video: {
  transcript_status: TranscriptStatus;
  transcript_check_error: string | null;
  transcript_retry_at: string | null;
}): boolean {
  if (video.transcript_status !== "failed") return false;
  if (!video.transcript_retry_at) {
    return video.transcript_check_error === null;
  }
  const retryAt = Date.parse(video.transcript_retry_at);
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

const manualClipInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().positive(),
    caption: z.string().trim().max(MAX_CAPTION_LENGTH).optional(),
    quality: z.enum(["720p", "1080p"]).default("1080p"),
  })
  .superRefine((input, context) => {
    if (input.endSeconds <= input.startSeconds) {
      context.addIssue({
        code: "custom",
        path: ["endSeconds"],
        message: "The end time must be after the start time",
      });
      return;
    }
    if (input.endSeconds - input.startSeconds > MAX_CLIP_LENGTH_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["endSeconds"],
        message: `Clips cannot be longer than ${MAX_CLIP_LENGTH_SECONDS} seconds`,
      });
    }
  });

const transcriptSearchInput = z.object({
  query: z.string().trim().min(1).max(MAX_TRANSCRIPT_QUERY_LENGTH),
  beforeSeconds: z
    .number()
    .finite()
    .min(0)
    .max(MAX_TRANSCRIPT_PADDING_SECONDS)
    .default(1),
  afterSeconds: z
    .number()
    .finite()
    .min(0)
    .max(MAX_TRANSCRIPT_PADDING_SECONDS)
    .default(2),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_TRANSCRIPT_SEARCH_RESULTS)
    .default(20),
});

export async function loadAgentVideoContext(
  env: Env,
  videoId: string,
  options?: {
    schedule?: (promise: Promise<unknown>) => void;
  },
): Promise<AgentVideoContext | { error: string }> {
  const [initialVideo, clips] = await Promise.all([
    getSourceVideoById(env.DB, videoId),
    listClipsByVideoId(env.DB, videoId),
  ]);
  let video = initialVideo;
  if (!video) {
    return { error: "Video not found" };
  }

  let metadataCheckError: string | null = null;
  if (
    video.source_type === "youtube" &&
    video.duration_seconds === null &&
    video.transcript_status !== "failed"
  ) {
    try {
      video = (await checkSourceVideoTranscript(env, videoId)) ?? video;
    } catch (error) {
      metadataCheckError =
        error instanceof Error ? error.message : "Video metadata check failed";
      video = (await getSourceVideoById(env.DB, videoId)) ?? video;
    }
  } else if (
    video.source_type === "youtube" &&
    transcriptRetryIsDue(video)
  ) {
    const claimed = await claimSourceVideoTranscriptRetry(
      env.DB,
      videoId,
      nextTranscriptRetryAt(),
    );
    video = (await getSourceVideoById(env.DB, videoId)) ?? video;
    if (claimed && options?.schedule) {
      const retry = checkSourceVideoTranscript(env, videoId)
        .then(() => undefined)
        .catch(() => undefined);
      options.schedule(retry);
    } else if (claimed) {
      try {
        video = (await checkSourceVideoTranscript(env, videoId)) ?? video;
      } catch (error) {
        metadataCheckError =
          error instanceof Error
            ? error.message
            : "Video metadata check failed";
        video = (await getSourceVideoById(env.DB, videoId)) ?? video;
      }
    }
  } else if (
    video.source_type === "upload" &&
    video.duration_seconds === null
  ) {
    try {
      const metadata = await inspectStoredVideo(env, video.source_ref);
      if (metadata.durationSeconds !== null) {
        await updateSourceVideoDuration(
          env.DB,
          videoId,
          metadata.durationSeconds,
        );
        video = (await getSourceVideoById(env.DB, videoId)) ?? video;
      }
    } catch (error) {
      metadataCheckError =
        error instanceof Error ? error.message : "Video metadata check failed";
    }
  }

  return {
    title: video.title,
    durationSeconds: video.duration_seconds,
    sourceType: video.source_type,
    retainedSourceReady:
      video.source_type === "upload" ||
      video.retained_source_status === "ready",
    transcriptStatus: video.transcript_status,
    transcriptCheckedAt: video.transcript_checked_at,
    transcriptCheckError: video.transcript_check_error,
    transcriptRetryAt: video.transcript_retry_at,
    metadataCheckError,
    constraints: {
      maximumClipLengthSeconds: MAX_CLIP_LENGTH_SECONDS,
      qualities: ["720p", "1080p"],
    },
    ...occupiedRangeContext(clips),
  };
}

export function agentVideoContextSystemBlock(
  context: AgentVideoContext | { error: string },
): string {
  return [
    "CURRENT VIDEO CONTEXT (authoritative server data for this turn):",
    JSON.stringify(context),
    "Use this context directly. When durationSeconds is a number, never ask the user for the video duration.",
    "The getVideoContext tool remains available if you need to refresh this data.",
  ].join("\n");
}

export function forceVideoContextOnFirstStep(
  stepNumber: number,
) {
  if (stepNumber !== 0) return undefined;
  return {
    activeTools: ["getVideoContext"],
    toolChoice: { type: "tool", toolName: "getVideoContext" },
  } as const;
}

export class VideoClipAgent extends Think<Env> {
  workspaceBash = false;

  private loadVideoContext() {
    return loadAgentVideoContext(this.env, this.name, {
      schedule: (promise) => this.ctx.waitUntil(promise),
    });
  }

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You are Carpo's clip assistant. This conversation is scoped to exactly one existing video.",
      "Help with manual timestamp clipping and exact spoken-word or phrase clipping. Do not claim you can understand visual scenes or inspect anything beyond transcript search results.",
      "Convert timestamps such as 1:20, 01:20.500, or 'one minute twenty seconds' into numeric seconds.",
      "When the user gives a start and end time, call createClip with the exact range. The interface will show a preview and let the user adjust the range before anything is created.",
      "The current video context is injected into every turn. Keep every proposed range inside durationSeconds and avoid overlapping existing clips unless the user asks for overlap.",
      "For a random-clips request without a requested length, use 10 seconds per clip. Choose non-overlapping ranges spread across the video and avoid existing clips when possible.",
      "When asked whether a transcript or captions are available, call checkTranscriptAvailability.",
      "When asked to clip every time a word or exact phrase is spoken, always call searchTranscript—even when the current transcript status is failed or unavailable. The tool automatically tries captions, then prepares and transcribes the retained source when needed. It returns pre-merged clip ranges. Use only its exact startSeconds/endSeconds and call createClip once for every returned range so the user can preview and approve the batch. Never guess spoken timestamps or ask the user to retry before calling the tool.",
      "If transcript preparation fails after searchTranscript is called, explain the returned error without claiming the user must create a clip first. If it is unsupported, explain that uploaded-video transcription is not available yet. If an available transcript has no matches, say the phrase was not found. Do not propose clips for any of those empty results.",
      "If transcript search reports truncated results, clearly say that only the returned matches were proposed.",
      "Use 1080p unless the user asks for 720p. Add a caption only when requested. If no title is supplied, make a concise title from the video title and timestamp range.",
      "If either timestamp is missing or ambiguous, ask one short clarifying question. Never invent a missing timestamp.",
      "After createClip succeeds, say that the clip was queued. If the user rejects it, acknowledge that nothing was created.",
      "Write responses as short plain text. Do not use Markdown formatting.",
    ].join("\n\n");
  }

  override async beforeTurn(ctx: TurnContext) {
    const videoContext = await this.loadVideoContext();
    return {
      system: `${ctx.system}\n\n${agentVideoContextSystemBlock(videoContext)}`,
      activeTools: [
        "getVideoContext",
        "checkTranscriptAvailability",
        "searchTranscript",
        "createClip",
      ],
      temperature: 0,
      maxSteps: 6,
    };
  }

  override beforeStep(ctx: PrepareStepContext) {
    return forceVideoContextOnFirstStep(ctx.stepNumber);
  }

  override getTools() {
    return {
      getVideoContext: tool({
        description:
          "Get the selected video's title, duration, source readiness, transcript status, transcript failure and retry details, clipping constraints, and existing clip ranges. Call this before generating random, multiple, or boundary-dependent clips.",
        inputSchema: z.object({}),
        execute: async () => this.loadVideoContext(),
      }),
      checkTranscriptAvailability: tool({
        description:
          "Check whether the selected YouTube video exposes subtitles or automatic captions. This does not fetch or search transcript text.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const video = await checkSourceVideoTranscript(
              this.env,
              this.name,
            );
            if (!video) {
              return { error: "Video not found" };
            }
            return {
              transcriptStatus: video.transcript_status,
              checkedAt: video.transcript_checked_at,
              durationSeconds: video.duration_seconds,
              transcriptCheckError: video.transcript_check_error,
              retryAt: video.transcript_retry_at,
              canSearchTranscript:
                video.transcript_status === "available",
            };
          } catch (error) {
            const video = await getSourceVideoById(this.env.DB, this.name);
            const message =
              error instanceof Error
                ? error.message
                : "Transcript availability check failed";
            return {
              transcriptStatus: video?.transcript_status ?? "failed",
              checkedAt: video?.transcript_checked_at ?? null,
              durationSeconds: video?.duration_seconds ?? null,
              transcriptCheckError:
                video?.transcript_check_error ?? message,
              retryAt: video?.transcript_retry_at ?? null,
              canSearchTranscript: false,
            };
          }
        },
      }),
      searchTranscript: tool({
        description:
          "Prepare and search the selected video's speech for an exact word or phrase. Uses cached captions when possible; otherwise it retains the YouTube source, transcribes it, and caches the result. Call this even when current transcript status is failed or unavailable. Returns deterministic timestamp ranges with padding for clip proposals. Use these exact ranges with createClip.",
        inputSchema: transcriptSearchInput,
        execute: async (input) =>
          searchVideoTranscript(this.env, this.name, input),
      }),
      createClip: tool({
        description:
          "Propose one clip from the current video for the user to preview, adjust, and explicitly approve.",
        inputSchema: manualClipInput,
      }),
    };
  }
}
