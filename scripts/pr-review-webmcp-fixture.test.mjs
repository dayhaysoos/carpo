import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cleanupWebMcpReviewFixture,
  installWebMcpReviewFixture,
  WEBMCP_REVIEW_FIXTURE,
  webMcpReviewTranscript,
} from "./pr-review-webmcp-fixture.mjs";

describe("live WebMCP review fixture", () => {
  it("keeps transcript cues within the provisioned media duration", () => {
    const transcript = webMcpReviewTranscript();
    assert.equal(WEBMCP_REVIEW_FIXTURE.durationSeconds, 10);
    assert.ok(
      transcript.cues.every(
        ({ startSeconds, endSeconds }) =>
          startSeconds >= 0 &&
          endSeconds > startSeconds &&
          endSeconds <= WEBMCP_REVIEW_FIXTURE.durationSeconds,
      ),
    );
  });

  it("installs a transcript-grounded upload fixture and cleans it once", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-webmcp-fixture-"));
    const calls = [];
    try {
      const fixture = await installWebMcpReviewFixture({
        cwd: "/candidate",
        env: { CLOUDFLARE_API_TOKEN: "token" },
        outputDir,
        async runCommand(file, args, options) {
          const call = { file, args, options };
          if (args.includes("put")) {
            call.transcript = JSON.parse(
              await readFile(args[args.indexOf("--file") + 1], "utf8"),
            );
          }
          calls.push(call);
        },
      });

      assert.equal(fixture.videoId, WEBMCP_REVIEW_FIXTURE.videoId);
      assert.equal(fixture.path, `/?video=${WEBMCP_REVIEW_FIXTURE.videoId}`);
      assert.deepEqual(calls[0].transcript, webMcpReviewTranscript());
      assert.match(calls[1].args.at(-1), new RegExp(WEBMCP_REVIEW_FIXTURE.videoId));
      assert.match(calls[1].args.at(-1), /transcript_status/);
      assert.equal(calls[0].options.cwd, "/candidate");

      await fixture.cleanup();
      await fixture.cleanup();
      assert.equal(calls.length, 4);
      assert.ok(calls[2].args.includes("d1"));
      assert.ok(calls[3].args.includes("delete"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("removes the transcript object when D1 fixture creation fails", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-webmcp-fixture-"));
    const calls = [];
    try {
      await assert.rejects(
        () =>
          installWebMcpReviewFixture({
            cwd: "/candidate",
            env: {},
            outputDir,
            async runCommand(file, args) {
              calls.push({ file, args });
              if (args.includes("d1")) throw new Error("D1 unavailable");
            },
          }),
        /D1 unavailable/,
      );
      assert.equal(calls.length, 3);
      assert.ok(calls[2].args.includes("delete"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("offers an explicit idempotent recovery cleanup", async () => {
    const calls = [];
    await cleanupWebMcpReviewFixture({
      cwd: "/candidate",
      env: { CLOUDFLARE_API_TOKEN: "token" },
      async runCommand(file, args, options) {
        calls.push({ file, args, options });
      },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("d1"));
    assert.match(calls[0].args.at(-1), /DELETE FROM source_videos/);
    assert.ok(calls[1].args.includes("delete"));
    assert.equal(calls[0].options.cwd, "/candidate");
  });

  it("retries an idempotent D1 cleanup after a transient authorization failure", async () => {
    let d1Attempts = 0;
    const calls = [];
    await cleanupWebMcpReviewFixture({
      cwd: "/candidate",
      env: {},
      wait: async () => {},
      async runCommand(file, args) {
        calls.push({ file, args });
        if (args.includes("d1")) {
          d1Attempts += 1;
          if (d1Attempts === 1) {
            throw new Error("Cloudflare API authorization failed");
          }
        }
      },
    });

    assert.equal(d1Attempts, 2);
    assert.equal(calls.filter(({ args }) => args.includes("delete")).length, 1);
  });
});
