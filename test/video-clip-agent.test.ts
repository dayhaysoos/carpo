import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  agentVideoContextSystemBlock,
  forceVideoContextOnFirstStep,
  loadAgentVideoContext,
} from "../src/video-clip-agent";

describe("VideoClipAgent context", () => {
  it("injects a persisted duration so random clip requests never need user input", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds
       ) VALUES (?, 'youtube', ?, ?, ?)`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=context-test",
        "Context test",
        1009,
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);
    expect(context).toMatchObject({
      title: "Context test",
      durationSeconds: 1009,
      sourceType: "youtube",
    });

    const systemBlock = agentVideoContextSystemBlock(context);
    expect(systemBlock).toContain('"durationSeconds":1009');
    expect(systemBlock).toContain(
      "never ask the user for the video duration",
    );
  });

  it("forces the context tool before the model can answer", () => {
    expect(forceVideoContextOnFirstStep(0)).toEqual({
      activeTools: ["getVideoContext"],
      toolChoice: { type: "tool", toolName: "getVideoContext" },
    });
    expect(forceVideoContextOnFirstStep(1)).toBeUndefined();
  });
});
