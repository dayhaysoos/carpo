import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import {
  classifyEncoderRunResponse,
  failClip,
  failClipAmbiguous,
  recordEncoderRunOutcome,
} from "./jobs";
import { markClipDownloadingIfQueued, markGifComplete } from "./db";
import type { EncoderJobSpec, GifEncoderJobSpec } from "./types";
import { UPLOAD_KEY_PREFIX } from "./uploads";

type RunJobSpec = Omit<EncoderJobSpec, "source"> & {
  deferArtifactUpload?: boolean;
  source?: EncoderJobSpec["source"] | { type: "file"; path: string };
  jobType?: "gif";
  sourceMp4Key?: string;
  outputs?: EncoderJobSpec["outputs"] | GifEncoderJobSpec["outputs"];
};

// Hard ceiling for stale queue keepalive. If the worker isolate dies
// mid-/run, dispatch's finally never clears the flag; without a
// TTL the container would renew forever and leak a max_instances slot.
//
// Budget (container/encoder.py): download 600s + encode pass 600s + encode
// pass 600s + upload 600s + upload 600s = 3000s (~50 min) sequential worst
// case. TTL must exceed that; 70 min gives headroom.
const JOB_RUNNING_TTL_MS = 70 * 60 * 1000;
const ACTIVITY_RENEWAL_MS = 30_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function sanitizeJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid job ID");
  }
  return jobId;
}

function stagedSourcePath(jobId: string): string {
  return `/tmp/carpo-src-${sanitizeJobId(jobId)}`;
}

function jobOutputUrl(jobId: string, name: string): string {
  return `http://encoder/outputs/${sanitizeJobId(jobId)}/${name}`;
}

