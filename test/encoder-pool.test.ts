import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  ENCODER_POOL_INSTANCE,
  ENCODER_PROTOCOL_VERSION,
  sampleStoredVideoFrames,
} from "../src/encoder-pool";

describe("encoder pool compatibility", () => {
  it("changes the pool identity when the Worker-container protocol changes", () => {
    expect(ENCODER_PROTOCOL_VERSION).toBe(5);
    expect(ENCODER_POOL_INSTANCE).toBe(
      `encoder-v${ENCODER_PROTOCOL_VERSION}`,
    );
  });

  it("re-prewarms and retries one idempotent frame sample after a disconnect", async () => {
    let sampleAttempts = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/__carpo/sample-frames" && ++sampleAttempts === 1) {
        throw new Error("Container suddenly disconnected, try again");
      }
      return new Response(null, { status: 204 });
    });
    const testEnv = {
      ENCODER_CONTAINER: {
        getByName: vi.fn(() => ({ fetch })),
      },
    } as unknown as Env;

    await expect(
      sampleStoredVideoFrames(testEnv, {
        videoId: "video-1",
        sourceRevision: "source-1",
        samples: [{ id: "frame-1", timestampSeconds: 1, key: "frame-1.jpg" }],
      }),
    ).resolves.toBeUndefined();
    expect(sampleAttempts).toBe(2);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/__carpo/start",
      "/__carpo/sample-frames",
      "/__carpo/start",
      "/__carpo/sample-frames",
    ]);
  });
});
