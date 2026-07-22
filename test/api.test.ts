import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { JOB_SECRET_HEADER, HELPER_TOKEN_HEADER } from "../src/auth";
import { drainArtifactDeletions } from "../src/artifact-deletions";
import { handleRequest } from "../src/routes";
import { getClipById, outputKeysForClip } from "../src/db";
import { ENCODER_POOL_INSTANCE } from "../src/encoder-pool";
import { dispatchEncodingJob, failClipAmbiguous } from "../src/jobs";
import type { EncoderJobSpec } from "../src/types";
import {
  isUploadSourceExpired,
  sweepExpiredUploadSources,
  UPLOAD_SOURCE_ACCEPT_TTL_MS,
  UPLOAD_SOURCE_SWEEP_TTL_MS,
} from "../src/uploads";
import {
  STUB_AMBIGUOUS_FAILURE_URL,
  STUB_CONTAINER_START_FAILURE_URL,
  STUB_DEFERRED_COPY_FAILURE_UPLOAD_KEY,
  STUB_DEFERRED_AMBIGUOUS_FAILURE_UPLOAD_KEY,
  STUB_DEFERRED_SLOW_UPLOAD_KEY,
  STUB_NO_CALLBACKS_SLOW_RUN_URL,
  STUB_QUEUE_HOLD_URL,
  STUB_SKIP_COMPLETE_CALLBACK_URL,
  STUB_VERIFY_WORKER_BASE_URL,
  STUB_GIF_FAILURE_MP4_KEY,
} from "./encoder-stub";

async function workerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const ctx = createExecutionContext();
  const response = await exports.default.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function workerFetchWithoutWaitingForBackground(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ response: Response; ctx: ExecutionContext }> {
  const request = new Request(input, init);
  const ctx = createExecutionContext();
  const response = await exports.default.fetch(request, env, ctx);
  return { response, ctx };
}

const TEST_HELPER_TOKEN = "test-helper-token";

function helperHeaders(token?: string): Record<string, string> {
  return {
    [HELPER_TOKEN_HEADER]: token ?? env.HELPER_TOKEN ?? TEST_HELPER_TOKEN,
  };
}

async function getLastDispatch(clipId: string): Promise<EncoderJobSpec | null> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    `http://encoder/__carpo/last-dispatch?jobId=${clipId}`,
  );
  return (await response.json()) as EncoderJobSpec | null;
}

async function getMaxEncoderConcurrency(): Promise<number> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch("http://encoder/__carpo/max-concurrency");
  const body = (await response.json()) as { maxConcurrentRuns: number };
  return body.maxConcurrentRuns;
}

async function releaseEncoderQueueHold(): Promise<void> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  await container.fetch("http://encoder/__carpo/queue-hold-release", {
    method: "POST",
  });
}

async function getEncoderJobEvents(jobId: string): Promise<string[]> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    `http://encoder/__carpo/job-events?jobId=${jobId}`,
  );
  const body = (await response.json()) as { events: string[] };
  return body.events;
}

async function getContainerStartCount(): Promise<number> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch("http://encoder/__carpo/container-starts");
  const body = (await response.json()) as { count: number };
  return body.count;
}

async function setPrewarmStartFailure(enabled: boolean): Promise<void> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  await container.fetch("http://encoder/__carpo/set-prewarm-start-failure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

async function uploadTestVideo(): Promise<string> {
  const slotResponse = await workerFetch("http://example.com/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentType: "video/mp4",
      sizeBytes: 128,
      filename: "helper.mp4",
    }),
  });
  expect(slotResponse.status).toBe(200);
  const slot = (await slotResponse.json()) as { key: string; uploadUrl: string };

  const payload = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
  const upload = await workerFetch(slot.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: payload,
  });
  expect(upload.status).toBe(201);
  return slot.key;
}

async function createYoutubeClip(title = "test clip") {
  const response = await workerFetch("http://example.com/api/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      trimStart: 1,
      trimEnd: 5,
      filters: [],
    }),
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; videoId: string };
  const record = await getClipById(env.DB, body.id);
  expect(record?.callback_secret).toBeTruthy();
  return {
    clipId: body.id,
    videoId: body.videoId,
    secret: record!.callback_secret,
  };
}

describe("POST /api/upload-url", () => {
  it("issues an upload URL for supported video types and sizes", async () => {
    const response = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 1024,
        filename: "clip.mp4",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: string;
      uploadUrl: string;
      maxSizeBytes: number;
      contentType: string;
      method: string;
    };
    expect(body.key).toMatch(/^uploads\/[0-9a-f-]+\.mp4$/i);
    expect(body.uploadUrl).toContain(encodeURIComponent(body.key));
    expect(body.maxSizeBytes).toBeGreaterThan(0);
    expect(body.contentType).toBe("video/mp4");
    expect(body.method).toBe("PUT");
  });

  it("pre-warms the encoder container without affecting the response", async () => {
    const startsBefore = await getContainerStartCount();

    const response = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 1024,
        filename: "clip.mp4",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: string;
      uploadUrl: string;
      maxSizeBytes: number;
      contentType: string;
      method: string;
    };
    expect(body.key).toMatch(/^uploads\/[0-9a-f-]+\.mp4$/i);
    expect(body.uploadUrl).toContain(encodeURIComponent(body.key));
    expect(body.maxSizeBytes).toBeGreaterThan(0);
    expect(body.contentType).toBe("video/mp4");
    expect(body.method).toBe("PUT");

    expect(await getContainerStartCount()).toBe(startsBefore + 1);
  });

  it("does not pre-warm the encoder for invalid upload-url requests", async () => {
    const startsBefore = await getContainerStartCount();

    const response = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "image/png",
        sizeBytes: 1024,
      }),
    });

    expect(response.status).toBe(400);
    expect(await getContainerStartCount()).toBe(startsBefore);
  });

  it("returns a normal upload-url response when encoder pre-warm fails", async () => {
    await setPrewarmStartFailure(true);
    try {
      const startsBefore = await getContainerStartCount();

      const response = await workerFetch("http://example.com/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentType: "video/mp4",
          sizeBytes: 1024,
          filename: "clip.mp4",
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        key: string;
        uploadUrl: string;
        maxSizeBytes: number;
        contentType: string;
        method: string;
      };
      expect(body.key).toMatch(/^uploads\/[0-9a-f-]+\.mp4$/i);
      expect(body.uploadUrl).toContain(encodeURIComponent(body.key));
      expect(body.contentType).toBe("video/mp4");
      expect(body.method).toBe("PUT");

      expect(await getContainerStartCount()).toBe(startsBefore + 1);
    } finally {
      await setPrewarmStartFailure(false);
    }
  });

  it("rejects unsupported content types", async () => {
    const response = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "image/png",
        sizeBytes: 1024,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "contentType" }),
      ]),
    );
  });

  it("rejects oversized uploads at issuance time", async () => {
    const response = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 96 * 1024 * 1024,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "sizeBytes" }),
      ]),
    );
  });
});

describe("PUT /api/uploads/:key", () => {
  it("streams an uploaded video into R2 and enforces size/type limits", async () => {
    const slotResponse = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 128,
        filename: "tiny.mp4",
      }),
    });
    expect(slotResponse.status).toBe(200);
    const slot = (await slotResponse.json()) as {
      key: string;
      uploadUrl: string;
    };

    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
    const upload = await workerFetch(slot.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: payload,
    });
    expect(upload.status).toBe(201);

    const stored = await env.CLIPS_BUCKET.get(slot.key);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("rejects non-video content types on upload", async () => {
    const slotResponse = await workerFetch("http://example.com/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 64,
      }),
    });
    const slot = (await slotResponse.json()) as { uploadUrl: string };

    const upload = await workerFetch(slot.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(415);
  });
});

