import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import type { EncoderJobSpec } from "./types";
import { UPLOAD_KEY_PREFIX } from "./uploads";

const STAGED_UPLOAD_PATH = "/tmp/carpo-upload-source.mp4";

type RunJobSpec = EncoderJobSpec & {
  deferArtifactUpload?: boolean;
  source?: EncoderJobSpec["source"] | { type: "file"; path: string };
};

// Hard ceiling for stale jobRunning keepalive. If the worker isolate dies
// mid-/run, dispatchEncodingJob's finally never clears the flag; without a
// TTL the container would renew forever and leak a max_instances slot.
//
// Budget (container/encoder.py): download 600s + encode pass 600s + encode
// pass 600s + upload 600s + upload 600s = 3000s (~50 min) sequential worst
// case. TTL must exceed that; 70 min gives headroom.
const JOB_RUNNING_TTL_MS = 70 * 60 * 1000;

export class EncoderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__carpo/start" && request.method === "POST") {
      await this.startAndWaitForPorts({
        ports: 8080,
        startOptions: {
          enableInternet: true,
        },
        cancellationOptions: {
          portReadyTimeoutMS: 60_000,
        },
      });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/renew-activity" && request.method === "POST") {
      this.renewActivityTimeout();
      await this.ctx.storage.put("lastActivity", Date.now());
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/job-running" && request.method === "POST") {
      const body = (await request.json()) as { running?: boolean };
      const running = Boolean(body.running);
      await this.ctx.storage.put("jobRunning", running);
      if (running) {
        await this.ctx.storage.put("jobStartedAt", Date.now());
      } else {
        await this.ctx.storage.delete("jobStartedAt");
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return this.handleRun(request);
    }

    return super.fetch(request);
  }

  override async onActivityExpired(): Promise<void> {
    const jobRunning = await this.ctx.storage.get<boolean>("jobRunning");
    if (jobRunning) {
      const jobStartedAt = await this.ctx.storage.get<number>("jobStartedAt");
      const elapsed = jobStartedAt ? Date.now() - jobStartedAt : Infinity;
      if (elapsed < JOB_RUNNING_TTL_MS) {
        this.renewActivityTimeout();
        return;
      }
      await this.ctx.storage.put("jobRunning", false);
      await this.ctx.storage.delete("jobStartedAt");
    }
    await this.stop();
  }

  private async handleRun(request: Request): Promise<Response> {
    let job: RunJobSpec;
    try {
      job = (await request.json()) as RunJobSpec;
    } catch {
      return super.fetch(request);
    }

    if (job.source?.type === "upload") {
      const staged = await this.stageUploadSource(job.source.key);
      if (!staged.ok) {
        return Response.json(
          { status: "failed", errorMessage: staged.error },
          { status: 500 },
        );
      }

      job = {
        ...job,
        source: { type: "file", path: STAGED_UPLOAD_PATH },
      };
    }

    job.deferArtifactUpload = true;

    const response = await super.fetch(
      new Request("http://encoder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      }),
    );

    let result: { status?: string; errorMessage?: string; outputs?: EncoderJobSpec["outputs"] };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      return response;
    }

    if (result.status !== "staged" && result.status !== "complete") {
      return Response.json(result, { status: response.status });
    }

    try {
      await this.uploadDeferredArtifacts(job.outputs);
    } catch (error) {
      await this.cleanupDeferredArtifacts(job.outputs);
      const message =
        error instanceof Error ? error.message : "Failed to upload encoded artifacts";
      return Response.json(
        { status: "failed", errorMessage: message },
        { status: 500 },
      );
    }

    return Response.json(
      {
        status: "complete",
        outputs: {
          mp4Key: job.outputs.mp4Key,
          thumbnailKey: job.outputs.thumbnailKey,
        },
      },
      { status: 200 },
    );
  }

  private async stageUploadSource(
    uploadKey: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!uploadKey.startsWith(UPLOAD_KEY_PREFIX)) {
      return { ok: false, error: "Invalid upload key" };
    }

    const object = await this.env.CLIPS_BUCKET.get(uploadKey);
    if (!object) {
      return { ok: false, error: "Upload source not found" };
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "video/mp4");
    }

    const stageResponse = await super.fetch(
      new Request("http://encoder/stage-source", {
        method: "POST",
        headers,
        body: object.body,
      }),
    );

    if (!stageResponse.ok) {
      const detail = await stageResponse.text();
      return {
        ok: false,
        error: detail || `Failed to stage upload source (${stageResponse.status})`,
      };
    }

    return { ok: true };
  }

  private async uploadDeferredArtifacts(
    outputs: EncoderJobSpec["outputs"],
  ): Promise<void> {
    const mp4Response = await super.fetch(
      new Request("http://encoder/outputs/clip.mp4"),
    );
    if (!mp4Response.ok) {
      throw new Error(`Failed to read encoded MP4 (${mp4Response.status})`);
    }

    const thumbResponse = await super.fetch(
      new Request("http://encoder/outputs/thumbnail.jpg"),
    );
    if (!thumbResponse.ok) {
      throw new Error(`Failed to read encoded thumbnail (${thumbResponse.status})`);
    }

    await this.env.CLIPS_BUCKET.put(outputs.mp4Key, mp4Response.body, {
      httpMetadata: { contentType: "video/mp4" },
    });
    await this.env.CLIPS_BUCKET.put(outputs.thumbnailKey, thumbResponse.body, {
      httpMetadata: { contentType: "image/jpeg" },
    });

    const [mp4Head, thumbHead] = await Promise.all([
      this.env.CLIPS_BUCKET.head(outputs.mp4Key),
      this.env.CLIPS_BUCKET.head(outputs.thumbnailKey),
    ]);
    if (!mp4Head || !thumbHead) {
      throw new Error("Encoded artifacts were not durably stored in R2");
    }
  }

  private async cleanupDeferredArtifacts(
    outputs: EncoderJobSpec["outputs"],
  ): Promise<void> {
    await Promise.all([
      this.env.CLIPS_BUCKET.delete(outputs.mp4Key),
      this.env.CLIPS_BUCKET.delete(outputs.thumbnailKey),
    ]);
  }
}
