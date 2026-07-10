import { DurableObject } from "cloudflare:workers";
import { JOB_SECRET_HEADER } from "../src/auth";
import type { Env } from "../src/env";
import {
  applyStatusUpdate,
  classifyEncoderRunResponse,
  recordEncoderRunOutcome,
} from "../src/jobs";
import { markClipDownloadingIfQueued, markGifComplete } from "../src/db";
import type { EncoderJobSpec, GifEncoderJobSpec } from "../src/types";

const FAKE_MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  0x6d, 0x70, 0x34, 0x31,
]);

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const FAKE_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
  0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
  0x03, 0x01, 0x00, 0x00, 0x00,
  0x3b,
]);

/** Upload MP4 keys that make the GIF stub fail for API seam tests. */
export const STUB_GIF_FAILURE_MP4_KEY = "clips/stub-gif-failure/clip.mp4";

/** Test-only YouTube URLs that drive EncoderStub behavior in API seam tests. */
export const STUB_SKIP_COMPLETE_CALLBACK_URL =
  "https://www.youtube.com/watch?v=stub-skip-complete-callback";
export const STUB_AMBIGUOUS_FAILURE_URL =
  "https://www.youtube.com/watch?v=stub-ambiguous-failure";
export const STUB_CONTAINER_START_FAILURE_URL =
  "https://www.youtube.com/watch?v=stub-container-start-failure";
export const STUB_VERIFY_WORKER_BASE_URL =
  "https://www.youtube.com/watch?v=stub-verify-worker-base-url";
export const STUB_NO_CALLBACKS_SLOW_RUN_URL =
  "https://www.youtube.com/watch?v=stub-no-callbacks-slow-run";
export const STUB_QUEUE_HOLD_URL =
  "https://www.youtube.com/watch?v=stub-queue-hold";
export const STUB_DEFERRED_COPY_FAILURE_UPLOAD_KEY =
  "uploads/stub-deferred-copy-failure.mp4";
export const STUB_DEFERRED_SLOW_UPLOAD_KEY =
  "uploads/stub-deferred-slow-upload.mp4";
export const STUB_DEFERRED_AMBIGUOUS_FAILURE_UPLOAD_KEY =
  "uploads/stub-deferred-ambiguous-failure.mp4";

/**
 * Test double for the encoder container binding.
 * Simulates lifecycle callbacks and writes stub artifacts to R2.
 *
 * Compromise: vitest-pool-workers cannot boot real Container instances, so this
 * plain Durable Object implements the same fetch-based control protocol.
 */
export class EncoderStub extends DurableObject<Env> {
  private lastDispatch: EncoderJobSpec | null = null;
  private dispatchesByJobId = new Map<string, EncoderJobSpec>();
  private jobChain: Promise<void> = Promise.resolve();
  private concurrentRuns = 0;
  private maxConcurrentRuns = 0;
  private queueHoldRelease: (() => void) | null = null;
  private queueHoldPromise: Promise<void> | null = null;
  // Mirrors the container filesystem: staged per-job sources and per-job
  // output dirs, so tests catch ordering bugs (e.g. run-start cleanup
  // deleting a freshly staged source) instead of hiding them.
  private stagedSources = new Set<string>();
  private jobOutputs = new Set<string>();
  private jobEvents = new Map<string, string[]>();
  private containerStartCount = 0;
  private prewarmStartShouldFail = false;

  private recordJobEvent(jobId: string, event: string): void {
    const events = this.jobEvents.get(jobId) ?? [];
    events.push(event);
    this.jobEvents.set(jobId, events);
  }

  /** Same contract as encoder.py stage_source: write per-job source file. */
  private stageSource(jobId: string): void {
    this.stagedSources.add(jobId);
    this.recordJobEvent(jobId, "stage-source");
  }

  /**
   * Same contract as encoder.py prepare_job_workspace: run-start defensive
   * cleanup removes leftover per-job OUTPUTS only — never the staged source,
   * which was staged immediately before /run and is the job's input.
   */
  private prepareJobWorkspace(jobId: string): void {
    this.jobOutputs.delete(jobId);
    this.recordJobEvent(jobId, "run-start");
  }

  /** Same contract as encoder.py cleanup_job_artifacts (POST /cleanup). */
  private cleanupJob(jobId: string): void {
    this.stagedSources.delete(jobId);
    this.jobOutputs.delete(jobId);
    this.recordJobEvent(jobId, "cleanup");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__carpo/last-dispatch") {
      const jobId = url.searchParams.get("jobId");
      if (jobId) {
        return Response.json(this.dispatchesByJobId.get(jobId) ?? null);
      }
      return Response.json(this.lastDispatch);
    }