describe("upload source cleanup", () => {
  it("retains the uploaded source object after a job completes", async () => {
    const uploadKey = "uploads/cleanup-on-complete.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "upload cleanup complete",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(lastBody.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
  });

  it("retains the uploaded source object after a confirmed failure", async () => {
    const uploadKey = "uploads/cleanup-on-failure.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "upload cleanup failed",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const record = await getClipById(env.DB, clipId);
    expect(record?.callback_secret).toBeTruthy();

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: record!.callback_secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "encoding failed",
        }),
      },
    );
    expect(fail.status).toBe(200);
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
  });

  it("creates two clips from the same uploadKey end-to-end", async () => {
    const uploadKey = "uploads/shared-source.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const createClip = async (title: string) => {
      const response = await workerFetch("http://example.com/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          source: { type: "upload", key: uploadKey },
          trimStart: 0,
          trimEnd: 5,
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const waitForTerminal = async (clipId: string) => {
      let lastBody: Record<string, unknown> = { status: "queued" };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const statusResponse = await workerFetch(
          `http://example.com/api/clips/${clipId}`,
        );
        expect(statusResponse.status).toBe(200);
        lastBody = (await statusResponse.json()) as Record<string, unknown>;
        if (lastBody.status === "complete" || lastBody.status === "failed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return lastBody;
    };

    const first = await createClip("shared upload A");
    const firstResult = await waitForTerminal(first.id);
    expect(firstResult.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();

    const second = await createClip("shared upload B");
    expect(second.id).not.toBe(first.id);
    const secondResult = await waitForTerminal(second.id);
    expect(secondResult.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
  });
});

describe("upload source sweep", () => {
  it("isUploadSourceExpired rejects at the 24h accept TTL", () => {
    const uploaded = new Date("2026-01-01T12:00:00Z");
    const beforeExpiry = new Date(
      uploaded.getTime() + UPLOAD_SOURCE_ACCEPT_TTL_MS - 1,
    );
    const atExpiry = new Date(
      uploaded.getTime() + UPLOAD_SOURCE_ACCEPT_TTL_MS,
    );
    const afterExpiry = new Date(
      uploaded.getTime() + UPLOAD_SOURCE_ACCEPT_TTL_MS + 1,
    );

    expect(isUploadSourceExpired(uploaded, beforeExpiry)).toBe(false);
    expect(isUploadSourceExpired(uploaded, atExpiry)).toBe(true);
    expect(isUploadSourceExpired(uploaded, afterExpiry)).toBe(true);
  });

  it("sweep TTL grants a grace hour past the accept TTL", () => {
    const uploaded = new Date("2026-01-01T12:00:00Z");
    // Aged between 24h and 25h: rejected for new clips, but not swept.
    const withinGrace = new Date(
      uploaded.getTime() + UPLOAD_SOURCE_ACCEPT_TTL_MS + 30 * 60 * 1000,
    );
    expect(isUploadSourceExpired(uploaded, withinGrace)).toBe(true);
    expect(
      isUploadSourceExpired(uploaded, withinGrace, UPLOAD_SOURCE_SWEEP_TTL_MS),
    ).toBe(false);

    const pastGrace = new Date(
      uploaded.getTime() + UPLOAD_SOURCE_SWEEP_TTL_MS,
    );
    expect(
      isUploadSourceExpired(uploaded, pastGrace, UPLOAD_SOURCE_SWEEP_TTL_MS),
    ).toBe(true);
  });

  it("sweepExpiredUploadSources retains freshly uploaded objects", async () => {
    const uploadKey = "uploads/sweep-fresh.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const deleted = await sweepExpiredUploadSources(env.CLIPS_BUCKET);
    expect(deleted).toBe(0);
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
  });

  it("sweepExpiredUploadSources retains objects aged between 24h and 25h", async () => {
    const graceKey = "uploads/sweep-grace-keep.mp4";
    await env.CLIPS_BUCKET.put(graceKey, new Uint8Array([8, 9, 10, 11]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const object = await env.CLIPS_BUCKET.head(graceKey);
    expect(object).not.toBeNull();
    // Pretend the object is 24h30m old: past accept TTL, inside sweep grace.
    const now = new Date(
      object!.uploaded.getTime() +
        UPLOAD_SOURCE_ACCEPT_TTL_MS +
        30 * 60 * 1000,
    );

    await sweepExpiredUploadSources(env.CLIPS_BUCKET, { now });
    expect(await env.CLIPS_BUCKET.get(graceKey)).not.toBeNull();
  });

  it("sweepExpiredUploadSources deletes objects older than the sweep TTL", async () => {
    const staleKey = "uploads/sweep-stale-delete.mp4";
    await env.CLIPS_BUCKET.put(staleKey, new Uint8Array([4, 5, 6, 7]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const staleObject = await env.CLIPS_BUCKET.head(staleKey);
    expect(staleObject).not.toBeNull();
    const now = new Date(
      staleObject!.uploaded.getTime() + UPLOAD_SOURCE_SWEEP_TTL_MS + 60_000,
    );

    const deleted = await sweepExpiredUploadSources(env.CLIPS_BUCKET, { now });
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await env.CLIPS_BUCKET.get(staleKey)).toBeNull();
  });

  it("sweepExpiredUploadSources retains an expired reusable video source", async () => {
    const retainedKey = "uploads/sweep-retained-video.mp4";
    await env.CLIPS_BUCKET.put(retainedKey, new Uint8Array([12, 13, 14, 15]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    const object = await env.CLIPS_BUCKET.head(retainedKey);
    const now = new Date(
      object!.uploaded.getTime() + UPLOAD_SOURCE_SWEEP_TTL_MS + 60_000,
    );

    const deleted = await sweepExpiredUploadSources(env.CLIPS_BUCKET, {
      now,
      shouldRetain: async (key) => key === retainedKey,
    });

    expect(deleted).toBe(0);
    expect(await env.CLIPS_BUCKET.get(retainedKey)).not.toBeNull();
  });
});

describe("deferred upload artifact staging", () => {
  it("completes upload-source jobs only after deferred artifacts land in R2", async () => {
    const uploadKey = "uploads/stub-deferred-success.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "deferred upload success",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
        filters: [],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(lastBody.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("complete");
    expect(persisted?.output_mp4_key).toBe(keys.mp4Key);
    expect(persisted?.output_thumbnail_key).toBe(keys.thumbnailKey);
  });

  it("fails upload-source jobs when deferred artifact copy fails", async () => {
    const uploadKey = STUB_DEFERRED_COPY_FAILURE_UPLOAD_KEY;
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "deferred upload copy failure",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
        filters: [],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(lastBody.status).toBe("failed");
    expect(lastBody.errorMessage).toBeTruthy();

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure_mode).toBe("confirmed");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
  });

  it("reports uploading during deferred artifact copy", async () => {
    const uploadKey = STUB_DEFERRED_SLOW_UPLOAD_KEY;
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const { response, ctx } = await workerFetchWithoutWaitingForBackground(
      "http://example.com/api/clips",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "deferred upload slow copy",
          source: { type: "upload", key: uploadKey },
          trimStart: 0,
          trimEnd: 5,
          filters: [],
        }),
      },
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;

    const seenStatuses = new Set<string>();
    let lastBody: Record<string, unknown> = { status: "queued" };

    const dispatchDone = waitOnExecutionContext(ctx);
    while (true) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (typeof lastBody.status === "string") {
        seenStatuses.add(lastBody.status);
      }
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await Promise.race([
        dispatchDone,
        new Promise((resolve) => setTimeout(resolve, 10)),
      ]);
    }

    await dispatchDone;

    expect(seenStatuses.has("uploading")).toBe(true);
    expect(lastBody.status).toBe("complete");
  });

  it("completes deferred upload jobs from the DO even when /run returns 502", async () => {
    const uploadKey = STUB_DEFERRED_AMBIGUOUS_FAILURE_UPLOAD_KEY;
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "deferred DO authority",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
        filters: [],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let recovered: Awaited<ReturnType<typeof getClipById>> = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      recovered = await getClipById(env.DB, clipId);
      if (recovered?.status === "complete") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(recovered?.status).toBe("complete");
    expect(recovered?.failure_mode).toBeNull();
    expect(recovered?.output_mp4_key).toBe(keys.mp4Key);
    expect(recovered?.output_thumbnail_key).toBe(keys.thumbnailKey);
    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
  });
});

describe("POST /api/clips", () => {
  it("creates a clip job for a valid YouTube URL and trim window", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "test clip",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      status: string;
      title: string;
      source: { type: string; url: string };
      trimStart: number;
      trimEnd: number;
      filters: unknown[];
      outputs: { mp4: string | null; thumbnail: string | null };
    };

    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.status).toBe("queued");
    expect(body.title).toBe("test clip");
    expect(body.source).toEqual({
      type: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(body.trimStart).toBe(1);
    expect(body.trimEnd).toBe(5);
    expect(body.filters).toEqual([]);
    expect(body.quality).toBe("1080p");
    expect(body.outputs.mp4).toBeNull();
    expect(body.outputs.thumbnail).toBeNull();
  });

  it("defaults quality to 1080p when omitted", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "default quality",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { quality: string };
    expect(body.quality).toBe("1080p");
  });

  it("accepts and persists an explicit 720p quality", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "720p clip",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 1,
        trimEnd: 4,
        quality: "720p",
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; quality: string };
    expect(body.quality).toBe("720p");

    const record = await getClipById(env.DB, body.id);
    expect(record?.quality).toBe("720p");
  });

  it("rejects invalid quality values", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "bad quality",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 0,
        trimEnd: 5,
        quality: "4K",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "quality",
          message: "quality must be '720p' or '1080p'",
        }),
      ]),
    );
  });

  it("rejects invalid YouTube URLs", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "bad url",
        source: { type: "youtube", url: "https://example.com/not-youtube" },
        trimStart: 0,
        trimEnd: 5,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "source.url" }),
      ]),
    );
  });

  it("rejects trim windows longer than the max clip length", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "too long",
        source: {
          type: "youtube",
          url: "https://youtu.be/dQw4w9WgXcQ",
        },
        trimStart: 0,
        trimEnd: 61,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "trim",
          message: expect.stringContaining("60 seconds"),
        }),
      ]),
    );
  });

  it("accepts upload sources when the object exists in R2", async () => {
    const uploadKey = "uploads/test-source.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "upload clip",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      source: { type: string; key: string };
    };
    expect(body.source).toEqual({ type: "upload", key: uploadKey });
  });

  it("rejects upload sources when the object is missing from R2", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "missing upload",
        source: { type: "upload", key: "uploads/does-not-exist.mp4" },
        trimStart: 0,
        trimEnd: 5,
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Upload not found");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "source.key" }),
      ]),
    );
  });

  it("rejects invalid upload keys", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "bad upload key",
        source: { type: "upload", key: "clips/not-an-upload.mp4" },
        trimStart: 0,
        trimEnd: 5,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "source.key" }),
      ]),
    );
  });

  it("accepts a caption filter and persists it on the clip record", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "caption clip",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [{ type: "caption", text: "Hello world" }],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      caption: string | null;
      filters: Array<{ type: string; text: string }>;
    };
    expect(body.caption).toBe("Hello world");
    expect(body.filters).toEqual([{ type: "caption", text: "Hello world" }]);

    const persisted = await getClipById(env.DB, body.id);
    expect(persisted?.caption).toBe("Hello world");
    expect(persisted?.filters_json).toBe(
      JSON.stringify([{ type: "caption", text: "Hello world" }]),
    );
  });

  it("rejects multiple caption filters", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "dual caption",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 0,
        trimEnd: 5,
        filters: [
          { type: "caption", text: "First caption" },
          { type: "caption", text: "Second caption" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "filters[1]",
          message: "only one caption filter is supported",
        }),
      ]),
    );
  });

  it("rejects over-length caption text", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "long caption",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 0,
        trimEnd: 5,
        filters: [{ type: "caption", text: "x".repeat(201) }],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "filters[0].text",
          message: expect.stringContaining("200"),
        }),
      ]),
    );
  });

  it("rejects unknown filter types", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "bad filter",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        trimStart: 0,
        trimEnd: 5,
        filters: [{ type: "noop" }],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "filters[0].type",
          message: expect.stringContaining("Unknown filter type"),
        }),
      ]),
    );
  });
});

