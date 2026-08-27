import { describe, expect, it } from "vitest";
import {
  handleReviewAccess,
  PR_REVIEW_COOKIE,
} from "../src/review-access";

const REVIEW_TOKEN = "review-token-for-tests";
const REVIEW_ENV = {
  PR_REVIEW_AUTH_TOKEN: REVIEW_TOKEN,
  PR_REVIEW_MODE: "enabled",
} as const;
const VERSION = {
  id: "version-id",
  tag: "candidate-sha",
  timestamp: "2026-08-26T12:00:00.000Z",
};

function reviewRequest(path = "/", token?: string, method = "GET"): Request {
  const headers = token
    ? { Cookie: `${PR_REVIEW_COOKIE}=${token}` }
    : undefined;
  return new Request(`https://review.example${path}`, { headers, method });
}

describe("PR review access", () => {
  it("does not change production requests when no review token is configured", async () => {
    await expect(handleReviewAccess(reviewRequest(), {})).resolves.toBeNull();
  });

  it("does not activate the gate when production accidentally has the review secret", async () => {
    await expect(
      handleReviewAccess(reviewRequest(), {
        PR_REVIEW_AUTH_TOKEN: REVIEW_TOKEN,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the review environment is missing its required token", async () => {
    const response = await handleReviewAccess(reviewRequest(), {
      PR_REVIEW_MODE: "enabled",
      CF_VERSION_METADATA: VERSION,
    });

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing and incorrect review cookies", async () => {
    const missing = await handleReviewAccess(reviewRequest(), REVIEW_ENV);
    const incorrect = await handleReviewAccess(
      reviewRequest("/", "incorrect"),
      REVIEW_ENV,
    );

    expect(missing?.status).toBe(401);
    expect(incorrect?.status).toBe(401);
    expect(missing?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("allows an authenticated review request to continue", async () => {
    await expect(
      handleReviewAccess(reviewRequest("/", REVIEW_TOKEN), {
        ...REVIEW_ENV,
      }),
    ).resolves.toBeNull();
  });

  it("returns version metadata only to an authenticated reviewer", async () => {
    const response = await handleReviewAccess(
      reviewRequest("/api/review/identity", REVIEW_TOKEN),
      {
        ...REVIEW_ENV,
        CF_VERSION_METADATA: VERSION,
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(VERSION);
  });

  it.each([
    ["POST", "/api/internal/jobs/clip/status"],
    ["PUT", "/api/internal/jobs/clip/artifacts/mp4"],
    ["PUT", "/api/internal/jobs/clip/artifacts/thumbnail"],
    ["GET", "/api/internal/jobs/clip/source"],
  ])("leaves %s %s to per-job authentication", async (method, path) => {
    await expect(
      handleReviewAccess(reviewRequest(path, undefined, method), REVIEW_ENV),
    ).resolves.toBeNull();
  });

  it.each([
    ["GET", "/api/internal/jobs/not-a-callback"],
    ["POST", "/api/internal/jobs/clip/nested/status"],
    ["PUT", "/api/internal/jobs/clip/artifacts/other"],
    ["GET", "/api/internal/jobs/clip/nested/source"],
    ["DELETE", "/api/internal/jobs/clip/source"],
  ])("does not exempt unknown callback shape %s %s", async (method, path) => {
    const response = await handleReviewAccess(
      reviewRequest(path, undefined, method),
      REVIEW_ENV,
    );

    expect(response?.status).toBe(401);
  });
});