export class EncoderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;

  // In-memory FIFO chain: exactly one job talks to the container process at a
  // time. If the DO is evicted, the chain is lost along with in-flight
  // waitUntil contexts — same failure mode as today; ambiguous-failure + the
  // 15-min sweep backstop covers recovery.
  private jobChain: Promise<void> = Promise.resolve();

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

    if (url.pathname === "/__carpo/dispatch" && request.method === "POST") {
      try {
        const job = (await request.json()) as RunJobSpec;
        return this.handleDispatch(job);
      } catch {
        return Response.json(
          { status: "failed", errorMessage: "Invalid dispatch payload" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/__carpo/gif-run" && request.method === "POST") {
      try {
        const job = (await request.json()) as RunJobSpec;
        return await this.handleGifRun(job);
      } catch {
        return Response.json(
          { status: "failed", errorMessage: "Invalid GIF job payload" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return this.handleRun(request);
    }

    return super.fetch(request);
  }

  override async onActivityExpired(): Promise<void> {
    const queueDepth = (await this.ctx.storage.get<number>("queueDepth")) ?? 0;
    if (queueDepth > 0) {
      const jobStartedAt = await this.ctx.storage.get<number>("jobStartedAt");
      const elapsed = jobStartedAt ? Date.now() - jobStartedAt : Infinity;
      if (elapsed < JOB_RUNNING_TTL_MS) {
        this.renewActivityTimeout();
        return;
      }
      await this.ctx.storage.put("queueDepth", 0);
      await this.ctx.storage.delete("jobStartedAt");
    }
    await this.stop();
  }

  private enqueueJob<T>(work: () => Promise<T>): Promise<T> {
    const run = this.jobChain.then(work);
    this.jobChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async incrementQueueDepth(): Promise<void> {
    const depth = (await this.ctx.storage.get<number>("queueDepth")) ?? 0;
    await this.ctx.storage.put("queueDepth", depth + 1);
  }

  private async decrementQueueDepth(): Promise<void> {
    const depth = (await this.ctx.storage.get<number>("queueDepth")) ?? 0;
    await this.ctx.storage.put("queueDepth", Math.max(0, depth - 1));
  }

  // Keepalive ownership: the worker no longer renews activity during dispatch.
  // The DO renews while a job holds the queue slot (interval + phase boundaries).
  private startJobKeepalive(): () => void {
    this.renewActivityTimeout();
    const interval = setInterval(() => {
      this.renewActivityTimeout();
      void this.ctx.storage.put("lastActivity", Date.now());
    }, ACTIVITY_RENEWAL_MS);
    return () => clearInterval(interval);
  }

  private handleDispatch(job: RunJobSpec): Response {
    if (job.jobType === "gif") {
      return Response.json(
        { status: "failed", errorMessage: "GIF jobs must use /__carpo/gif-run" },
        { status: 400 },
      );
    }

    const clipId = job.jobId;
    const dispatchWork = this.incrementQueueDepth().then(async () => {
      try {
        await this.enqueueJob(async () => {
          const stopKeepalive = this.startJobKeepalive();
          try {
            await this.ctx.storage.put("jobStartedAt", Date.now());
            await markClipDownloadingIfQueued(this.env.DB, clipId);
            await this.executeClipRun(job);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown encoding error";
            await failClipAmbiguous(
              this.env,
              clipId,
              `Encoder container error: ${message}`,
            );
          } finally {
            stopKeepalive();
            await this.ctx.storage.delete("jobStartedAt");
          }
        });
      } finally {
        await this.decrementQueueDepth();
      }
    });

    this.ctx.waitUntil(dispatchWork);
    return new Response(null, { status: 202 });
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

    const clipId = job.jobId;
    await this.incrementQueueDepth();
    const runPromise = this.enqueueJob(async () => {
      const stopKeepalive = this.startJobKeepalive();
      try {
        await this.ctx.storage.put("jobStartedAt", Date.now());
        await markClipDownloadingIfQueued(this.env.DB, clipId);
        return await this.executeClipRun(job);
      } finally {
        stopKeepalive();
        await this.ctx.storage.delete("jobStartedAt");
        await this.decrementQueueDepth();
      }
    });
    this.ctx.waitUntil(
      runPromise.catch(async (error) => {
        const message =
          error instanceof Error ? error.message : "Unknown encoding error";
        await failClipAmbiguous(
          this.env,
          clipId,
          `Encoder container error: ${message}`,
        );
      }),
    );
    return runPromise;
  }

  private async executeClipRun(job: RunJobSpec): Promise<Response> {
    const clipId = job.jobId;
    const jobId = sanitizeJobId(clipId);

    try {
      if (job.source?.type === "upload") {
        const staged = await this.stageUploadSource(job.source.key, jobId);
        if (!staged.ok) {
          await failClip(this.env, clipId, staged.error);
          return Response.json(
            { status: "failed", errorMessage: staged.error },
            { status: 500 },
          );
        }

        job = {
          ...job,
          source: { type: "file", path: stagedSourcePath(jobId) },
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

      const rawBody = await response.text();
      const classified = classifyEncoderRunResponse(
        response.ok,
        response.status,
        rawBody,
      );

      if (classified.kind === "ok") {
        const result = classified.result;
        if (result.status === "staged" || result.status === "complete") {
          try {
            await this.uploadDeferredArtifacts(job.outputs, jobId);
          } catch (error) {
            await this.cleanupDeferredArtifacts(job.outputs);
            const message =
              error instanceof Error
                ? error.message
                : "Failed to upload encoded artifacts";
            await failClip(this.env, clipId, message);
            return Response.json(
              { status: "failed", errorMessage: message },
              { status: 500 },
            );
          }

          const terminalOutcome = {
            kind: "complete" as const,
            outputs: {
              mp4Key: job.outputs.mp4Key,
              thumbnailKey: job.outputs.thumbnailKey,
            },
          };
          this.ctx.waitUntil(recordEncoderRunOutcome(this.env, clipId, terminalOutcome));
          await recordEncoderRunOutcome(this.env, clipId, terminalOutcome);

          return Response.json(
            {
              status: "complete",
              outputs: terminalOutcome.outputs,
            },
            { status: 200 },
          );
        }
      }

      this.ctx.waitUntil(recordEncoderRunOutcome(this.env, clipId, classified));
      await recordEncoderRunOutcome(this.env, clipId, classified);

      if (classified.kind === "ok") {
        return Response.json(classified.result, { status: response.status });
      }

      return new Response(rawBody || null, { status: response.status });
    } finally {
      await this.cleanupJobFiles(jobId);
    }
  }

  private async stageUploadSource(
    uploadKey: string,
    jobId: string,
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
      new Request(`http://encoder/stage-source?job=${jobId}`, {
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

    const jobId = sanitizeJobId(job.jobId);
    await this.incrementQueueDepth();
    try {
      return await this.enqueueJob(async () => {
        const stopKeepalive = this.startJobKeepalive();
        try {
          await this.ctx.storage.put("jobStartedAt", Date.now());

          const staged = await this.stageMp4Output(sourceMp4Key, jobId);
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
            source: { type: "file", path: stagedSourcePath(jobId) },
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
            await this.uploadDeferredGif(gifOutputs.gifKey, jobId);
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
        } finally {
          stopKeepalive();
          await this.ctx.storage.delete("jobStartedAt");
          await this.cleanupJobFiles(jobId);
        }
      });
    } finally {
      await this.decrementQueueDepth();
    }
  }

  private async stageMp4Output(
    mp4Key: string,
    jobId: string,
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
      new Request(`http://encoder/stage-source?job=${jobId}`, {
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

  private async uploadDeferredGif(gifKey: string, jobId: string): Promise<void> {
    const gifResponse = await super.fetch(
      new Request(jobOutputUrl(jobId, "clip.gif")),
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
    jobId: string,
  ): Promise<void> {
    const mp4Response = await super.fetch(
      new Request(jobOutputUrl(jobId, "clip.mp4")),
    );
    if (!mp4Response.ok) {
      throw new Error(`Failed to read encoded MP4 (${mp4Response.status})`);
    }

    const thumbResponse = await super.fetch(
      new Request(jobOutputUrl(jobId, "thumbnail.jpg")),
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

  private async cleanupJobFiles(jobId: string): Promise<void> {
    try {
      await super.fetch(
        new Request(`http://encoder/cleanup?job=${jobId}`, { method: "POST" }),
      );
    } catch {
      // Best-effort; belt-and-braces sweep in encoder.py covers leaks.
    }
  }
}
