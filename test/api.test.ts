import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { JOB_SECRET_HEADER } from "../src/auth";
import { getClipById, outputKeysForClip } from "../src/db";
import { dispatchEncodingJob, failClipAmbiguous } from "../src/jobs";
import {
  STUB_AMBIGUOUS_FAILURE_URL,
  STUB_CONTAINER_START_FAILURE_URL,
  STUB_DEFERRED_COPY_FAILURE_UPLOAD_KEY,
  STUB_DEFERRED_AMBIGUOUS_FAILURE_UPLOAD_KEY,
  STUB_DEFERRED_SLOW_UPLOAD_KEY,
  STUB_NO_CALLBACKS_SLOW_RUN_URL,
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
  const body = (await response.json()) as { id: string };
  const record = await getClipById(env.DB, body.id);
  expect(record?.callback_secret).toBeTruthy();
  return { clipId: body.id, secret: record!.callback_secret };
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
  it("deletes the uploaded source object after a job completes", async () => {
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
    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
    expect(await env.CLIPS_BUCKET.get(keys.mp4Key)).not.toBeNull();
  });

  it("deletes the uploaded source object after a confirmed failure", async () => {
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
    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
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
    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();

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
    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
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

  it("recovers ambiguous-failed deferred upload jobs via DO complete signal", async () => {
    const uploadKey = STUB_DEFERRED_AMBIGUOUS_FAILURE_UPLOAD_KEY;
    await env.CLIPS_BUCKET.put(uploadKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "deferred ambiguous recovery",
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
    expect(await env.CLIPS_BUCKET.get(uploadKey)).toBeNull();
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
    expect(body.outputs.mp4).toBeNull();
    expect(body.outputs.thumbnail).toBeNull();
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
