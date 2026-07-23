import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createClipForVideo } from "../src/clip-service";

describe("createClipForVideo", () => {
  it("creates a clip from an existing video through the shared product interface", async () => {
    const videoId = crypto.randomUUID();
    const sourceKey = `uploads/${crypto.randomUUID()}.mp4`;
    await env.CLIPS_BUCKET.put(sourceKey, new Uint8Array([0, 1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    await env.DB.prepare(
      `INSERT INTO source_videos (id, source_type, source_ref, title)
       VALUES (?, 'upload', ?, 'Think source')`,
    )
      .bind(videoId, sourceKey)
      .run();

    const background: Promise<unknown>[] = [];
    const result = await createClipForVideo({
      videoId,
      input: {
        title: "Manual agent clip",
        trimStart: 130,
        trimEnd: 148,
        quality: "720p",
        filters: [{ type: "caption", text: "Approved by me" }],
      },
      env,
      origin: "http://example.com",
      waitUntil: (promise) => background.push(promise),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clip).toMatchObject({
      videoId,
      title: "Manual agent clip",
      trimStart: 130,
      trimEnd: 148,
      quality: "720p",
      caption: "Approved by me",
      status: "queued",
    });
    expect(background).toHaveLength(1);
    await Promise.all(background);
  });
});
