import { describe, expect, it, vi } from "vitest";
import { handleReviewEvidence } from "../src/review-evidence";

const EVIDENCE_KEY =
  "pull-requests/8/f5e8a926f693a9244bda6084bd0d09a1880690e0/executions/actions-32981962097-1/create.png";
const EVIDENCE_URL = `https://review.example/api/review/evidence/${EVIDENCE_KEY}`;

function evidenceObject(body?: ReadableStream) {
  return {
    body,
    httpEtag: '"evidence-etag"',
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "application/octet-stream");
    },
  };
}

function evidenceBucket() {
  return {
    get: vi.fn(async () => evidenceObject(new Blob(["png"]).stream())),
    head: vi.fn(async () => evidenceObject()),
  };
}

describe("public PR review evidence", () => {
  it("does not expose an evidence route outside the isolated review environment", async () => {
    await expect(
      handleReviewEvidence(new Request(EVIDENCE_URL), {}),
    ).resolves.toBeNull();
  });

  it("streams an allowlisted PNG with safe public response headers", async () => {
    const bucket = evidenceBucket();
    const response = await handleReviewEvidence(new Request(EVIDENCE_URL), {
      PR_REVIEW_MODE: "enabled",
      PR_REVIEW_EVIDENCE_BUCKET: bucket,
    });

    expect(response?.status).toBe(200);
    expect(new TextDecoder().decode(await response?.arrayBuffer())).toBe("png");
    expect(response?.headers.get("Content-Type")).toBe("image/png");
    expect(response?.headers.get("Content-Disposition")).toBe("inline");
    expect(response?.headers.get("Cache-Control")).toContain("immutable");
    expect(response?.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin",
    );
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response?.headers.get("ETag")).toBe('"evidence-etag"');
    expect(bucket.get).toHaveBeenCalledWith(EVIDENCE_KEY);
  });

  it("uses metadata-only reads for HEAD requests", async () => {
    const bucket = evidenceBucket();
    const response = await handleReviewEvidence(
      new Request(EVIDENCE_URL, { method: "HEAD" }),
      {
        PR_REVIEW_MODE: "enabled",
        PR_REVIEW_EVIDENCE_BUCKET: bucket,
      },
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
    expect(bucket.head).toHaveBeenCalledWith(EVIDENCE_KEY);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it.each([
    "pull-requests/8/not-a-sha/executions/actions-1-1/create.png",
    "pull-requests/8/f5e8a926f693a9244bda6084bd0d09a1880690e0/executions/actions-1-1/trace.zip",
    "pull-requests/0/f5e8a926f693a9244bda6084bd0d09a1880690e0/executions/actions-1-1/create.png",
    "pull-requests/8/f5e8a926f693a9244bda6084bd0d09a1880690e0/executions/manual-bad/create.png",
  ])("rejects a non-allowlisted evidence key: %s", async (key) => {
    const bucket = evidenceBucket();
    const response = await handleReviewEvidence(
      new Request(`https://review.example/api/review/evidence/${key}`),
      {
        PR_REVIEW_MODE: "enabled",
        PR_REVIEW_EVIDENCE_BUCKET: bucket,
      },
    );

    expect(response?.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("does not treat a normalized traversal path as public evidence", async () => {
    const bucket = evidenceBucket();
    const response = await handleReviewEvidence(
      new Request(
        "https://review.example/api/review/evidence/../clips/private.png",
      ),
      {
        PR_REVIEW_MODE: "enabled",
        PR_REVIEW_EVIDENCE_BUCKET: bucket,
      },
    );

    expect(response).toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("rejects writes to the public evidence path", async () => {
    const bucket = evidenceBucket();
    const response = await handleReviewEvidence(
      new Request(EVIDENCE_URL, { method: "PUT" }),
      {
        PR_REVIEW_MODE: "enabled",
        PR_REVIEW_EVIDENCE_BUCKET: bucket,
      },
    );

    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("GET, HEAD");
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("fails closed when the review evidence binding is missing", async () => {
    const response = await handleReviewEvidence(new Request(EVIDENCE_URL), {
      PR_REVIEW_MODE: "enabled",
    });

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });
});
