import { DurableObject } from "cloudflare:workers";
import type { Env } from "../src/env";
import type { EncoderJobSpec } from "../src/types";

const FAKE_MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  0x6d, 0x70, 0x34, 0x31,
]);

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

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

    if (
      url.pathname === "/__carpo/start" ||
      url.pathname === "/__carpo/renew-activity" ||
      url.pathname === "/__carpo/job-running"
    ) {
      return new Response(null, { status: 204 });
    }

    if (url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }

    const job = (await request.json()) as EncoderJobSpec;

    for (const status of ["downloading", "encoding", "uploading"] as const) {
      const callbackTarget = job.callbackUrl.startsWith("http")
        ? job.callbackUrl
        : `http://example.com${job.callbackUrl}`;
      await fetch(callbackTarget, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    }

    await this.env.CLIPS_BUCKET.put(job.outputs.mp4Key, FAKE_MP4, {
      httpMetadata: { contentType: "video/mp4" },
    });
    await this.env.CLIPS_BUCKET.put(job.outputs.thumbnailKey, FAKE_JPEG, {
      httpMetadata: { contentType: "image/jpeg" },
    });

    return Response.json({ status: "complete" });
  }
}
