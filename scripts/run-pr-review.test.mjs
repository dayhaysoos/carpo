import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createManualExecutionId,
  resolveExecutionMetadata,
} from "./run-pr-review.mjs";

describe("backend-neutral PR review runner", () => {
  it("creates an allowlisted manual execution identity", () => {
    assert.equal(
      createManualExecutionId(
        new Date("2026-08-26T16:47:00.000Z"),
        Buffer.from("01234567", "hex"),
      ),
      "manual-20260826T164700Z-01234567",
    );
  });

  it("derives Actions execution metadata without changing the runner interface", () => {
    assert.deepEqual(
      resolveExecutionMetadata(
        { pr: "8" },
        {
          GITHUB_ACTIONS: "true",
          GITHUB_RUN_ID: "32981962097",
          GITHUB_RUN_ATTEMPT: "2",
        },
      ),
      {
        executionId: "actions-32981962097-2",
        sourceUrl:
          "https://github.com/dayhaysoos/carpo/actions/runs/32981962097",
      },
    );
  });

  it("rejects execution sources outside the Carpo repository", () => {
    assert.throws(
      () =>
        resolveExecutionMetadata({
          pr: "8",
          "execution-id": "manual-20260826T164700Z-01234567",
          "source-url": "https://attacker.example/run/1",
        }),
      /execution source URL/,
    );
  });
});