    if (url.pathname === "/__carpo/max-concurrency") {
      return Response.json({ maxConcurrentRuns: this.maxConcurrentRuns });
    }

    if (url.pathname === "/__carpo/job-events") {
      const jobId = url.searchParams.get("jobId") ?? "";
      return Response.json({ events: this.jobEvents.get(jobId) ?? [] });
    }

    if (url.pathname === "/__carpo/container-starts") {
      return Response.json({ count: this.containerStartCount });
    }

    if (
      url.pathname === "/__carpo/set-prewarm-start-failure" &&
      request.method === "POST"
    ) {
      const body = (await request.json()) as { enabled?: boolean };
      this.prewarmStartShouldFail = body.enabled === true;
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/queue-hold-release" && request.method === "POST") {
      this.queueHoldRelease?.();
      this.queueHoldRelease = null;
      this.queueHoldPromise = null;
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/start") {
      this.containerStartCount += 1;

      let sourceUrl = "";
      try {
        const body = (await request.json()) as {
          source?: { type?: string; url?: string };
        };
        if (body.source?.type === "youtube" && typeof body.source.url === "string") {
          sourceUrl = body.source.url;
        }
      } catch {
        // Start body is optional; production encoder ignores it.
      }

      if (!sourceUrl && this.prewarmStartShouldFail) {
        return new Response("container prewarm start failed", { status: 503 });
      }
      if (sourceUrl.includes("stub-container-start-failure")) {
        return new Response("container start failed", { status: 503 });
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/renew-activity") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/stage-source") {
      const jobId = url.searchParams.get("job");
      if (!jobId || !/^[A-Za-z0-9-]+$/.test(jobId)) {
        return new Response("job query parameter required", { status: 400 });
      }
      this.stageSource(jobId);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/cleanup") {
      const jobId = url.searchParams.get("job");
      if (!jobId || !/^[A-Za-z0-9-]+$/.test(jobId)) {
        return new Response("job query parameter required", { status: 400 });
      }
      this.cleanupJob(jobId);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/dispatch") {
      const job = (await request.json()) as EncoderJobSpec | GifEncoderJobSpec;
      if ("jobType" in job && job.jobType === "gif") {
        return Response.json(
          { status: "failed", errorMessage: "GIF jobs must use /__carpo/gif-run" },
          { status: 400 },
        );
      }
      void this.runQueuedDispatch(job as EncoderJobSpec);
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/__carpo/gif-run") {
      const job = (await request.json()) as GifEncoderJobSpec;
      return this.runQueuedGifRun(job);
    }

    if (url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }

    const job = (await request.json()) as EncoderJobSpec | GifEncoderJobSpec;
    if ("jobType" in job && job.jobType === "gif") {
      return Response.json(
        { status: "failed", errorMessage: "GIF jobs must use /__carpo/gif-run" },
        { status: 400 },
      );
    }

    const encodeJob = job as EncoderJobSpec;
    if (encodeJob.source.type === "upload") {
      return this.runQueuedJob(() => this.handleDeferredUploadRun(encodeJob));
    }

    return this.runQueuedJob(() => this.runYoutubeJob(encodeJob));
  }

