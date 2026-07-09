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
  STUB_SKIP_COMPLETE_CALLBACK_URL,
  STUB_VERIFY_WORKER_BASE_URL,
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

  it("rejects upload sources until slice 6", async () => {
    const response = await workerFetch("http://example.com/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "upload clip",
        source: { type: "upload", key: "uploads/some-key.mp4" },
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
        expect.objectContaining({
          field: "source.type",
          message: expect.stringContaining("not supported"),
        }),
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
        filters: [{ type: "noop" }],
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
      filters: [{ type: "noop" }],
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