describe("internal job callbacks", () => {
  it("accepts status updates with the job secret and rejects missing or wrong secrets", async () => {
    const { clipId, secret } = await createYoutubeClip("auth clip");

    const authorized = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "encoding" }),
      },
    );
    expect(authorized.status).toBe(200);
    const authorizedBody = (await authorized.json()) as { status: string };
    expect(authorizedBody.status).toBe("encoding");

    const missingSecret = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "uploading" }),
      },
    );
    expect(missingSecret.status).toBe(401);

    const wrongSecret = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: `${secret}-wrong`,
        },
        body: JSON.stringify({ status: "uploading" }),
      },
    );
    expect(wrongSecret.status).toBe(401);
  });

  it("requires the job secret for artifact uploads", async () => {
    const { clipId, secret } = await createYoutubeClip("artifact auth clip");
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);

    const unauthorized = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: fakeMp4,
      },
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    expect(authorized.status).toBe(204);
  });
});

describe("failed job artifact cleanup", () => {
  it("deletes partial artifacts when a job transitions to failed", async () => {
    const { clipId, secret } = await createYoutubeClip("cleanup clip");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);

    const upload = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    expect(upload.status).toBe(204);

    const beforeFailure = await env.CLIPS_BUCKET.get(keys.mp4Key);
    expect(beforeFailure).not.toBeNull();

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "thumbnail upload failed",
        }),
      },
    );
    expect(fail.status).toBe(200);

    const failedClip = await getClipById(env.DB, clipId);
    expect(failedClip?.status).toBe("failed");

    const mp4After = await env.CLIPS_BUCKET.get(keys.mp4Key);
    const thumbAfter = await env.CLIPS_BUCKET.get(keys.thumbnailKey);
    expect(mp4After).toBeNull();
    expect(thumbAfter).toBeNull();

    const clipResponse = await workerFetch(
      `http://example.com/api/clips/${clipId}`,
    );
    expect(clipResponse.status).toBe(200);
    const clipBody = (await clipResponse.json()) as {
      status: string;
      errorMessage: string;
      outputs: { mp4: string | null; thumbnail: string | null };
    };
    expect(clipBody.status).toBe("failed");
    expect(clipBody.errorMessage).toBe("thumbnail upload failed");
    expect(clipBody.outputs.mp4).toBeNull();
    expect(clipBody.outputs.thumbnail).toBeNull();
  });
});

describe("terminal status stickiness", () => {
  it("does not downgrade a complete clip to failed", async () => {
    const { clipId, secret } = await createYoutubeClip("sticky complete");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    const complete = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );
    expect(complete.status).toBe(200);

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/thumbnail`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeJpeg,
      },
    );

    const beforeFailure = await getClipById(env.DB, clipId);
    expect(beforeFailure?.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "post-complete failure should be ignored",
        }),
      },
    );
    expect(fail.status).toBe(200);
    const failBody = (await fail.json()) as { status: string; errorMessage: string | null };
    expect(failBody.status).toBe("complete");
    expect(failBody.errorMessage).toBeNull();

    const afterFailure = await getClipById(env.DB, clipId);
    expect(afterFailure?.status).toBe("complete");
    expect(afterFailure?.error_message).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();
  });

  it("recovers an ambiguous-failed clip when a late complete callback arrives", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "ambiguous recovery",
        source: {
          type: "youtube",
          url: STUB_AMBIGUOUS_FAILURE_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let failedRecord: Awaited<ReturnType<typeof getClipById>> = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      failedRecord = await getClipById(env.DB, clipId);
      if (failedRecord?.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(failedRecord?.status).toBe("failed");
    expect(failedRecord?.failure_mode).toBe("ambiguous");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();

    const complete = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: failedRecord!.callback_secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );
    expect(complete.status).toBe(200);
    const completeBody = (await complete.json()) as {
      status: string;
      errorMessage: string | null;
      outputs: { mp4: string | null; thumbnail: string | null };
    };
    expect(completeBody.status).toBe("complete");
    expect(completeBody.errorMessage).toBeNull();
    expect(completeBody.outputs.mp4).toBe(`/artifacts/${keys.mp4Key}`);
    expect(completeBody.outputs.thumbnail).toBe(`/artifacts/${keys.thumbnailKey}`);

    const recovered = await getClipById(env.DB, clipId);
    expect(recovered?.status).toBe("complete");
    expect(recovered?.failure_mode).toBeNull();
    expect(recovered?.output_mp4_key).toBe(keys.mp4Key);
    expect(recovered?.output_thumbnail_key).toBe(keys.thumbnailKey);
  });

  it("confirms an ambiguous-failed clip when a late failed callback arrives", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "ambiguous to confirmed failure",
        source: {
          type: "youtube",
          url: STUB_AMBIGUOUS_FAILURE_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let failedRecord: Awaited<ReturnType<typeof getClipById>> = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      failedRecord = await getClipById(env.DB, clipId);
      if (failedRecord?.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(failedRecord?.status).toBe("failed");
    expect(failedRecord?.failure_mode).toBe("ambiguous");
    expect(failedRecord?.error_message).toContain("upstream timeout");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: failedRecord!.callback_secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "encoder reported definitive failure",
        }),
      },
    );
    expect(fail.status).toBe(200);
    const failBody = (await fail.json()) as {
      status: string;
      errorMessage: string;
      outputs: { mp4: string | null; thumbnail: string | null };
    };
    expect(failBody.status).toBe("failed");
    expect(failBody.errorMessage).toBe("encoder reported definitive failure");
    expect(failBody.outputs.mp4).toBeNull();
    expect(failBody.outputs.thumbnail).toBeNull();

    const confirmed = await getClipById(env.DB, clipId);
    expect(confirmed?.status).toBe("failed");
    expect(confirmed?.failure_mode).toBe("confirmed");
    expect(confirmed?.error_message).toBe("encoder reported definitive failure");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();
  });

  it("keeps a confirmed-failed clip failed when a late complete callback arrives", async () => {
    const { clipId, secret } = await createYoutubeClip("confirmed sticky failed");
    const keys = outputKeysForClip(clipId);

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "encoder reported failure",
        }),
      },
    );
    expect(fail.status).toBe(200);

    const failedRecord = await getClipById(env.DB, clipId);
    expect(failedRecord?.status).toBe("failed");
    expect(failedRecord?.failure_mode).toBe("confirmed");

    const complete = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );
    expect(complete.status).toBe(200);
    const completeBody = (await complete.json()) as {
      status: string;
      errorMessage: string;
      outputs: { mp4: string | null; thumbnail: string | null };
    };
    expect(completeBody.status).toBe("failed");
    expect(completeBody.errorMessage).toBe("encoder reported failure");
    expect(completeBody.outputs.mp4).toBeNull();
    expect(completeBody.outputs.thumbnail).toBeNull();

    const afterComplete = await getClipById(env.DB, clipId);
    expect(afterComplete?.status).toBe("failed");
    expect(afterComplete?.failure_mode).toBe("confirmed");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();
  });

  it("serializes YouTube blocked failure messages in clip responses", async () => {
    const blockedMessage =
      "YouTube is blocking downloads from this server. Try uploading the video file instead.";
    const { clipId, secret } = await createYoutubeClip("youtube blocked");

    const fail = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: blockedMessage,
        }),
      },
    );
    expect(fail.status).toBe(200);

    const list = await workerFetch("http://example.com/api/clips");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      clips: Array<{
        id: string;
        status: string;
        errorMessage: string | null;
      }>;
    };
    const clip = body.clips.find((item) => item.id === clipId);
    expect(clip).toMatchObject({
      status: "failed",
      errorMessage: blockedMessage,
    });

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure_mode).toBe("confirmed");
    expect(persisted?.error_message).toBe(blockedMessage);
  });
});

describe("authoritative /run response handling", () => {
  async function waitForTerminalStatus(clipId: string) {
    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        return lastBody;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return lastBody;
  }

  it("advances to downloading after dispatch when encoder sends no callbacks", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "optimistic downloading",
        source: {
          type: "youtube",
          url: STUB_NO_CALLBACKS_SLOW_RUN_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let sawDownloading = false;
    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "downloading") {
        sawDownloading = true;
      }
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(sawDownloading).toBe(true);
    expect(lastBody.status).not.toBe("queued");
    expect(lastBody.status).toBe("complete");

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("complete");
    expect(persisted?.output_mp4_key).toBe(keys.mp4Key);
    expect(persisted?.output_thumbnail_key).toBe(keys.thumbnailKey);
  });

  it("marks a clip complete from the /run response when no complete callback arrives", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "run response authority",
        source: {
          type: "youtube",
          url: STUB_SKIP_COMPLETE_CALLBACK_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    const finalBody = await waitForTerminalStatus(clipId);
    expect(finalBody.status).toBe("complete");

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("complete");
    expect(persisted?.output_mp4_key).toBe(keys.mp4Key);
    expect(persisted?.output_thumbnail_key).toBe(keys.thumbnailKey);
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();
  });

  it("keeps a clip complete when failClipAmbiguous runs after a complete callback", async () => {
    const { clipId, secret } = await createYoutubeClip(
      "complete then ambiguous failure",
    );
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/thumbnail`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeJpeg,
      },
    );

    const complete = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );
    expect(complete.status).toBe(200);

    const completedRecord = await getClipById(env.DB, clipId);
    expect(completedRecord?.status).toBe("complete");
    expect(completedRecord?.output_mp4_key).toBe(keys.mp4Key);
    expect(completedRecord?.output_thumbnail_key).toBe(keys.thumbnailKey);

    await failClipAmbiguous(env, clipId, "upstream timeout");

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("complete");
    expect(persisted?.failure_mode).toBeNull();
    expect(persisted?.error_message).toBeNull();
    expect(persisted?.output_mp4_key).toBe(keys.mp4Key);
    expect(persisted?.output_thumbnail_key).toBe(keys.thumbnailKey);
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();
  });

  it("preserves artifacts when /run outcome is ambiguous", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "ambiguous failure",
        source: {
          type: "youtube",
          url: STUB_AMBIGUOUS_FAILURE_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    const finalBody = await waitForTerminalStatus(clipId);
    expect(finalBody.status).toBe("failed");

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure_mode).toBe("ambiguous");
    expect(persisted?.error_message).toBeTruthy();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();
  });

  it("marks pre-/run container start failures as confirmed", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "container start failure",
        source: {
          type: "youtube",
          url: STUB_CONTAINER_START_FAILURE_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    const finalBody = await waitForTerminalStatus(clipId);
    expect(finalBody.status).toBe("failed");

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure_mode).toBe("confirmed");
    expect(persisted?.error_message).toBeTruthy();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();
  });
});

