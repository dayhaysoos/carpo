import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REVIEW_SERVICE_URL,
  extractDurableReview,
  resolveReviewServiceUrl,
} from "./run-durable-flue-review.mjs";

test("durable review service URL is an exact HTTPS origin", () => {
  assert.equal(resolveReviewServiceUrl(), DEFAULT_REVIEW_SERVICE_URL);
  assert.equal(resolveReviewServiceUrl("https://review.example.com/"), "https://review.example.com");
  assert.throws(
    () => resolveReviewServiceUrl("https://review.example.com/path"),
    /exact HTTPS origin/,
  );
  assert.throws(() => resolveReviewServiceUrl("http://review.example.com"), /HTTPS/);
});

test("extractDurableReview requires a completed structured data part", () => {
  const report = {
    schemaVersion: "carpo.pr-browser-review.agentic.v1",
    status: "completed",
    verdict: "pass",
  };
  assert.equal(
    extractDurableReview({ data: { reviewReport: [{ status: "old" }, report] } }),
    report,
  );
  assert.throws(() => extractDurableReview({ data: {} }), /structured report/);
  assert.throws(
    () =>
      extractDurableReview({
        data: {
          reviewReport: [
            { schemaVersion: report.schemaVersion, status: "failed" },
          ],
        },
      }),
    /invalid report/,
  );
});
