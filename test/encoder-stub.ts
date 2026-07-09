import { DurableObject } from "cloudflare:workers";
import { JOB_SECRET_HEADER } from "../src/auth";
import type { Env } from "../src/env";
import { applyStatusUpdate } from "../src/jobs";
import { markGifComplete } from "../src/db";
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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__carpo/start") {
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

      if (sourceUrl.includes("stub-container-start-failure")) {
        return new Response("container start failed", { status: 503 });
      }
      return new Response(null, { status: 204 });
    }

    if (
      url.pathname === "/__carpo/renew-activity" ||
      url.pathname === "/__carpo/job-running"
    ) {
      return new Response(null, { status: 204 });
    }

    if (url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }

    const job = (await request.json()) as EncoderJobSpec | GifEncoderJobSpec;
    if ("jobType" in job && job.jobType === "gif") {
      return this.handleGifRun(job);
    }

    const encodeJob = job as EncoderJobSpec;
    const authHeaders = {
      "Content-Type": "application/json",
      [JOB_SECRET_HEADER]: encodeJob.callbackSecret,
    };

    if (encodeJob.source.type === "upload") {
      return this.handleDeferredUploadRun(encodeJob);
    }

    const sourceUrl =
      encodeJob.source.type === "youtube" ? encodeJob.source.url : "";
    const skipCompleteCallback = sourceUrl.includes(
      "stub-skip-complete-callback",
    );
    const noCallbacksSlowRun = sourceUrl.includes("stub-no-callbacks-slow-run");
    const ambiguousFailure = sourceUrl.includes("stub-ambiguous-failure");
    const verifyWorkerBaseUrl = sourceUrl.includes("stub-verify-worker-base-url");

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

    return Response.json({
      status: "complete",
      outputs: encodeJob.outputs,
    });
  }

  private async handleGifRun(
    job: GifEncoderJobSpec,
  ): Promise<Response> {
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
  }

  private async handleDeferredUploadRun(
    job: EncoderJobSpec,
  ): Promise<Response> {
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
      return Response.json(
        {
          status: "failed",
          errorMessage: "Failed to read encoded thumbnail (simulated)",
        },
        { status: 500 },
      );
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
      // Mirror production DO: signal complete after R2 verify, but lose /run
      // response so the worker marks ambiguous-failed and recovers via the signal.
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await applyStatusUpdate(this.env, job.jobId, "complete");
      })();
      return new Response("upstream timeout", { status: 502 });
    }

    await applyStatusUpdate(this.env, job.jobId, "complete");

    return Response.json({
      status: "complete",
      outputs: job.outputs,
    });
  }
}
