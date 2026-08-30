import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  R2MediaDelivery,
  type MediaDeliveryOutcome,
} from "../src/r2-media-delivery";

const KEY = "test/media-delivery/video.mp4";
const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

function delivered(outcome: MediaDeliveryOutcome): Response {
  expect(outcome.type).toBe("delivered");
  if (outcome.type !== "delivered") throw new Error("Expected delivery");
  return outcome.response;
}

describe("R2MediaDelivery", () => {
  beforeEach(async () => {
    await env.CLIPS_BUCKET.put(KEY, BYTES, {
      httpMetadata: { contentType: "video/mp4" },
    });
  });

  it("delivers complete GET and HEAD responses with authoritative headers", async () => {
    const media = new R2MediaDelivery(env.CLIPS_BUCKET);
    const get = delivered(
      await media.deliver({ key: KEY, method: "GET", range: null }),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("video/mp4");
    expect(get.headers.get("Content-Length")).toBe("8");
    expect(get.headers.get("Accept-Ranges")).toBe("bytes");
    expect(get.headers.get("Cache-Control")).toBe("private, no-store");
    expect(get.headers.get("ETag")).toBeTruthy();
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(BYTES);

    const head = delivered(
      await media.deliver({ key: KEY, method: "HEAD", range: null }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("8");
    expect(await head.text()).toBe("");
  });

  it("delivers bounded, open-ended, suffix, and HEAD byte ranges", async () => {
    const media = new R2MediaDelivery(env.CLIPS_BUCKET);
    const cases = [
      { value: "bytes=2-4", expected: BYTES.slice(2, 5), header: "bytes 2-4/8" },
      { value: "bytes=6-", expected: BYTES.slice(6), header: "bytes 6-7/8" },
      { value: "bytes=-3", expected: BYTES.slice(5), header: "bytes 5-7/8" },
      { value: "bytes=0-99", expected: BYTES, header: "bytes 0-7/8" },
    ];

    for (const testCase of cases) {
      const response = delivered(
        await media.deliver({
          key: KEY,
          method: "GET",
          range: testCase.value,
        }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(testCase.header);
      expect(response.headers.get("Content-Length")).toBe(
        String(testCase.expected.length),
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        testCase.expected,
      );
    }

    const head = delivered(
      await media.deliver({ key: KEY, method: "HEAD", range: "bytes=1-2" }),
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Range")).toBe("bytes 1-2/8");
    expect(head.headers.get("Content-Length")).toBe("2");
    expect(await head.text()).toBe("");
  });

  it("returns a typed 416 outcome for malformed and unsatisfiable ranges", async () => {
    const media = new R2MediaDelivery(env.CLIPS_BUCKET);
    for (const range of [
      "items=0-1",
      "bytes=",
      "bytes=4-2",
      "bytes=8-",
      "bytes=-0",
      "bytes=0-1,3-4",
    ]) {
      const outcome = await media.deliver({ key: KEY, method: "GET", range });
      expect(outcome.type).toBe("range-not-satisfiable");
      if (outcome.type !== "range-not-satisfiable") continue;
      expect(outcome.headers.get("Content-Range")).toBe("bytes */8");
      expect(outcome.headers.get("Accept-Ranges")).toBe("bytes");
      expect(outcome.headers.get("Cache-Control")).toBe("private, no-store");
      expect(outcome.headers.get("Content-Type")).toBeNull();
    }
  });

  it("distinguishes a missing object from an invalid range", async () => {
    const media = new R2MediaDelivery(env.CLIPS_BUCKET);
    expect(
      await media.deliver({
        key: "test/media-delivery/missing.mp4",
        method: "GET",
        range: "bytes=99-",
      }),
    ).toEqual({ type: "missing" });
  });
});
