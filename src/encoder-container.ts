import { Container } from "@cloudflare/containers";
import {
  assembleWordTranscript,
  type AudioChunkWindow,
  type WhisperChunkOutput,
} from "./audio-transcription";
import type { Env } from "./env";
import {
  classifyEncoderRunResponse,
  failClip,
  failClipAmbiguous,
  recordEncoderRunOutcome,
} from "./jobs";
import {
  getSourceVideoById,
  markClipDownloadingIfQueued,
  markGifComplete,
  markSourceVideoRetainedSourceFailed,
  markSourceVideoRetainedSourceImporting,
  markSourceVideoRetainedSourceReady,
} from "./db";
import type {
  CaptionRenderEncoderJobSpec,
  EncoderJobSpec,
  GifEncoderJobSpec,
  SourceVideoRecord,
} from "./types";
import {
  completeCaptionRender,
  failCaptionRender,
} from "./caption-tracks";
import { UPLOAD_KEY_PREFIX } from "./uploads";
import {
  isYoutubeRetainedSourceKey,
  youtubeRetainedSourceKey,
} from "./source-videos";

type RunJobSpec = Omit<EncoderJobSpec, "source"> & {
  deferArtifactUpload?: boolean;
  source?: EncoderJobSpec["source"] | { type: "file"; path: string };
  jobType?: "gif" | "captioned";
  renderId?: string;
  cues?: CaptionRenderEncoderJobSpec["cues"];
  theme?: CaptionRenderEncoderJobSpec["theme"];
  sourceMp4Key?: string;
  outputs?:
    | EncoderJobSpec["outputs"]
    | GifEncoderJobSpec["outputs"]
    | CaptionRenderEncoderJobSpec["outputs"];
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

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  const parts: string[] = [];
  const sliceSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    parts.push(
      String.fromCharCode(...bytes.subarray(offset, offset + sliceSize)),
    );
  }
  return btoa(parts.join(""));
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

    if (
      url.pathname === "/__carpo/video-metadata" &&
      request.method === "POST"
    ) {
      const stopKeepalive = this.startJobKeepalive();
      try {
        return await super.fetch(
          new Request("http://encoder/video-metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: request.body,
          }),
        );
      } finally {
        stopKeepalive();
      }
    }

    if (
      url.pathname === "/__carpo/video-transcript" &&
      request.method === "POST"
    ) {
      const stopKeepalive = this.startJobKeepalive();
      try {
        return await super.fetch(
          new Request("http://encoder/video-transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: request.body,
          }),
        );
      } finally {
        stopKeepalive();
      }
    }

    if (
      url.pathname === "/__carpo/stored-video-metadata" &&
      request.method === "POST"
    ) {
      try {
        const body = (await request.json()) as { key?: unknown };
        if (typeof body.key !== "string") {
          return Response.json(
            { error: "Video source key is required" },
            { status: 400 },
          );
        }
        return this.handleStoredVideoMetadata(body.key);
      } catch {
        return Response.json(
          { error: "Invalid video metadata payload" },
          { status: 400 },
        );
      }
    }

    if (
      url.pathname === "/__carpo/source-transcript" &&
      request.method === "POST"
    ) {
      try {
        const body = (await request.json()) as { videoId?: unknown };
        if (typeof body.videoId !== "string") {
          return Response.json(
            { errorMessage: "Video ID is required" },
            { status: 400 },
          );
        }
        return await this.handleSourceTranscript(body.videoId);
      } catch {
        return Response.json(
          { errorMessage: "Invalid source transcript payload" },
          { status: 400 },
        );
      }
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

    if (url.pathname === "/__carpo/caption-run" && request.method === "POST") {
      try {
        const job = (await request.json()) as RunJobSpec;
        return await this.handleCaptionRun(job);
      } catch {
        return Response.json(
          { status: "failed", errorMessage: "Invalid caption job payload" },
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
    const phaseStarted = Date.now();
    let lastPhase = phaseStarted;
    const logPhase = (name: string) => {
      const now = Date.now();
      console.log(
        `clip ${clipId} phase ${name}: ${now - lastPhase}ms (total ${now - phaseStarted}ms)`,
      );
      lastPhase = now;
    };

    let retainedSourceAttempt:
      | { videoId: string; key: string }
      | null = null;
    let retainedSourceReady = false;

    try {
      if (job.source?.type === "youtube" && job.sourceVideoId) {
        const sourceVideo = await getSourceVideoById(
          this.env.DB,
          job.sourceVideoId,
        );
        if (!sourceVideo) {
          await failClip(this.env, clipId, "Video source not found");
          return Response.json(
            { status: "failed", errorMessage: "Video source not found" },
            { status: 404 },
          );
        }

        if (
          await this.stageReadyYoutubeSource(sourceVideo, jobId)
        ) {
          logPhase("stage-retained-source");
          job = {
            ...job,
            source: { type: "file", path: stagedSourcePath(jobId) },
          } as RunJobSpec;
        }

        if (job.source?.type === "youtube") {
          const key = await this.beginYoutubeSourceRetention(sourceVideo.id);
          if (!key) {
            await failClip(this.env, clipId, "Unable to retain video source");
            return Response.json(
              {
                status: "failed",
                errorMessage: "Unable to retain video source",
              },
              { status: 500 },
            );
          }
          retainedSourceAttempt = { videoId: sourceVideo.id, key };
          job = { ...job, retainSourceArtifact: true };
        }
      }

      if (job.source?.type === "upload") {
        const staged = await this.stageBucketSource(job.source.key, jobId);
        logPhase("stage-source");
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
      logPhase("encoder-run");

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
            if (retainedSourceAttempt) {
              await this.persistDownloadedYoutubeSource(
                retainedSourceAttempt.videoId,
                retainedSourceAttempt.key,
                jobId,
              );
              retainedSourceReady = true;
              logPhase("retain-source");
            }
            await this.uploadDeferredArtifacts(job.outputs, jobId);
            logPhase("upload-artifacts");
          } catch (error) {
            await this.cleanupDeferredArtifacts(job.outputs);
            const message =
              error instanceof Error
                ? error.message
                : "Failed to upload encoded artifacts";
            if (retainedSourceAttempt && !retainedSourceReady) {
              await markSourceVideoRetainedSourceFailed(
                this.env.DB,
                retainedSourceAttempt.videoId,
                message,
              );
            }
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

      if (retainedSourceAttempt && !retainedSourceReady) {
        const message =
          classified.kind === "ok"
            ? classified.result.errorMessage ?? "Source import failed"
            : "Source import failed";
        await markSourceVideoRetainedSourceFailed(
          this.env.DB,
          retainedSourceAttempt.videoId,
          message,
        );
      }

      if (classified.kind === "ok") {
        return Response.json(classified.result, { status: response.status });
      }

      return new Response(rawBody || null, { status: response.status });
    } catch (error) {
      if (retainedSourceAttempt && !retainedSourceReady) {
        await markSourceVideoRetainedSourceFailed(
          this.env.DB,
          retainedSourceAttempt.videoId,
          error instanceof Error ? error.message : "Source import failed",
        );
      }
      throw error;
    } finally {
      await this.cleanupJobFiles(jobId);
    }
  }

  private async stageBucketSource(
    sourceKey: string,
    jobId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (
      !sourceKey.startsWith(UPLOAD_KEY_PREFIX) &&
      !isYoutubeRetainedSourceKey(sourceKey)
    ) {
      return { ok: false, error: "Invalid video source key" };
    }

    const object = await this.env.CLIPS_BUCKET.get(sourceKey);
    if (!object) {
      return { ok: false, error: "Video source not found" };
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "video/mp4");
    }
    headers.set("Content-Length", String(object.size));

    if (!object.body) {
      return { ok: false, error: "Video source body is empty" };
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
        error: detail || `Failed to stage video source (${stageResponse.status})`,
      };
    }

    return { ok: true };
  }

  private async handleStoredVideoMetadata(sourceKey: string): Promise<Response> {
    const jobId = crypto.randomUUID();
    const stopKeepalive = this.startJobKeepalive();
    try {
      const staged = await this.stageBucketSource(sourceKey, jobId);
      if (!staged.ok) {
        return Response.json({ error: staged.error }, { status: 404 });
      }
      return await super.fetch(
        new Request(
          `http://encoder/staged-video-metadata?job=${encodeURIComponent(jobId)}`,
          { method: "POST" },
        ),
      );
    } finally {
      stopKeepalive();
      await this.cleanupJobFiles(jobId);
    }
  }

  private async handleSourceTranscript(videoId: string): Promise<Response> {
    const jobId = crypto.randomUUID();
    await this.incrementQueueDepth();
    try {
      return await this.enqueueJob(async () => {
        const stopKeepalive = this.startJobKeepalive();
        try {
          await this.ctx.storage.put("jobStartedAt", Date.now());
          const video = await getSourceVideoById(this.env.DB, videoId);
          if (!video) {
            return Response.json(
              { errorMessage: "Video not found" },
              { status: 404 },
            );
          }

          const staged = await this.stageVideoForTranscription(video, jobId);
          if (!staged.ok) {
            return Response.json(
              { errorMessage: staged.error },
              { status: 502 },
            );
          }

          const extractionResponse = await super.fetch(
            new Request(
              `http://encoder/audio-chunks?job=${encodeURIComponent(jobId)}`,
              { method: "POST" },
            ),
          );
          if (!extractionResponse.ok) {
            return Response.json(
              {
                errorMessage: await this.readEncoderError(
                  extractionResponse,
                  "Audio extraction failed",
                ),
              },
              { status: 502 },
            );
          }

          const extraction = (await extractionResponse.json()) as {
            chunks?: AudioChunkWindow[];
          };
          if (!Array.isArray(extraction.chunks) || extraction.chunks.length === 0) {
            return Response.json(
              { errorMessage: "Audio extraction returned no chunks" },
              { status: 502 },
            );
          }

          const transcript = await this.transcribeAudioChunks(
            jobId,
            extraction.chunks,
          );
          return Response.json(transcript);
        } catch (error) {
          return Response.json(
            {
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "Retained-source transcription failed",
            },
            { status: 502 },
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

  private async stageVideoForTranscription(
    video: SourceVideoRecord,
    jobId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (video.source_type === "upload") {
      return this.stageBucketSource(video.source_ref, jobId);
    }

    if (await this.stageReadyYoutubeSource(video, jobId)) {
      return { ok: true };
    }

    const retainedKey = await this.beginYoutubeSourceRetention(video.id);
    if (!retainedKey) {
      return { ok: false, error: "Unable to prepare video source" };
    }

    try {
      const downloadResponse = await super.fetch(
        new Request(
          `http://encoder/retain-youtube-source?job=${encodeURIComponent(jobId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: video.source_ref,
              quality: "1080p",
            }),
          },
        ),
      );
      if (!downloadResponse.ok) {
        throw new Error(
          await this.readEncoderError(
            downloadResponse,
            "YouTube source download failed",
          ),
        );
      }

      await this.persistDownloadedYoutubeSource(
        video.id,
        retainedKey,
        jobId,
      );

      const staged = await this.stageBucketSource(retainedKey, jobId);
      if (!staged.ok) {
        throw new Error(staged.error);
      }
      return staged;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "YouTube source preparation failed";
      await markSourceVideoRetainedSourceFailed(
        this.env.DB,
        video.id,
        message,
      );
      return { ok: false, error: message };
    }
  }

  private async stageReadyYoutubeSource(
    video: SourceVideoRecord,
    jobId: string,
  ): Promise<boolean> {
    if (
      video.retained_source_status !== "ready" ||
      !video.retained_source_key
    ) {
      return false;
    }
    const staged = await this.stageBucketSource(
      video.retained_source_key,
      jobId,
    );
    if (staged.ok) return true;
    await markSourceVideoRetainedSourceFailed(
      this.env.DB,
      video.id,
      staged.error,
    );
    return false;
  }

  private async beginYoutubeSourceRetention(
    videoId: string,
  ): Promise<string | null> {
    const key = youtubeRetainedSourceKey(videoId);
    const marked = await markSourceVideoRetainedSourceImporting(
      this.env.DB,
      videoId,
      key,
    );
    return marked ? key : null;
  }

  private async persistDownloadedYoutubeSource(
    videoId: string,
    key: string,
    jobId: string,
  ): Promise<void> {
    await this.uploadDeferredSource(key, jobId);
    const retained = await markSourceVideoRetainedSourceReady(
      this.env.DB,
      videoId,
      key,
    );
    if (!retained) {
      await this.env.CLIPS_BUCKET.delete(key);
      throw new Error("Video was deleted during source import");
    }
  }

  private async transcribeAudioChunks(
    jobId: string,
    chunks: AudioChunkWindow[],
  ) {
    const parts: Array<{
      chunk: AudioChunkWindow;
      output: WhisperChunkOutput;
    }> = [];

    for (const chunk of chunks) {
      if (!/^audio-\d{3}\.mp3$/.test(chunk.name)) {
        throw new Error("Audio extraction returned an invalid chunk name");
      }
      const audioResponse = await super.fetch(
        new Request(jobOutputUrl(jobId, chunk.name)),
      );
      if (!audioResponse.ok) {
        throw new Error(`Failed to read audio chunk (${audioResponse.status})`);
      }
      const audio = arrayBufferToBase64(await audioResponse.arrayBuffer());
      const output = (await this.env.AI.run(
        "@cf/openai/whisper-large-v3-turbo",
        {
          audio,
          task: "transcribe",
          vad_filter: true,
          condition_on_previous_text: false,
        },
      )) as WhisperChunkOutput;
      parts.push({ chunk, output });
    }

    return assembleWordTranscript(parts);
  }

  private async readEncoderError(
    response: Response,
    fallback: string,
  ): Promise<string> {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as {
        errorMessage?: unknown;
        error?: unknown;
      };
      if (typeof parsed.errorMessage === "string") {
        return parsed.errorMessage;
      }
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {
      // Preserve useful plain-text encoder errors.
    }
    return raw || fallback;
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

  private async handleCaptionRun(job: RunJobSpec): Promise<Response> {
    const sourceMp4Key = job.sourceMp4Key;
    const outputs = job.outputs as
      | CaptionRenderEncoderJobSpec["outputs"]
      | undefined;
    if (
      !sourceMp4Key ||
      !outputs?.captionedMp4Key ||
      !job.renderId ||
      !job.cues ||
      !job.theme
    ) {
      return Response.json(
        {
          status: "failed",
          errorMessage: "Caption job is missing source, track, theme, or outputs",
        },
        { status: 400 },
      );
    }

    const jobId = sanitizeJobId(job.jobId);
    const renderId = job.renderId;
    const cues = job.cues;
    const theme = job.theme;
    await this.incrementQueueDepth();
    try {
      return await this.enqueueJob(async () => {
        const stopKeepalive = this.startJobKeepalive();
        try {
          await this.ctx.storage.put("jobStartedAt", Date.now());
          const staged = await this.stageMp4Output(sourceMp4Key, jobId);
          if (!staged.ok) {
            await failCaptionRender(this.env, job.jobId, renderId, staged.error);
            return Response.json(
              { status: "failed", errorMessage: staged.error },
              { status: 500 },
            );
          }

          const captionJob: CaptionRenderEncoderJobSpec = {
            jobId: job.jobId,
            jobType: "captioned",
            renderId,
            sourceMp4Key,
            source: { type: "file", path: stagedSourcePath(jobId) },
            cues,
            theme,
            outputs,
            deferArtifactUpload: true,
          };
          const response = await super.fetch(
            new Request("http://encoder/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(captionJob),
            }),
          );
          let result: { status?: string; errorMessage?: string };
          try {
            result = (await response.json()) as typeof result;
          } catch {
            const message = `Caption encoder returned an unreadable response (${response.status})`;
            await failCaptionRender(this.env, job.jobId, renderId, message);
            return Response.json(
              { status: "failed", errorMessage: message },
              { status: 500 },
            );
          }
          if (result.status !== "staged" && result.status !== "complete") {
            const message = result.errorMessage ?? "Caption encoding failed";
            await failCaptionRender(this.env, job.jobId, renderId, message);
            return Response.json(result, { status: response.status });
          }

          try {
            await this.uploadDeferredCaptionedMp4(
              outputs.captionedMp4Key,
              jobId,
            );
          } catch (error) {
            await this.env.CLIPS_BUCKET.delete(outputs.captionedMp4Key);
            const message =
              error instanceof Error
                ? error.message
                : "Failed to upload captioned MP4";
            await failCaptionRender(this.env, job.jobId, renderId, message);
            return Response.json(
              { status: "failed", errorMessage: message },
              { status: 500 },
            );
          }

          const accepted = await completeCaptionRender(
            this.env,
            job.jobId,
            renderId,
            outputs.captionedMp4Key,
          );
          if (!accepted) {
            await this.env.CLIPS_BUCKET.delete(outputs.captionedMp4Key);
            return Response.json(
              {
                status: "failed",
                errorMessage: "Caption track changed before rendering completed",
              },
              { status: 409 },
            );
          }
          return Response.json({
            status: "complete",
            outputs: { captionedMp4Key: outputs.captionedMp4Key },
          });
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

  private async uploadDeferredCaptionedMp4(
    key: string,
    jobId: string,
  ): Promise<void> {
    const response = await super.fetch(
      new Request(jobOutputUrl(jobId, "captioned.mp4")),
    );
    if (!response.ok) {
      throw new Error(`Failed to read captioned MP4 (${response.status})`);
    }
    await this.env.CLIPS_BUCKET.put(key, response.body, {
      httpMetadata: { contentType: "video/mp4" },
    });
    if (!(await this.env.CLIPS_BUCKET.head(key))) {
      throw new Error("Captioned MP4 was not durably stored in R2");
    }
  }

  private async uploadDeferredSource(
    sourceKey: string,
    jobId: string,
  ): Promise<void> {
    const sourceResponse = await super.fetch(
      new Request(jobOutputUrl(jobId, "source.mp4")),
    );
    if (!sourceResponse.ok) {
      throw new Error(
        `Failed to read retained source (${sourceResponse.status})`,
      );
    }

    await this.env.CLIPS_BUCKET.put(sourceKey, sourceResponse.body, {
      httpMetadata: { contentType: "video/mp4" },
    });

    const head = await this.env.CLIPS_BUCKET.head(sourceKey);
    if (!head) {
      throw new Error("Video source was not durably stored in R2");
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
