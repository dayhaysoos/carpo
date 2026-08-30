import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ensureSourceVideo,
  getSourceVideoById,
} from "../src/db";
import {
  createRetainedVideoSourceAcquisition,
  type RetainedVideoSourceAdapter,
} from "../src/retained-video-source";
import type { SourceVideoRecord } from "../src/types";

async function youtubeVideo(label: string): Promise<SourceVideoRecord> {
  const id = await ensureSourceVideo(env.DB, "legacy", {
    source: {
      type: "youtube",
      url: `https://www.youtube.com/watch?v=${label}`,
    },
    title: label,
  });
  const video = await getSourceVideoById(env.DB, id);
  if (!video) throw new Error("Expected source video");
  return video;
}

function acquisitionHarness(options: { downloadError?: string } = {}) {
  const calls = { download: 0, persist: 0, stage: 0 };
  const adapter: RetainedVideoSourceAdapter = {
    async downloadYoutubeSource() {
      calls.download += 1;
      return options.downloadError
        ? { ok: false, error: options.downloadError }
        : { ok: true };
    },
    async persistDownloadedSource({ key }) {
      calls.persist += 1;
      await env.CLIPS_BUCKET.put(key, new Uint8Array([0, 1, 2, 3]), {
        httpMetadata: { contentType: "video/mp4" },
      });
    },
    async stageBucketSource({ key, jobId }) {
      calls.stage += 1;
      return (await env.CLIPS_BUCKET.head(key))
        ? { ok: true, path: `/tmp/carpo-src-${jobId}` }
        : { ok: false, error: "Video source not found" };
    },
  };
  return {
    calls,
    acquisition: createRetainedVideoSourceAcquisition({
      db: env.DB,
      bucket: env.CLIPS_BUCKET,
      adapter,
    }),
  };
}

describe("Retained Video Source Acquisition", () => {
  it("retains a remote Video once without staging it back into the encoder", async () => {
    const video = await youtubeVideo("retain-without-stage");
    const { acquisition, calls } = acquisitionHarness();

    const first = await acquisition.retain(video, "source-video-1");
    expect(first).toMatchObject({ ok: true, acquired: true });
    expect(calls).toEqual({ download: 1, persist: 1, stage: 0 });

    const retained = await getSourceVideoById(env.DB, video.id);
    expect(retained).toMatchObject({
      retained_source_status: "ready",
      retained_source_error: null,
    });
    expect(
      await env.CLIPS_BUCKET.head(retained!.retained_source_key!),
    ).not.toBeNull();

    const second = await acquisition.retain(retained!, "source-video-2");
    expect(second).toMatchObject({ ok: true, acquired: false });
    expect(calls).toEqual({ download: 1, persist: 1, stage: 0 });
  });

  it("stages the retained source through the same interface used by callers", async () => {
    const video = await youtubeVideo("stage-retained-source");
    const { acquisition, calls } = acquisitionHarness();
    await acquisition.retain(video, "source-video-1");
    const retained = await getSourceVideoById(env.DB, video.id);

    const result = await acquisition.stage(retained!, "clip-1");

    expect(result).toEqual({
      ok: true,
      path: "/tmp/carpo-src-clip-1",
      acquired: false,
    });
    expect(calls).toEqual({ download: 1, persist: 1, stage: 1 });
  });

  it("reacquires a retained source whose R2 object is missing", async () => {
    const video = await youtubeVideo("reacquire-missing-source");
    const { acquisition, calls } = acquisitionHarness();
    await acquisition.retain(video, "source-video-1");
    const retained = await getSourceVideoById(env.DB, video.id);
    await env.CLIPS_BUCKET.delete(retained!.retained_source_key!);

    const result = await acquisition.stage(retained!, "clip-2");

    expect(result).toMatchObject({ ok: true, acquired: true });
    expect(calls).toEqual({ download: 2, persist: 2, stage: 1 });
    expect(await getSourceVideoById(env.DB, video.id)).toMatchObject({
      retained_source_status: "ready",
      retained_source_error: null,
    });
  });

  it("records acquisition failure before returning it", async () => {
    const video = await youtubeVideo("record-acquisition-failure");
    const { acquisition, calls } = acquisitionHarness({
      downloadError: "HTTP Error 429: Too Many Requests",
    });

    const result = await acquisition.retain(video, "source-video-1");

    expect(result).toEqual({
      ok: false,
      error: "HTTP Error 429: Too Many Requests",
    });
    expect(calls).toEqual({ download: 1, persist: 0, stage: 0 });
    expect(await getSourceVideoById(env.DB, video.id)).toMatchObject({
      retained_source_status: "failed",
      retained_source_error: "HTTP Error 429: Too Many Requests",
    });
  });
});
