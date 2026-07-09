import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getClipById } from "../src/db";

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
    expect(body.outputs.mp4).toBe(`/artifacts/clips/${body.id}/clip.mp4`);
    expect(body.outputs.thumbnail).toBe(
      `/artifacts/clips/${body.id}/thumbnail.jpg`,
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

describe("GET /api/clips/:id", () => {
  it("returns 404 for unknown clips", async () => {
    const response = await workerFetch(
      "http://example.com/api/clips/does-not-exist",
    );
    expect(response.status).toBe(404);
  });
});
