import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import { applyStatusUpdate } from "./jobs";
import { markGifComplete } from "./db";
import type { EncoderJobSpec, GifEncoderJobSpec } from "./types";
import { UPLOAD_KEY_PREFIX } from "./uploads";

const COMPLETE_SIGNAL_ATTEMPTS = 3;
const COMPLETE_SIGNAL_BACKOFF_MS = 500;

const STAGED_UPLOAD_PATH = "/tmp/carpo-upload-source.mp4";

type RunJobSpec = Omit<EncoderJobSpec, "source"> & {
  deferArtifactUpload?: boolean;
  source?: EncoderJobSpec["source"] | { type: "file"; path: string };
  jobType?: "gif";
  sourceMp4Key?: string;
  outputs?: EncoderJobSpec["outputs"] | GifEncoderJobSpec["outputs"];
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

    if (job.jobType === "gif") {
      return this.handleGifRun(job);
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
      } as RunJobSpec;
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

    await signalDeferredComplete(this.env, job.jobId);

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
    headers.set("Content-Length", String(object.size));

    if (!object.body) {
      return { ok: false, error: "Upload source body is empty" };
    }

    const { readable, writable } = new FixedLengthStream(object.size);
    const pipePromise = object.body.pipeTo(writable);

    const stageResponse = await super.fetch(
      new Request("http://encoder/stage-source", {
        method: "POST",
        headers,
        body: readable,
      }),
    );

    await pipePromise;

    if (!stageResponse.ok) {
      const detail = await stageResponse.text();
      return {
        ok: false,
        error: detail || `Failed to stage upload source (${stageResponse.status})`,
      };
    }

    return { ok: true };
  }

  private async handleGifRun(job: RunJobSpec): Promise<Response> {
    const sourceMp4Key = job.sourceMp4Key;
    const gifOutputs = job.outputs as GifEncoderJobSpec["outputs"] | undefined;
    if (!sourceMp4Key || !gifOutputs?.gifKey) {
      return Response.json(
        { status: "failed", errorMessage: "GIF job is missing source or outputs" },
        { status: 400 },
      );
    }

    const staged = await this.stageMp4Output(sourceMp4Key);
    if (!staged.ok) {
      return Response.json(
        { status: "failed", errorMessage: staged.error },
        { status: 500 },
      );
    }

    const gifJob: GifEncoderJobSpec = {
      jobId: job.jobId,
      jobType: "gif",
      sourceMp4Key,
      source: { type: "file", path: STAGED_UPLOAD_PATH },
      outputs: gifOutputs,
      deferArtifactUpload: true,
    };

    const response = await super.fetch(
      new Request("http://encoder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gifJob),
      }),
    );

    let result: { status?: string; errorMessage?: string };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      return response;
    }

    if (result.status !== "staged" && result.status !== "complete") {
      return Response.json(result, { status: response.status });
    }

    try {
      await this.uploadDeferredGif(gifOutputs.gifKey);
    } catch (error) {
      await this.env.CLIPS_BUCKET.delete(gifOutputs.gifKey);
      const message =
        error instanceof Error ? error.message : "Failed to upload GIF artifact";
      return Response.json(
        { status: "failed", errorMessage: message },
        { status: 500 },
      );
    }

    await markGifComplete(this.env.DB, job.jobId, gifOutputs.gifKey);

    return Response.json(
      {
        status: "complete",
        outputs: { gifKey: gifOutputs.gifKey },
      },
      { status: 200 },
    );
  }

  private async stageMp4Output(
    mp4Key: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const object = await this.env.CLIPS_BUCKET.get(mp4Key);
    if (!object) {
      return { ok: false, error: "Clip MP4 output not found" };
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "video/mp4");
    }
    headers.set("Content-Length", String(object.size));

    if (!object.body) {
      return { ok: false, error: "Clip MP4 body is empty" };
    }

    const { readable, writable } = new FixedLengthStream(object.size);
    const pipePromise = object.body.pipeTo(writable);

    const stageResponse = await super.fetch(
      new Request("http://encoder/stage-source", {
        method: "POST",
        headers,
        body: readable,
      }),
    );

    await pipePromise;

    if (!stageResponse.ok) {
      const detail = await stageResponse.text();
      return {
        ok: false,
        error: detail || `Failed to stage clip MP4 (${stageResponse.status})`,
      };
    }

    return { ok: true };
  }

  private async uploadDeferredGif(gifKey: string): Promise<void> {
    const gifResponse = await super.fetch(
      new Request("http://encoder/outputs/clip.gif"),
    );
    if (!gifResponse.ok) {
      throw new Error(`Failed to read encoded GIF (${gifResponse.status})`);
    }

    await this.env.CLIPS_BUCKET.put(gifKey, gifResponse.body, {
      httpMetadata: { contentType: "image/gif" },
    });

    const head = await this.env.CLIPS_BUCKET.head(gifKey);
    if (!head) {
      throw new Error("GIF artifact was not durably stored in R2");
    }
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

/**
 * Best-effort complete signal after deferred artifacts land in R2. Uses
 * applyStatusUpdate directly instead of HTTP to the internal status route
 * because Cloudflare Access blocks container→worker fetches in production and
 * vitest routes DO subrequests to ASSETS. Same recovery semantics as the
 * encoder's authenticated complete callback (ambiguous-failed → complete).
 */
async function signalDeferredComplete(env: Env, clipId: string): Promise<void> {
  for (let attempt = 0; attempt < COMPLETE_SIGNAL_ATTEMPTS; attempt += 1) {
    try {
      await applyStatusUpdate(env, clipId, "complete");
      return;
    } catch (error) {
      console.warn(
        `Deferred complete signal attempt ${attempt + 1} failed:`,
        error instanceof Error ? error.message : error,
      );
      if (attempt < COMPLETE_SIGNAL_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, COMPLETE_SIGNAL_BACKOFF_MS * 2 ** attempt),
        );
      }
    }
  }
}