describe("WORKER_BASE_URL precedence", () => {
  it("uses configured WORKER_BASE_URL in container job URLs over the request origin", async () => {
    const response = await workerFetch("http://localhost:9999/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "worker base url precedence",
        source: {
          type: "youtube",
          url: STUB_VERIFY_WORKER_BASE_URL,
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(lastBody.status).toBe("complete");
  });
});

describe("clip job lifecycle", () => {
  it("advances through lifecycle states and completes with R2 artifacts", async () => {
    const createResponse = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "lifecycle clip",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        },
        trimStart: 2,
        trimEnd: 7,
        filters: [],
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string };
    const clipId = created.id;

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const finalStatus = lastBody.status as string;

    expect(finalStatus).toBe("complete");
    expect(lastBody).toMatchObject({
      id: clipId,
      title: "lifecycle clip",
      status: "complete",
      errorMessage: null,
      filters: [],
    });

    const outputs = lastBody.outputs as {
      mp4: string;
      thumbnail: string;
    };
    expect(outputs.mp4).toBe(`/artifacts/clips/${clipId}/clip.mp4`);
    expect(outputs.thumbnail).toBe(`/artifacts/clips/${clipId}/thumbnail.jpg`);

    const mp4Response = await workerFetch(`http://example.com${outputs.mp4}`);
    expect(mp4Response.status).toBe(200);
    expect(mp4Response.headers.get("content-type")).toContain("video/mp4");

    const thumbResponse = await workerFetch(
      `http://example.com${outputs.thumbnail}`,
    );
    expect(thumbResponse.status).toBe(200);
    expect(thumbResponse.headers.get("content-type")).toContain("image/jpeg");

    const persisted = await env.DB.prepare("SELECT * FROM clips WHERE id = ?")
      .bind(clipId)
      .first<{ status: string; output_mp4_key: string; output_thumbnail_key: string }>();

    expect(persisted?.status).toBe("complete");
    expect(persisted?.output_mp4_key).toBe(`clips/${clipId}/clip.mp4`);
    expect(persisted?.output_thumbnail_key).toBe(`clips/${clipId}/thumbnail.jpg`);
  });
});

describe("dispatchEncodingJob", () => {
  it("logs and returns when the clip record is missing", async () => {
    const missingClipId = crypto.randomUUID();
    expect(await getClipById(env.DB, missingClipId)).toBeNull();

    await expect(
      dispatchEncodingJob(
        env,
        missingClipId,
        {
          title: "ghost clip",
          source: {
            type: "youtube",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          },
          trimStart: 1,
          trimEnd: 5,
          filters: [],
        },
        "http://example.com",
      ),
    ).resolves.toBeUndefined();

    expect(await getClipById(env.DB, missingClipId)).toBeNull();
  });
});

describe("warm encoder queue", () => {
  it("serializes back-to-back clip dispatches on the shared encoder instance", async () => {
    const first = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "queue serialize first",
        source: { type: "youtube", url: STUB_QUEUE_HOLD_URL },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    expect(first.status).toBe(201);
    const firstClip = (await first.json()) as { id: string };

    const second = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "queue serialize second",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=queue-serialize-second",
        },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    expect(second.status).toBe(201);
    const secondClip = (await second.json()) as { id: string };

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const firstRecord = await getClipById(env.DB, firstClip.id);
      if (firstRecord?.status === "downloading") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const secondWhileFirstHeld = await getClipById(env.DB, secondClip.id);
    expect(secondWhileFirstHeld?.status).toBe("queued");

    await releaseEncoderQueueHold();

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const firstRecord = await getClipById(env.DB, firstClip.id);
      const secondRecord = await getClipById(env.DB, secondClip.id);
      if (
        firstRecord?.status === "complete" &&
        secondRecord?.status === "complete"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect((await getClipById(env.DB, firstClip.id))?.status).toBe("complete");
    expect((await getClipById(env.DB, secondClip.id))?.status).toBe("complete");
    expect(await getMaxEncoderConcurrency()).toBe(1);
  });

  it("serializes a GIF export behind an in-flight clip job", async () => {
    const clip = await createYoutubeClip("queue gif behind clip");
    const keys = outputKeysForClip(clip.clipId);

    await env.CLIPS_BUCKET.put(keys.mp4Key, new Uint8Array([0x00, 0x00, 0x00, 0x1c]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    await env.CLIPS_BUCKET.put(keys.thumbnailKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      httpMetadata: { contentType: "image/jpeg" },
    });
    await env.DB.prepare(
      `UPDATE clips
       SET status = 'complete',
           output_mp4_key = ?,
           output_thumbnail_key = ?
       WHERE id = ?`,
    )
      .bind(keys.mp4Key, keys.thumbnailKey, clip.clipId)
      .run();

    const held = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "queue gif blocker",
        source: { type: "youtube", url: STUB_QUEUE_HOLD_URL },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    expect(held.status).toBe(201);
    const heldClip = (await held.json()) as { id: string };

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const record = await getClipById(env.DB, heldClip.id);
      if (record?.status === "downloading") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const gifResponse = await workerFetch(
      `http://example.com/api/clips/${clip.clipId}/gif`,
      { method: "POST" },
    );
    expect(gifResponse.status).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await getMaxEncoderConcurrency()).toBe(1);

    await releaseEncoderQueueHold();

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const record = await getClipById(env.DB, clip.clipId);
      if (record?.output_gif_key) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect((await getClipById(env.DB, clip.clipId))?.output_gif_key).toBe(keys.gifKey);
    expect(await getMaxEncoderConcurrency()).toBe(1);
  });

  it("stages an upload source before run-start cleanup and completes the clip", async () => {
    const uploadKey = "uploads/stage-order-check.mp4";
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "stage-before-run ordering",
        source: { type: "upload", key: uploadKey },
        trimStart: 0,
        trimEnd: 5,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // The clip only completes if the freshly staged source survived the
    // run-start defensive cleanup (the production-breaking Bugbot finding).
    expect(lastBody.status).toBe("complete");

    const events = await getEncoderJobEvents(clipId);
    expect(events.indexOf("stage-source")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("run-start")).toBeGreaterThan(
      events.indexOf("stage-source"),
    );
    expect(events[events.length - 1]).toBe("cleanup");
  });
});

