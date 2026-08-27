import { describe, expect, it } from "vitest";
import {
  isConsequentialElement,
  resolveSafeReviewPath,
} from "@carpo/review-contract";
import {
  parseReviewQueueMessage,
  resolveReviewInput,
} from "../src/build-events";
import { safeReturnPath } from "../src/security";

const origin = "https://carpo-pr-review.example.workers.dev";
const initialData = {
  executionId: "test-durable-review",
  source: { provider: "manual" as const, sourceUrl: "https://example.com/source" },
  candidate: {
    repository: "dayhaysoos/carpo",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    reviewOrigin: origin,
    expectedVersionTag: "b".repeat(40),
  },
  contextText: "context",
  diffText: "diff",
};

describe("bounded review security", () => {
  it("allows only the catalogued same-origin routes", () => {
    expect(resolveSafeReviewPath("/", origin)).toBe("/");
    expect(resolveSafeReviewPath("/library?view=archived", origin)).toBe(
      "/library?view=archived",
    );
    expect(resolveSafeReviewPath("/__carpo-review-missing", origin)).toBe(
      "/__carpo-review-missing",
    );
    expect(() => resolveSafeReviewPath("/api/review/identity", origin)).toThrow();
    expect(() => resolveSafeReviewPath("https://evil.example/", origin)).toThrow();
  });

  it("rejects consequential controls and unsafe login redirects", () => {
    expect(isConsequentialElement({ tag: "button", text: "Create clip" })).toBe(true);
    expect(isConsequentialElement({ tag: "a", role: "link", text: "Library" })).toBe(false);
    expect(safeReturnPath("/reports/test-durable-review")).toBe(
      "/reports/test-durable-review",
    );
    expect(safeReturnPath("https://evil.example/")).toBe("/");
  });
});

describe("GitHub-optional queue adapter", () => {
  it("resolves a compact candidate-ready pointer without GitHub fields", async () => {
    const parsed = parseReviewQueueMessage({
      type: "carpo.review.candidate-ready.v1",
      headSha: initialData.candidate.headSha,
    });
    expect(parsed?.type).toBe("candidate-ready");
    const bucket = {
      get: async () => ({ json: async () => initialData }),
    } as unknown as R2Bucket;
    await expect(
      resolveReviewInput(parsed!, {
        CLOUDFLARE_ACCOUNT_ID: "account",
        EVIDENCE_BUCKET: bucket,
        TARGET_REVIEW_WORKER_NAME: "carpo-pr-review",
      }),
    ).resolves.toEqual(initialData);
  });

  it("ignores unrelated or unstaged Workers Builds events", async () => {
    const parsed = parseReviewQueueMessage({
      type: "cf.workersBuilds.worker.build.succeeded",
      source: { type: "workersBuilds.worker", workerName: "another-worker" },
      payload: {
        buildUuid: "build-1",
        status: "success",
        buildOutcome: "success",
        buildTriggerMetadata: {
          branch: "feature",
          commitHash: "b".repeat(40),
          repoName: "carpo",
          providerType: "github",
        },
      },
      metadata: { accountId: "account" },
    });
    await expect(
      resolveReviewInput(parsed!, {
        CLOUDFLARE_ACCOUNT_ID: "account",
        EVIDENCE_BUCKET: {} as R2Bucket,
        TARGET_REVIEW_WORKER_NAME: "carpo-pr-review",
      }),
    ).resolves.toBeNull();
  });

  it("rejects Workers Builds events from another Cloudflare account", async () => {
    const parsed = parseReviewQueueMessage({
      type: "cf.workersBuilds.worker.build.succeeded",
      source: { type: "workersBuilds.worker", workerName: "carpo-pr-review" },
      payload: {
        buildUuid: "build-2",
        status: "success",
        buildOutcome: "success",
        buildTriggerMetadata: {
          branch: "feature",
          commitHash: "b".repeat(40),
          repoName: "carpo",
          providerType: "github",
        },
      },
      metadata: { accountId: "wrong-account" },
    });
    await expect(
      resolveReviewInput(parsed!, {
        CLOUDFLARE_ACCOUNT_ID: "expected-account",
        EVIDENCE_BUCKET: {} as R2Bucket,
        TARGET_REVIEW_WORKER_NAME: "carpo-pr-review",
      }),
    ).resolves.toBeNull();
  });
});
