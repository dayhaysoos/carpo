import {
  Think,
  type PrepareStepContext,
  type TurnContext,
} from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import {
  getSourceVideoById,
  listClipsByVideoId,
  updateSourceVideoDuration,
} from "./db";
import { inspectStoredVideo } from "./encoder-pool";
import type { Env } from "./env";
import { MAX_CAPTION_LENGTH, MAX_CLIP_LENGTH_SECONDS } from "./types";
import { checkSourceVideoTranscript } from "./video-context";

const MAX_AGENT_OCCUPIED_RANGES = 200;

interface AgentVideoContext {
  title: string;
  durationSeconds: number | null;
  sourceType: "youtube" | "upload";
  retainedSourceReady: boolean;
  transcriptStatus: string;
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

export async function loadAgentVideoContext(
  env: Env,
  videoId: string,
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
  if (video.source_type === "youtube" && video.duration_seconds === null) {
    try {
      video = (await checkSourceVideoTranscript(env, videoId)) ?? video;
    } catch (error) {
      metadataCheckError =
        error instanceof Error ? error.message : "Video metadata check failed";
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

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You are Carpo's clip assistant. This conversation is scoped to exactly one existing video.",
      "Only help with manual timestamp clipping in this version. Do not claim you can transcribe, search speech, understand scenes, or inspect the video's contents.",
      "Convert timestamps such as 1:20, 01:20.500, or 'one minute twenty seconds' into numeric seconds.",
      "When the user gives a start and end time, call createClip with the exact range. The interface will show a preview and let the user adjust the range before anything is created.",
      "The current video context is injected into every turn. Keep every proposed range inside durationSeconds and avoid overlapping existing clips unless the user asks for overlap.",
      "For a random-clips request without a requested length, use 10 seconds per clip. Choose non-overlapping ranges spread across the video and avoid existing clips when possible.",
      "When asked whether a transcript or captions are available, call checkTranscriptAvailability. This only checks availability; it does not let you search or quote the transcript.",
      "Use 1080p unless the user asks for 720p. Add a caption only when requested. If no title is supplied, make a concise title from the video title and timestamp range.",
      "If either timestamp is missing or ambiguous, ask one short clarifying question. Never invent a missing timestamp.",
      "After createClip succeeds, say that the clip was queued. If the user rejects it, acknowledge that nothing was created.",
      "Write responses as short plain text. Do not use Markdown formatting.",
    ].join("\n\n");
  }

  override async beforeTurn(ctx: TurnContext) {
    const videoContext = await loadAgentVideoContext(this.env, this.name);
    return {
      system: `${ctx.system}\n\n${agentVideoContextSystemBlock(videoContext)}`,
      activeTools: [
        "getVideoContext",
        "checkTranscriptAvailability",
        "createClip",
      ],
      temperature: 0,
      maxSteps: 4,
    };
  }

  override beforeStep(ctx: PrepareStepContext) {
    return forceVideoContextOnFirstStep(ctx.stepNumber);
  }

  override getTools() {
    return {
      getVideoContext: tool({
        description:
          "Get the selected video's title, duration, source readiness, transcript status, clipping constraints, and existing clip ranges. Call this before generating random, multiple, or boundary-dependent clips.",
        inputSchema: z.object({}),
        execute: async () => loadAgentVideoContext(this.env, this.name),
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
              canSearchTranscript: false,
            };
          } catch (error) {
            return {
              transcriptStatus: "failed",
              error:
                error instanceof Error
                  ? error.message
                  : "Transcript availability check failed",
              canSearchTranscript: false,
            };
          }
        },
      }),
      createClip: tool({
        description:
          "Propose one clip from the current video for the user to preview, adjust, and explicitly approve.",
        inputSchema: manualClipInput,
      }),
    };
  }
}