describe("GET /api/clips/:id", () => {
  it("returns 404 for unknown clips", async () => {
    const response = await workerFetch(
      "http://example.com/api/clips/does-not-exist",
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/clips", () => {
  it("returns clips newest-first with correct shapes for complete, failed, and in-flight clips", async () => {
    const complete = await createYoutubeClip("complete list clip");
    const failed = await createYoutubeClip("failed list clip");
    const inFlight = await createYoutubeClip("in-flight list clip");

    const completeKeys = outputKeysForClip(complete.clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await workerFetch(
      `http://example.com/api/internal/jobs/${complete.clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: complete.secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${complete.clipId}/artifacts/thumbnail`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          [JOB_SECRET_HEADER]: complete.secret,
        },
        body: fakeJpeg,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${complete.clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: complete.secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );

    await workerFetch(
      `http://example.com/api/internal/jobs/${failed.clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: failed.secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "encoding blew up",
        }),
      },
    );

    await workerFetch(
      `http://example.com/api/internal/jobs/${inFlight.clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: inFlight.secret,
        },
        body: JSON.stringify({ status: "encoding" }),
      },
    );

    const response = await workerFetch("http://example.com/api/clips");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      clips: Array<{
        id: string;
        title: string;
        status: string;
        caption: string | null;
        outputs: { mp4: string | null; thumbnail: string | null };
        createdAt: string;
        errorMessage: string | null;
      }>;
      total: number;
      limit: number;
      offset: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    const ids = body.clips.map((clip) => clip.id);
    expect(ids).toEqual(expect.arrayContaining([
      complete.clipId,
      failed.clipId,
      inFlight.clipId,
    ]));

    for (let i = 1; i < body.clips.length; i += 1) {
      expect(body.clips[i - 1].createdAt >= body.clips[i].createdAt).toBe(true);
    }

    const completeClip = body.clips.find((clip) => clip.id === complete.clipId);
    expect(completeClip).toMatchObject({
      title: "complete list clip",
      status: "complete",
      errorMessage: null,
    });
    expect(completeClip?.outputs.mp4).toBe(`/artifacts/${completeKeys.mp4Key}`);
    expect(completeClip?.outputs.thumbnail).toBe(
      `/artifacts/${completeKeys.thumbnailKey}`,
    );
    expect(completeClip?.createdAt).toBeTruthy();

    const failedClip = body.clips.find((clip) => clip.id === failed.clipId);
    expect(failedClip).toMatchObject({
      title: "failed list clip",
      status: "failed",
      errorMessage: "encoding blew up",
    });
    expect(failedClip?.outputs.mp4).toBeNull();
    expect(failedClip?.outputs.thumbnail).toBeNull();

    const inFlightClip = body.clips.find((clip) => clip.id === inFlight.clipId);
    expect(inFlightClip).toMatchObject({
      title: "in-flight list clip",
      status: "encoding",
    });
    expect(inFlightClip?.outputs.mp4).toBeNull();
    expect(inFlightClip?.outputs.thumbnail).toBeNull();
  });

  it("supports limit and offset pagination", async () => {
    await createYoutubeClip("page clip a");
    await createYoutubeClip("page clip b");
    await createYoutubeClip("page clip c");

    const page = await workerFetch("http://example.com/api/clips?limit=2&offset=1");
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      clips: Array<{ id: string }>;
      total: number;
      limit: number;
      offset: number;
    };

    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.clips).toHaveLength(2);
    expect(body.total).toBeGreaterThanOrEqual(3);
  });
});

