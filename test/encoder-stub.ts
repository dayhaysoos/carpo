import { DurableObject } from "cloudflare:workers";
import { JOB_SECRET_HEADER } from "../src/auth";
import type { Env } from "../src/env";
import type { EncoderJobSpec } from "../src/types";

const FAKE_MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  0x6d, 0x70, 0x34, 0x31,
]);

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

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

    const job = (await request.json()) as EncoderJobSpec;
    const authHeaders = {
      "Content-Type": "application/json",
      [JOB_SECRET_HEADER]: job.callbackSecret,
    };
    const sourceUrl =
      job.source.type === "youtube" ? job.source.url : "";
    const skipCompleteCallback = sourceUrl.includes(
      "stub-skip-complete-callback",
    );
    const noCallbacksSlowRun = sourceUrl.includes("stub-no-callbacks-slow-run");
    const ambiguousFailure = sourceUrl.includes("stub-ambiguous-failure");
    const verifyWorkerBaseUrl = sourceUrl.includes("stub-verify-worker-base-url");

    if (verifyWorkerBaseUrl) {
      const base = this.env.WORKER_BASE_URL ?? "http://localhost:8787";
      const expectedCallback = `${base}/api/internal/jobs/${job.jobId}/status`;
      const expectedMp4 = `${base}/api/internal/jobs/${job.jobId}/artifacts/mp4`;
      const expectedThumb = `${base}/api/internal/jobs/${job.jobId}/artifacts/thumbnail`;
      const expectedSource = `${base}/api/internal/jobs/${job.jobId}/source`;
      if (
        job.callbackUrl !== expectedCallback ||
        job.artifactUploadUrls.mp4 !== expectedMp4 ||
        job.artifactUploadUrls.thumbnail !== expectedThumb ||
        (job.source.type === "upload" && job.sourceFetchUrl !== expectedSource)
      ) {
        return new Response(
          JSON.stringify({
            error: "WORKER_BASE_URL mismatch",
            got: {
              callbackUrl: job.callbackUrl,
              artifactUploadUrls: job.artifactUploadUrls,
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
        const callbackTarget = job.callbackUrl.startsWith("http")
          ? job.callbackUrl
          : `http://example.com${job.callbackUrl}`;
        await fetch(callbackTarget, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ status }),
        });
      }
    }

    await this.env.CLIPS_BUCKET.put(job.outputs.mp4Key, FAKE_MP4, {
      httpMetadata: { contentType: "video/mp4" },
    });
    await this.env.CLIPS_BUCKET.put(job.outputs.thumbnailKey, FAKE_JPEG, {
      httpMetadata: { contentType: "image/jpeg" },
    });

    if (ambiguousFailure) {
      return new Response("upstream timeout", { status: 502 });
    }

    if (noCallbacksSlowRun) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (!skipCompleteCallback && !noCallbacksSlowRun) {
      const callbackTarget = job.callbackUrl.startsWith("http")
        ? job.callbackUrl
        : `http://example.com${job.callbackUrl}`;
      await fetch(callbackTarget, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ status: "complete" }),
      });
    }

    return Response.json({
      status: "complete",
      outputs: job.outputs,
    });
  }
}
