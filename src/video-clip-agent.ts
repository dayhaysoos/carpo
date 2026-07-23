import { Think } from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import { getSourceVideoById } from "./db";
import type { Env } from "./env";
import { MAX_CAPTION_LENGTH, MAX_CLIP_LENGTH_SECONDS } from "./types";

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
      "Use 1080p unless the user asks for 720p. Add a caption only when requested. If no title is supplied, make a concise title from the video title and timestamp range.",
      "If either timestamp is missing or ambiguous, ask one short clarifying question. Never invent a missing timestamp.",
      "After createClip succeeds, say that the clip was queued. If the user rejects it, acknowledge that nothing was created.",
      "Write responses as short plain text. Do not use Markdown formatting.",
    ].join("\n\n");
  }

  override beforeTurn() {
    return {
      activeTools: ["getVideoContext", "createClip"],
      temperature: 0,
      maxSteps: 4,
    };
  }

  override getTools() {
    return {
      getVideoContext: tool({
        description:
          "Get the title of the video in this conversation.",
        inputSchema: z.object({}),
        execute: async () => {
          const video = await getSourceVideoById(this.env.DB, this.name);
          if (!video) {
            return { error: "Video not found" };
          }
          return {
            title: video.title,
          };
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