describe("source video library", () => {
  it("retains failed artifact cleanup work for a later retry", async () => {
    const key = `clips/${crypto.randomUUID()}/clip.mp4`;
    await env.DB.prepare(
      "INSERT INTO artifact_deletions (key) VALUES (?)",
    )
      .bind(key)
      .run();

    let shouldFail = true;
    const bucket = {
      delete: async () => {
        if (shouldFail) throw new Error("temporary R2 failure");
      },
    } as unknown as R2Bucket;

    await drainArtifactDeletions(env.DB, bucket);
    const queued = await env.DB.prepare(
      "SELECT attempts FROM artifact_deletions WHERE key = ?",
    )
      .bind(key)
      .first<{ attempts: number }>();
    expect(queued?.attempts).toBe(1);

    shouldFail = false;
    await drainArtifactDeletions(env.DB, bucket);
    const afterRetry = await env.DB.prepare(
      "SELECT key FROM artifact_deletions WHERE key = ?",
    )
      .bind(key)
      .first();
    expect(afterRetry).toBeNull();
  });

  it("archives and restores a video without deleting its clips", async () => {
    const created = await createYoutubeClip("archive lifecycle clip");

    const archivedResponse = await workerFetch(
      `http://example.com/api/videos/${created.videoId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(archivedResponse.status).toBe(200);

    const activeResponse = await workerFetch("http://example.com/api/videos");
    const active = (await activeResponse.json()) as {
      videos: Array<{ id: string }>;
    };
    expect(active.videos.some((video) => video.id === created.videoId)).toBe(
      false,
    );

    const archivedListResponse = await workerFetch(
      "http://example.com/api/videos?archived=true",
    );
    const archived = (await archivedListResponse.json()) as {
      videos: Array<{ id: string; archivedAt: string | null }>;
    };
    expect(
      archived.videos.find((video) => video.id === created.videoId),
    ).toMatchObject({
      id: created.videoId,
      archivedAt: expect.any(String),
    });

    const detailResponse = await workerFetch(
      `http://example.com/api/videos/${created.videoId}`,
    );
    const detail = (await detailResponse.json()) as {
      clips: Array<{ id: string }>;
    };
    expect(detail.clips.some((clip) => clip.id === created.clipId)).toBe(true);

    const restoredResponse = await workerFetch(
      `http://example.com/api/videos/${created.videoId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      },
    );
    expect(restoredResponse.status).toBe(200);
  });

  it("creates another clip from a retained uploaded video", async () => {
    const uploadKey = await uploadTestVideo();
    const firstResponse = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "first upload clip",
        sourceTitle: "Reusable upload.mp4",
        source: { type: "upload", key: uploadKey },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as {
      id: string;
      videoId: string;
    };

    const sourceResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}/source`,
    );
    expect(sourceResponse.status).toBe(200);
    expect(sourceResponse.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await sourceResponse.arrayBuffer())).toEqual(
      new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
    );

    const rangeResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}/source`,
      { headers: { Range: "bytes=4-7" } },
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("content-range")).toBe("bytes 4-7/8");
    expect(new Uint8Array(await rangeResponse.arrayBuffer())).toEqual(
      new Uint8Array([0x66, 0x74, 0x79, 0x70]),
    );

    const secondResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "second upload clip",
          trimStart: 5,
          trimEnd: 8,
          filters: [],
          quality: "720p",
        }),
      },
    );
    expect(secondResponse.status).toBe(201);
    const second = (await secondResponse.json()) as {
      id: string;
      videoId: string;
      source: { type: string; key: string };
    };
    expect(second).toMatchObject({
      videoId: first.videoId,
      source: { type: "upload", key: uploadKey },
    });

    const detailResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}`,
    );
    const detail = (await detailResponse.json()) as {
      video: { clipCount: number };
      clips: Array<{ id: string }>;
    };
    expect(detail.video.clipCount).toBe(2);
    expect(detail.clips.map((clip) => clip.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });

  it("keeps reused legacy YouTube URLs attached to their existing video", async () => {
    const legacyVideoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (id, source_type, source_ref, title)
       VALUES (?, 'youtube', ?, ?)`,
    )
      .bind(
        legacyVideoId,
        "https://youtu.be/legacyGrouping01?t=30",
        "Legacy YouTube video",
      )
      .run();

    const response = await workerFetch(
      `http://example.com/api/videos/${legacyVideoId}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "legacy source clip",
          trimStart: 1,
          trimEnd: 4,
          filters: [],
        }),
      },
    );

    expect(response.status).toBe(201);
    const clip = (await response.json()) as { videoId: string };
    expect(clip.videoId).toBe(legacyVideoId);

    const detailResponse = await workerFetch(
      `http://example.com/api/videos/${legacyVideoId}`,
    );
    const detail = (await detailResponse.json()) as {
      video: { clipCount: number };
    };
    expect(detail.video.clipCount).toBe(1);
  });

  it("groups alternate YouTube URL forms into one video", async () => {
    const createForUrl = async (url: string, title: string) => {
      const response = await workerFetch("http://example.com/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          sourceTitle: "Grouping test source",
          source: { type: "youtube", url },
          trimStart: 1,
          trimEnd: 4,
          filters: [],
        }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string; videoId: string }>;
    };

    const first = await createForUrl(
      "https://www.youtube.com/watch?v=groupingTest01&utm_source=test",
      "grouped clip one",
    );
    const second = await createForUrl(
      "https://youtu.be/groupingTest01?t=30",
      "grouped clip two",
    );

    expect(second.videoId).toBe(first.videoId);

    const listResponse = await workerFetch("http://example.com/api/videos");
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      videos: Array<{
        id: string;
        title: string;
        clipCount: number;
        thumbnail: string | null;
      }>;
    };
    const video = list.videos.find((item) => item.id === first.videoId);

    expect(video).toMatchObject({
      title: "Grouping test source",
      clipCount: 2,
    });
    expect(video?.thumbnail).toBe(
      "https://i.ytimg.com/vi/groupingTest01/hqdefault.jpg",
    );

    const detailResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      video: { id: string; clipCount: number };
      clips: Array<{ id: string; videoId: string }>;
    };
    expect(detail.video).toMatchObject({ id: first.videoId, clipCount: 2 });
    expect(detail.clips.map((clip) => clip.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(detail.clips.every((clip) => clip.videoId === first.videoId)).toBe(
      true,
    );
  });

  it("keeps a video after its last clip is deleted", async () => {
    const uniqueResponse = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "single clip",
        sourceTitle: "Delete me",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=deleteProject01",
        },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    const unique = (await uniqueResponse.json()) as {
      id: string;
      videoId: string;
    };

    const deleted = await workerFetch(
      `http://example.com/api/clips/${unique.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    const after = await workerFetch(
      `http://example.com/api/videos/${unique.videoId}`,
    );
    expect(after.status).toBe(200);
    const detail = (await after.json()) as {
      video: { id: string; clipCount: number };
      clips: Array<unknown>;
    };
    expect(detail.video).toMatchObject({
      id: unique.videoId,
      clipCount: 0,
    });
    expect(detail.clips).toEqual([]);
  });

  it("deletes a video, its uploaded original, and all associated clips explicitly", async () => {
    const uploadKey = await uploadTestVideo();
    const createResponse = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "delete video clip one",
        sourceTitle: "Delete video source.mp4",
        source: { type: "upload", key: uploadKey },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    const first = (await createResponse.json()) as {
      id: string;
      videoId: string;
    };
    const secondResponse = await workerFetch(
      `http://example.com/api/videos/${first.videoId}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "delete video clip two",
          trimStart: 5,
          trimEnd: 8,
          filters: [],
        }),
      },
    );
    const second = (await secondResponse.json()) as { id: string };

    const deleted = await workerFetch(
      `http://example.com/api/videos/${first.videoId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
    const videoAfter = await workerFetch(
      `http://example.com/api/videos/${first.videoId}`,
    );
    expect(videoAfter.status).toBe(404);
    const firstAfter = await workerFetch(
      `http://example.com/api/clips/${first.id}`,
    );
    const secondAfter = await workerFetch(
      `http://example.com/api/clips/${second.id}`,
    );
    expect(firstAfter.status).toBe(404);
    expect(secondAfter.status).toBe(404);
  });

  it("preserves video files when deleting its database records fails", async () => {
    const uploadKey = await uploadTestVideo();
    const createResponse = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "protected delete clip",
        sourceTitle: "Protected delete source.mp4",
        source: { type: "upload", key: uploadKey },
        trimStart: 1,
        trimEnd: 4,
        filters: [],
      }),
    });
    const created = (await createResponse.json()) as {
      id: string;
      videoId: string;
    };
    const keys = outputKeysForClip(created.id);
    await env.CLIPS_BUCKET.put(keys.mp4Key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    await env.CLIPS_BUCKET.put(keys.thumbnailKey, new Uint8Array([4, 5, 6]), {
      httpMetadata: { contentType: "image/jpeg" },
    });

    await env.DB.prepare(
      `CREATE TRIGGER prevent_test_video_delete
       BEFORE DELETE ON source_videos
       WHEN OLD.id = '${created.videoId}'
       BEGIN
         SELECT RAISE(ABORT, 'delete blocked for test');
       END`,
    ).run();

    const deleteResponse = await workerFetch(
      `http://example.com/api/videos/${created.videoId}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(500);

    expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();

    await env.DB.prepare("DROP TRIGGER prevent_test_video_delete").run();
  });

  it("removes an artifact upload that finishes after its video is deleted", async () => {
    const clipId = crypto.randomUUID();
    const videoId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_videos (id, source_type, source_ref, title)
         VALUES (?, 'youtube', ?, 'Late artifact delete race')`,
      ).bind(videoId, "https://www.youtube.com/watch?v=lateDeleteRace01"),
      env.DB.prepare(
        `INSERT INTO clips (
           id, title, source_type, source_ref, trim_start, trim_end,
           filters_json, status, callback_secret, video_id
         ) VALUES (?, 'late artifact', 'youtube', ?, 1, 4, '[]', 'queued', ?, ?)`,
      ).bind(
        clipId,
        "https://www.youtube.com/watch?v=lateDeleteRace01",
        secret,
        videoId,
      ),
    ]);
    const keys = outputKeysForClip(clipId);
    let lateDeleteAttempts = 0;
    let releasePut: (() => void) | undefined;
    let signalPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });

    const controlledBucket = new Proxy(env.CLIPS_BUCKET, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            signalPutStarted?.();
            await putReleased;
            return target.put(...args);
          };
        }
        if (property === "delete") {
          return async (key: string | string[]) => {
            if (key === keys.mp4Key && lateDeleteAttempts++ === 0) {
              throw new Error("temporary late artifact cleanup failure");
            }
            return target.delete(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const controlledEnv = new Proxy(env, {
      get(target, property) {
        return property === "CLIPS_BUCKET"
          ? controlledBucket
          : Reflect.get(target, property, target);
      },
    });

    const uploadContext = createExecutionContext();
    const uploadPromise = handleRequest(
      new Request(
        `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            [JOB_SECRET_HEADER]: secret,
          },
          body: new Uint8Array([9, 8, 7, 6]),
        },
      ),
      controlledEnv,
      uploadContext,
    );

    await Promise.race([
      putStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("controlled artifact put did not start")), 1000),
      ),
    ]);
    const deleted = await workerFetch(
      `http://example.com/api/videos/${videoId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    releasePut?.();
    const uploadResponse = await uploadPromise;
    await waitOnExecutionContext(uploadContext);
    expect(uploadResponse.status).toBe(410);
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    const queued = await env.DB.prepare(
      "SELECT attempts FROM artifact_deletions WHERE key = ?",
    )
      .bind(keys.mp4Key)
      .first<{ attempts: number }>();
    expect(queued?.attempts).toBe(1);

    await drainArtifactDeletions(env.DB, env.CLIPS_BUCKET);
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
  });
});

describe("DELETE /api/clips/:id", () => {
  it("removes the D1 row and R2 artifacts for a complete clip", async () => {
    const { clipId, secret } = await createYoutubeClip("delete complete");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/thumbnail`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeJpeg,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );

    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).not.toBeNull();

    const response = await workerFetch(`http://example.com/api/clips/${clipId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);

    expect(await getClipById(env.DB, clipId)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();

    const getResponse = await workerFetch(`http://example.com/api/clips/${clipId}`);
    expect(getResponse.status).toBe(404);
  });

  it("removes a failed clip and its artifacts when present", async () => {
    const { clipId, secret } = await createYoutubeClip("delete failed");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "cleanup test",
        }),
      },
    );

    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();

    const response = await workerFetch(`http://example.com/api/clips/${clipId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(await getClipById(env.DB, clipId)).toBeNull();
  });

  it("deletes an in-flight clip and rejects late authenticated callbacks without recreating records", async () => {
    const { clipId, secret } = await createYoutubeClip("delete in-flight");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "encoding" }),
      },
    );

    const response = await workerFetch(`http://example.com/api/clips/${clipId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(await getClipById(env.DB, clipId)).toBeNull();

    const lateStatus = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );
    expect(lateStatus.status).toBe(404);
    expect(await getClipById(env.DB, clipId)).toBeNull();

    const lateArtifact = await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    expect(lateArtifact.status).toBe(404);
    expect(await getClipById(env.DB, clipId)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
  });

  it("returns 404 when deleting a nonexistent clip", async () => {
    const response = await workerFetch(
      "http://example.com/api/clips/does-not-exist",
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });
});

async function completeClipForGifTests(clipId: string, secret: string) {
  const keys = outputKeysForClip(clipId);
  const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  await workerFetch(
    `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        [JOB_SECRET_HEADER]: secret,
      },
      body: fakeMp4,
    },
  );
  await workerFetch(
    `http://example.com/api/internal/jobs/${clipId}/artifacts/thumbnail`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        [JOB_SECRET_HEADER]: secret,
      },
      body: fakeJpeg,
    },
  );
  await workerFetch(
    `http://example.com/api/internal/jobs/${clipId}/status`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [JOB_SECRET_HEADER]: secret,
      },
      body: JSON.stringify({ status: "complete" }),
    },
  );

  return keys;
}