  private enqueueJob<T>(work: () => Promise<T>): Promise<T> {
    const run = this.jobChain.then(work);
    this.jobChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runQueuedDispatch(job: EncoderJobSpec): Promise<void> {
    await this.enqueueJob(async () => {
      this.lastDispatch = job;
      this.dispatchesByJobId.set(job.jobId, job);
      if (job.source.type === "upload") {
        await this.handleDeferredUploadRun(job);
        return;
      }
      await this.runYoutubeJob(job);
    });
  }

  private async runQueuedGifRun(job: GifEncoderJobSpec): Promise<Response> {
    return this.enqueueJob(() => this.handleGifRun(job));
  }

  private async runQueuedJob(work: () => Promise<Response>): Promise<Response> {
    return this.enqueueJob(work);
  }

  private async withRunSlot<T>(work: () => Promise<T>): Promise<T> {
    this.concurrentRuns += 1;
    this.maxConcurrentRuns = Math.max(this.maxConcurrentRuns, this.concurrentRuns);
    try {
      return await work();
    } finally {
      this.concurrentRuns -= 1;
    }
  }

  private async maybeHoldForQueueTest(sourceUrl: string): Promise<void> {
    if (!sourceUrl.includes("stub-queue-hold")) {
      return;
    }
    if (!this.queueHoldPromise) {
      this.queueHoldPromise = new Promise<void>((resolve) => {
        this.queueHoldRelease = resolve;
      });
    }
    await this.queueHoldPromise;
  }

  private async runYoutubeJob(encodeJob: EncoderJobSpec): Promise<Response> {
    return this.withRunSlot(async () => {
      await markClipDownloadingIfQueued(this.env.DB, encodeJob.jobId);

      const authHeaders = {
        "Content-Type": "application/json",
        [JOB_SECRET_HEADER]: encodeJob.callbackSecret,
      };

      const sourceUrl =
        encodeJob.source.type === "youtube" ? encodeJob.source.url : "";
      const skipCompleteCallback = sourceUrl.includes(
        "stub-skip-complete-callback",
      );
      const noCallbacksSlowRun = sourceUrl.includes("stub-no-callbacks-slow-run");
      const ambiguousFailure = sourceUrl.includes("stub-ambiguous-failure");
      const verifyWorkerBaseUrl = sourceUrl.includes("stub-verify-worker-base-url");

      await this.maybeHoldForQueueTest(sourceUrl);

      if (verifyWorkerBaseUrl) {
        const base = this.env.WORKER_BASE_URL ?? "http://localhost:8787";
        const expectedCallback = `${base}/api/internal/jobs/${encodeJob.jobId}/status`;
        const expectedMp4 = `${base}/api/internal/jobs/${encodeJob.jobId}/artifacts/mp4`;
        const expectedThumb = `${base}/api/internal/jobs/${encodeJob.jobId}/artifacts/thumbnail`;
        if (
          encodeJob.callbackUrl !== expectedCallback ||
          encodeJob.artifactUploadUrls.mp4 !== expectedMp4 ||
          encodeJob.artifactUploadUrls.thumbnail !== expectedThumb
        ) {
          return new Response(
            JSON.stringify({
              error: "WORKER_BASE_URL mismatch",
              got: {
                callbackUrl: encodeJob.callbackUrl,
                artifactUploadUrls: encodeJob.artifactUploadUrls,
              },
              expected: {
                callbackUrl: expectedCallback,
                mp4: expectedMp4,
                thumbnail: expectedThumb,
              },
            }),
            { status: 502 },
          );
        }
      }

      if (!noCallbacksSlowRun) {
        for (const status of ["downloading", "encoding", "uploading"] as const) {
          const callbackTarget = encodeJob.callbackUrl.startsWith("http")
            ? encodeJob.callbackUrl
            : `http://example.com${encodeJob.callbackUrl}`;
          await fetch(callbackTarget, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ status }),
          });
        }
      }

      await this.env.CLIPS_BUCKET.put(encodeJob.outputs.mp4Key, FAKE_MP4, {
        httpMetadata: { contentType: "video/mp4" },
      });
      await this.env.CLIPS_BUCKET.put(encodeJob.outputs.thumbnailKey, FAKE_JPEG, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      if (ambiguousFailure) {
        const outcome = classifyEncoderRunResponse(
          false,
          502,
          "upstream timeout",
        );
        await recordEncoderRunOutcome(this.env, encodeJob.jobId, outcome);
        return new Response("upstream timeout", { status: 502 });
      }

      if (noCallbacksSlowRun) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      if (!skipCompleteCallback && !noCallbacksSlowRun) {
        const callbackTarget = encodeJob.callbackUrl.startsWith("http")
          ? encodeJob.callbackUrl
          : `http://example.com${encodeJob.callbackUrl}`;
        await fetch(callbackTarget, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ status: "complete" }),
        });
      }

      await recordEncoderRunOutcome(this.env, encodeJob.jobId, {
        kind: "complete",
        outputs: encodeJob.outputs,
      });

      return Response.json({
        status: "complete",
        outputs: encodeJob.outputs,
      });
    });
  }

  private async handleGifRun(
    job: GifEncoderJobSpec,
  ): Promise<Response> {
    return this.withRunSlot(async () => {
      const mp4Object = await this.env.CLIPS_BUCKET.get(job.sourceMp4Key);
      if (!mp4Object) {
        return Response.json(
          {
            status: "failed",
            errorMessage: "Clip MP4 output not found",
          },
          { status: 500 },
        );
      }

      // Same ordering as the real DO: stage MP4 first, then /run — whose
      // start-of-job cleanup must not delete the freshly staged source.
      this.stageSource(job.jobId);
      this.prepareJobWorkspace(job.jobId);
      if (!this.stagedSources.has(job.jobId)) {
        return Response.json(
          {
            status: "failed",
            errorMessage: "Local file path is required for GIF source",
          },
          { status: 500 },
        );
      }

      try {
        if (job.sourceMp4Key.includes("stub-gif-failure")) {
          return Response.json(
            {
              status: "failed",
              errorMessage: "GIF encoding failed (simulated)",
            },
            { status: 500 },
          );
        }

        await this.env.CLIPS_BUCKET.put(job.outputs.gifKey, FAKE_GIF, {
          httpMetadata: { contentType: "image/gif" },
        });

        const head = await this.env.CLIPS_BUCKET.head(job.outputs.gifKey);
        if (!head) {
          return Response.json(
            {
              status: "failed",
              errorMessage: "GIF artifact was not durably stored in R2",
            },
            { status: 500 },
          );
        }

        await markGifComplete(this.env.DB, job.jobId, job.outputs.gifKey);

        return Response.json({
          status: "complete",
          outputs: { gifKey: job.outputs.gifKey },
        });
      } finally {
        this.cleanupJob(job.jobId);
      }
    });
  }

  private async handleDeferredUploadRun(
    job: EncoderJobSpec,
  ): Promise<Response> {
    return this.withRunSlot(async () => {
      await markClipDownloadingIfQueued(this.env.DB, job.jobId);

      // Mirror the real DO/container ordering for upload sources: the DO
      // stages the source via POST /stage-source?job=<id> FIRST, then posts
      // /run, whose start-of-job cleanup must not delete that staged source.
      // Staging eagerly here (not lazily inside the encode) keeps the stub
      // honest about that ordering.
      this.stageSource(job.jobId);
      this.prepareJobWorkspace(job.jobId);
      if (!this.stagedSources.has(job.jobId)) {
        const result = {
          status: "failed",
          errorMessage: "Local file path is required for file source",
        };
        await recordEncoderRunOutcome(this.env, job.jobId, {
          kind: "ok",
          result,
          httpOk: false,
        });
        return Response.json(result, { status: 500 });
      }

      try {
        return await this.runDeferredUploadEncode(job);
      } finally {
        this.cleanupJob(job.jobId);
      }
    });
  }

  private async runDeferredUploadEncode(job: EncoderJobSpec): Promise<Response> {
    for (const status of ["downloading", "encoding", "uploading"] as const) {
      await applyStatusUpdate(this.env, job.jobId, status);
    }

      const slowDeferredCopy = job.source.key.includes("stub-deferred-slow-upload");
      if (slowDeferredCopy) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      const copyFailure = job.source.key.includes("stub-deferred-copy-failure");
      const ambiguousFailure = job.source.key.includes(
        "stub-deferred-ambiguous-failure",
      );

      if (copyFailure) {
        await this.env.CLIPS_BUCKET.put(job.outputs.mp4Key, FAKE_MP4, {
          httpMetadata: { contentType: "video/mp4" },
        });
        const result = {
          status: "failed",
          errorMessage: "Failed to read encoded thumbnail (simulated)",
        };
        await recordEncoderRunOutcome(this.env, job.jobId, {
          kind: "ok",
          result,
          httpOk: false,
        });
        return Response.json(result, { status: 500 });
      }

      await this.env.CLIPS_BUCKET.put(job.outputs.mp4Key, FAKE_MP4, {
        httpMetadata: { contentType: "video/mp4" },
      });
      await this.env.CLIPS_BUCKET.put(job.outputs.thumbnailKey, FAKE_JPEG, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      const [mp4Head, thumbHead] = await Promise.all([
        this.env.CLIPS_BUCKET.head(job.outputs.mp4Key),
        this.env.CLIPS_BUCKET.head(job.outputs.thumbnailKey),
      ]);
      if (!mp4Head || !thumbHead) {
        return Response.json(
          {
            status: "failed",
            errorMessage: "Encoded artifacts were not durably stored in R2",
          },
          { status: 500 },
        );
      }

      if (ambiguousFailure) {
        await recordEncoderRunOutcome(this.env, job.jobId, {
          kind: "complete",
          outputs: job.outputs,
        });
        return new Response("upstream timeout", { status: 502 });
      }

      await recordEncoderRunOutcome(this.env, job.jobId, {
        kind: "complete",
        outputs: job.outputs,
      });

      return Response.json({
        status: "complete",
        outputs: job.outputs,
      });
  }
}
