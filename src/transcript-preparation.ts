import { DurableObject } from "cloudflare:workers";
import {
  getSourceVideoById,
  updateSourceVideoTranscriptContext,
} from "./db";
import type { Env } from "./env";
import { prepareVideoTranscript } from "./transcript-store";

export class TranscriptPreparation extends DurableObject<Env> {
  private running: Promise<void> | null = null;
  private statusReady: Promise<void> | null = null;

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const body = (await request.json()) as { videoId?: unknown };
    if (typeof body.videoId !== "string" || body.videoId.length === 0) {
      return Response.json({ error: "videoId is required" }, { status: 400 });
    }
    const videoId = body.videoId;

    if (!this.running) {
      this.statusReady = updateSourceVideoTranscriptContext(
        this.env.DB,
        videoId,
        { status: "checking" },
      ).then(() => undefined);
      this.running = this.statusReady
        .then(async () => {
          const video = await getSourceVideoById(this.env.DB, videoId);
          if (!video) throw new Error("Video not found");
          await prepareVideoTranscript(this.env, video);
        })
        .then(() => undefined)
        .finally(() => {
          this.running = null;
          this.statusReady = null;
        });
      this.ctx.waitUntil(this.running);
    }
    await this.statusReady;

    return Response.json({ transcriptStatus: "checking" }, { status: 202 });
  }
}

export async function dispatchTranscriptPreparation(
  env: Env,
  videoId: string,
): Promise<void> {
  const job = env.TRANSCRIPT_PREPARATION.getByName(videoId);
  const response = await job.fetch("http://transcript/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `Transcript preparation dispatch failed (${response.status})`,
    );
  }
}