async function waitForGifStatus(
  clipId: string,
  target: "encoding" | "complete" | "failed",
) {
  let lastBody: Record<string, unknown> = {};
  // GIF jobs share the warm-encoder FIFO queue with clip jobs, so allow a
  // wider poll budget than a single-job wait to absorb queued work from
  // earlier tests.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await workerFetch(`http://example.com/api/clips/${clipId}`);
    expect(response.status).toBe(200);
    lastBody = (await response.json()) as Record<string, unknown>;
    if (lastBody.gifStatus === target) {
      return lastBody;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lastBody;
}

describe("POST /api/clips/:id/gif", () => {
  it("starts GIF export for a complete clip and returns the download URL once done", async () => {
    const { clipId, secret } = await createYoutubeClip("gif export");
    const keys = await completeClipForGifTests(clipId, secret);

    const start = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as {
      gifStatus: string;
      outputs: { gif: string | null };
    };
    expect(started.gifStatus).toBe("encoding");
    expect(started.outputs.gif).toBeNull();

    const done = await waitForGifStatus(clipId, "complete");
    expect(done.gifStatus).toBe("complete");
    expect(done.status).toBe("complete");
    expect((done.outputs as { gif: string }).gif).toBe(
      `/artifacts/${keys.gifKey}`,
    );

    const persisted = await getClipById(env.DB, clipId);
    expect(persisted?.gif_status).toBe("complete");
    expect(persisted?.output_gif_key).toBe(keys.gifKey);
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).not.toBeNull();
  });

  it("is idempotent while encoding and after completion", async () => {
    const { clipId, secret } = await createYoutubeClip("gif idempotent");
    const keys = await completeClipForGifTests(clipId, secret);

    const first = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(first.status).toBe(202);

    const second = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(second.status).toBe(200);
    const inProgress = (await second.json()) as { gifStatus: string };
    expect(inProgress.gifStatus).toBe("encoding");

    await waitForGifStatus(clipId, "complete");

    const third = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(third.status).toBe(200);
    const complete = (await third.json()) as {
      gifStatus: string;
      outputs: { gif: string };
    };
    expect(complete.gifStatus).toBe("complete");
    expect(complete.outputs.gif).toBe(`/artifacts/${keys.gifKey}`);
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).not.toBeNull();
  });

  it("rejects GIF export for non-complete clips", async () => {
    const { clipId } = await createYoutubeClip("gif not complete");

    const response = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Clip is not complete");
  });

  it("leaves the original clip intact when GIF export fails and allows retry", async () => {
    const { clipId, secret } = await createYoutubeClip("gif failure retry");
    const keys = outputKeysForClip(clipId);
    const fakeMp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await env.CLIPS_BUCKET.put(STUB_GIF_FAILURE_MP4_KEY, fakeMp4, {
      httpMetadata: { contentType: "video/mp4" },
    });

    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/mp4`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeMp4,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/artifacts/thumbnail`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          [JOB_SECRET_HEADER]: secret,
        },
        body: fakeJpeg,
      },
    );
    await workerFetch(
      `http://example.com/api/internal/jobs/${clipId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [JOB_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ status: "complete" }),
      },
    );

    await env.DB.prepare(
      "UPDATE clips SET output_mp4_key = ? WHERE id = ?",
    )
      .bind(STUB_GIF_FAILURE_MP4_KEY, clipId)
      .run();

    const failedStart = await workerFetch(
      `http://example.com/api/clips/${clipId}/gif`,
      { method: "POST" },
    );
    expect(failedStart.status).toBe(202);

    const failed = await waitForGifStatus(clipId, "failed");
    expect(failed.gifStatus).toBe("failed");
    expect(failed.status).toBe("complete");
    expect((failed.outputs as { mp4: string }).mp4).toBe(
      `/artifacts/${STUB_GIF_FAILURE_MP4_KEY}`,
    );
    expect(failed.gifErrorMessage).toBeTruthy();
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).toBeNull();

    await env.DB.prepare(
      "UPDATE clips SET output_mp4_key = ? WHERE id = ?",
    )
      .bind(keys.mp4Key, clipId)
      .run();
    await env.CLIPS_BUCKET.put(keys.mp4Key, fakeMp4, {
      httpMetadata: { contentType: "video/mp4" },
    });

    const retry = await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    expect(retry.status).toBe(202);

    const recovered = await waitForGifStatus(clipId, "complete");
    expect(recovered.gifStatus).toBe("complete");
    expect(recovered.status).toBe("complete");
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).not.toBeNull();
  });

  it("deletes the GIF object when the clip is deleted", async () => {
    const { clipId, secret } = await createYoutubeClip("gif delete cleanup");
    const keys = await completeClipForGifTests(clipId, secret);

    await workerFetch(`http://example.com/api/clips/${clipId}/gif`, {
      method: "POST",
    });
    await waitForGifStatus(clipId, "complete");
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).not.toBeNull();

    const response = await workerFetch(`http://example.com/api/clips/${clipId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(await env.CLIPS_BUCKET.get(keys.gifKey)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.thumbnailKey)).toBeNull();
  });
});

describe("DO-driven terminal status writes", () => {
  it("reaches complete from the container even when the worker background task is not awaited", async () => {
    const { response, ctx } = await workerFetchWithoutWaitingForBackground(
      "http://example.com/api/clips",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "DO authority without worker wait",
          source: {
            type: "youtube",
            url: STUB_NO_CALLBACKS_SLOW_RUN_URL,
          },
          trimStart: 1,
          trimEnd: 5,
          filters: [],
        }),
      },
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let persisted: Awaited<ReturnType<typeof getClipById>> = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      persisted = await getClipById(env.DB, clipId);
      if (persisted?.status === "complete") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await waitOnExecutionContext(ctx);

    expect(persisted?.status).toBe("complete");
    expect(persisted?.output_mp4_key).toBe(keys.mp4Key);
    expect(persisted?.output_thumbnail_key).toBe(keys.thumbnailKey);
  });
});

describe("stale in-flight job watchdog", () => {
  async function ageClipUpdatedAt(clipId: string, minutesAgo: number) {
    await env.DB.prepare(
      `UPDATE clips SET updated_at = datetime('now', ?) WHERE id = ?`,
    )
      .bind(`-${minutesAgo} minutes`, clipId)
      .run();
  }

  it("marks stale in-flight clips failed when listing clips", async () => {
    const stale = await createYoutubeClip("stale watchdog clip");
    // Let the stub's detached run settle so its callbacks can't refresh
    // updated_at after we backdate it below.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const record = await getClipById(env.DB, stale.clipId);
      if (record?.status === "complete" || record?.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await ageClipUpdatedAt(stale.clipId, 20);
    await env.DB.prepare(
      `UPDATE clips SET status = 'downloading' WHERE id = ?`,
    )
      .bind(stale.clipId)
      .run();

    const list = await workerFetch("http://example.com/api/clips");
    expect(list.status).toBe(200);

    const persisted = await getClipById(env.DB, stale.clipId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure_mode).toBe("ambiguous");
    expect(persisted?.error_message).toContain("timed out");
  });

  it("leaves fresh in-flight clips untouched when listing clips", async () => {
    const fresh = await createYoutubeClip("fresh watchdog clip");
    await env.DB.prepare(
      `UPDATE clips SET status = 'encoding' WHERE id = ?`,
    )
      .bind(fresh.clipId)
      .run();

    const list = await workerFetch("http://example.com/api/clips");
    expect(list.status).toBe(200);

    const persisted = await getClipById(env.DB, fresh.clipId);
    expect(persisted?.status).toBe("encoding");
    expect(persisted?.failure_mode).toBeNull();
  });
});

describe("helper fetch API", () => {
  it("returns 404 for helper routes when HELPER_TOKEN is unset", async () => {
    const savedToken = env.HELPER_TOKEN;
    try {
      env.HELPER_TOKEN = undefined;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(404);

      const fulfill = await workerFetch(
        "http://example.com/api/helper/jobs/some-id/fulfill",
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey: "uploads/x.mp4", sectionStart: 0 }),
        },
      );
      expect(fulfill.status).toBe(404);

      const fail = await workerFetch(
        "http://example.com/api/helper/jobs/some-id/fail",
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(fail.status).toBe(404);
    } finally {
      env.HELPER_TOKEN = savedToken;
    }
  });

  it("rejects claim without or with wrong token and returns 204 when no jobs", async () => {
    const missing = await workerFetch("http://example.com/api/helper/claim", {
      method: "POST",
    });
    expect(missing.status).toBe(401);

    const wrong = await workerFetch("http://example.com/api/helper/claim", {
      method: "POST",
      headers: helperHeaders("wrong-token"),
    });
    expect(wrong.status).toBe(401);

    const empty = await workerFetch("http://example.com/api/helper/claim", {
      method: "POST",
      headers: helperHeaders(),
    });
    expect(empty.status).toBe(204);
  });

  it("claims a pending YouTube job when the claim window is open", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper pending clip",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-pending",
            },
            trimStart: 3,
            trimEnd: 8,
            filters: [],
          }),
        },
      );
      expect(response.status).toBe(201);
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);
      const body = (await claim.json()) as {
        clipId: string;
        url: string;
        trimStart: number;
        trimEnd: number;
        quality: string;
        maxClipLengthSeconds: number;
      };
      expect(body).toEqual({
        clipId,
        url: "https://www.youtube.com/watch?v=helper-pending",
        trimStart: 3,
        trimEnd: 8,
        quality: "1080p",
        maxClipLengthSeconds: 60,
      });

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("claimed");
      expect(record?.status).toBe("downloading");
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("fulfills a claimed job with adjusted trim bounds and dispatches upload encoding", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper fulfill clip",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-fulfill",
            },
            trimStart: 5,
            trimEnd: 10,
            filters: [],
          }),
        },
      );
      expect(response.status).toBe(201);
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      const uploadKey = await uploadTestVideo();
      const sectionStart = 2;

      const fulfill = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey, sectionStart }),
        },
      );
      expect(fulfill.status).toBe(202);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("fulfilled");
      expect(record?.helper_upload_key).toBe(uploadKey);
      expect(record?.source_type).toBe("youtube");
      expect(record?.trim_start).toBe(5);
      expect(record?.trim_end).toBe(10);

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "upload") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: { type: "upload", key: uploadKey },
        trimStart: 3,
        trimEnd: 8,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("rejects fulfill validation errors and conflicting states", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper fulfill validation",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-validate",
            },
            trimStart: 4,
            trimEnd: 8,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const badKey = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey: "clips/not-upload.mp4", sectionStart: 0 }),
        },
      );
      expect(badKey.status).toBe(400);

      const notClaimed = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey: "uploads/missing.mp4", sectionStart: 0 }),
        },
      );
      expect(notClaimed.status).toBe(409);

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      const missingObject = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey: "uploads/missing-object.mp4", sectionStart: 0 }),
        },
      );
      expect(missingObject.status).toBe(404);

      const sectionTooLate = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey: "uploads/too-late.mp4", sectionStart: 5 }),
        },
      );
      expect(sectionTooLate.status).toBe(400);
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("expires a claimed job on fail and falls back to container YouTube dispatch", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper fail clip",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-fail",
            },
            trimStart: 2,
            trimEnd: 6,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      const fail = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fail`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ errorMessage: "download failed" }),
        },
      );
      expect(fail.status).toBe(202);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-fail",
        },
        trimStart: 2,
        trimEnd: 6,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("falls back to container dispatch when the claim window expires", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "helper window fallback",
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-window-fallback",
        },
        trimStart: 1,
        trimEnd: 5,
        filters: [],
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const clipId = created.id;
    const keys = outputKeysForClip(clipId);

    let lastBody: Record<string, unknown> = { status: "queued" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const statusResponse = await workerFetch(
        `http://example.com/api/clips/${clipId}`,
      );
      expect(statusResponse.status).toBe(200);
      lastBody = (await statusResponse.json()) as Record<string, unknown>;
      if (lastBody.status === "complete" || lastBody.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(lastBody.status).toBe("complete");

    const record = await getClipById(env.DB, clipId);
    expect(record?.helper_state).toBe("recovering");
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
  });

  it("recovers stale helper claims when fetching a single clip", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper stale claim single get",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-stale-get",
            },
            trimStart: 2,
            trimEnd: 7,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      await env.DB.prepare(
        `UPDATE clips SET helper_claimed_at = datetime('now', '-6 minutes') WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const get = await workerFetch(`http://example.com/api/clips/${clipId}`);
      expect(get.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-stale-get",
        },
        trimStart: 2,
        trimEnd: 7,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("retries a crashed recovery on the next poll", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper crashed recovery",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-crashed-recovery",
            },
            trimStart: 1,
            trimEnd: 6,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips SET helper_state = 'expired' WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-crashed-recovery",
        },
        trimStart: 1,
        trimEnd: 6,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("retries a recovery stranded before the dispatch reached the container", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper stranded recovering",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-stranded-recovering",
            },
            trimStart: 2,
            trimEnd: 6,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips
         SET helper_state = 'recovering',
             updated_at = datetime('now', '-3 minutes')
         WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      // The sweep flips the row back to 'expired', and recovery re-claims it
      // as 'recovering' within the same poll before dispatching.
      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-stranded-recovering",
        },
        trimStart: 2,
        trimEnd: 6,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("leaves fresh recovering rows untouched by the sweep", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper fresh recovering",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-fresh-recovering",
            },
            trimStart: 1,
            trimEnd: 4,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips SET helper_state = 'recovering' WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");
      expect(record?.status).toBe("queued");
      expect(await getLastDispatch(clipId)).toBeNull();
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("expires stale pending jobs whose claim-window task never ran", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper stale pending",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-stale-pending",
            },
            trimStart: 1,
            trimEnd: 5,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips SET created_at = datetime('now', '-5 minutes') WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-stale-pending",
        },
        trimStart: 1,
        trimEnd: 5,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("recovers stale helper claims when listing clips", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper stale claim",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-stale",
            },
            trimStart: 1,
            trimEnd: 4,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      await env.DB.prepare(
        `UPDATE clips SET helper_claimed_at = datetime('now', '-6 minutes') WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-stale",
        },
        trimStart: 1,
        trimEnd: 4,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("recovers a long-idle claimed job instead of failing it via the generic sweep", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper overnight claim",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-overnight-claim",
            },
            trimStart: 2,
            trimEnd: 7,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      const claim = await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });
      expect(claim.status).toBe(200);

      await env.DB.prepare(
        `UPDATE clips
         SET helper_claimed_at = datetime('now', '-20 minutes'),
             updated_at = datetime('now', '-20 minutes')
         WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.status).not.toBe("failed");
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-overnight-claim",
        },
        trimStart: 2,
        trimEnd: 7,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("recovers a long-idle pending job instead of failing it via the generic sweep", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper overnight pending",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-overnight-pending",
            },
            trimStart: 1,
            trimEnd: 6,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips
         SET created_at = datetime('now', '-20 minutes'),
             updated_at = datetime('now', '-20 minutes')
         WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.status).not.toBe("failed");
      expect(record?.helper_state).toBe("recovering");

      let dispatch: EncoderJobSpec | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        dispatch = await getLastDispatch(clipId);
        if (dispatch?.source.type === "youtube") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(dispatch).toMatchObject({
        source: {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=helper-overnight-pending",
        },
        trimStart: 1,
        trimEnd: 6,
      });
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("still fails a fulfilled clip stuck in downloading via the generic sweep", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper fulfilled backstop",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-fulfilled-backstop",
            },
            trimStart: 1,
            trimEnd: 5,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await env.DB.prepare(
        `UPDATE clips
         SET helper_state = 'fulfilled',
             status = 'downloading',
             updated_at = datetime('now', '-20 minutes')
         WHERE id = ?`,
      )
        .bind(clipId)
        .run();

      const list = await workerFetch("http://example.com/api/clips");
      expect(list.status).toBe(200);

      const record = await getClipById(env.DB, clipId);
      expect(record?.status).toBe("failed");
      expect(record?.failure_mode).toBe("ambiguous");
      expect(record?.error_message).toContain("timed out");
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });

  it("deletes helper upload objects after a fulfilled clip completes", async () => {
    const savedWindow = env.HELPER_CLAIM_WINDOW_SECONDS;
    try {
      env.HELPER_CLAIM_WINDOW_SECONDS = "60";

      const { response } = await workerFetchWithoutWaitingForBackground(
        "http://example.com/api/clips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "helper upload cleanup",
            source: {
              type: "youtube",
              url: "https://www.youtube.com/watch?v=helper-cleanup",
            },
            trimStart: 1,
            trimEnd: 5,
            filters: [],
          }),
        },
      );
      const created = (await response.json()) as { id: string };
      const clipId = created.id;

      await workerFetch("http://example.com/api/helper/claim", {
        method: "POST",
        headers: helperHeaders(),
      });

      const uploadKey = await uploadTestVideo();
      const fulfill = await workerFetch(
        `http://example.com/api/helper/jobs/${clipId}/fulfill`,
        {
          method: "POST",
          headers: {
            ...helperHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uploadKey, sectionStart: 0 }),
        },
      );
      expect(fulfill.status).toBe(202);
      expect(await env.CLIPS_BUCKET.get(uploadKey)).not.toBeNull();

      let lastBody: Record<string, unknown> = { status: "downloading" };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const statusResponse = await workerFetch(
          `http://example.com/api/clips/${clipId}`,
        );
        expect(statusResponse.status).toBe(200);
        lastBody = (await statusResponse.json()) as Record<string, unknown>;
        if (lastBody.status === "complete" || lastBody.status === "failed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(lastBody.status).toBe("complete");
      expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
    } finally {
      env.HELPER_CLAIM_WINDOW_SECONDS = savedWindow;
    }
  });
});
