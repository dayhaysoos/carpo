import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEvidenceKey,
  renderReviewComment,
  resolveCommentAuthor,
  upsertReviewComment,
} from "./publish-pr-review-evidence.mjs";

const SHA = "f5e8a926f693a9244bda6084bd0d09a1880690e0";
const INPUTS = {
  repository: "dayhaysoos/carpo",
  pr: "8",
  sha: SHA,
  executionId: "actions-32981962097-1",
  sourceUrl: "https://github.com/dayhaysoos/carpo/actions/runs/32981962097",
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

describe("PR review evidence publisher", () => {
  it("builds an immutable, run-specific evidence key", () => {
    assert.equal(
      buildEvidenceKey(INPUTS, "create.png"),
      `pull-requests/8/${SHA}/executions/actions-32981962097-1/create.png`,
    );
    assert.equal(
      buildEvidenceKey(INPUTS, "before-create.png"),
      `pull-requests/8/${SHA}/executions/actions-32981962097-1/before-create.png`,
    );
    assert.throws(
      () => buildEvidenceKey(INPUTS, "trace.zip"),
      /Unsupported evidence filename/,
    );
  });

  it("renders inline screenshots, exact candidate links, and the proof boundary", () => {
    const body = renderReviewComment({
      ...INPUTS,
      workflowStatus: "success",
      result: {
        status: "passed",
        assertions: [{ label: "Create renders", status: "passed" }],
        diagnostics: { consoleErrors: [], failedRequests: [] },
        proofBoundary: "This proves the bounded browser surfaces only.",
      },
      evidence: [
        {
          label: "Create",
          url: `https://carpo-pr-review.ndejesus1227.workers.dev/api/review/evidence/pull-requests/8/${SHA}/executions/actions-32981962097-1/create.png`,
        },
      ],
    });

    assert.match(body, /<!-- carpo-pr-browser-review -->/);
    assert.match(body, /Carpo PR browser review: ✅ PASS/);
    assert.match(body, /<img src="https:\/\/carpo-pr-review/);
    assert.match(body, /1\/1 passed/);
    assert.match(body, /expire after 14 days/);
    assert.match(body, /bounded browser surfaces only/);
  });

  it("renders exact base and head screenshots side by side", () => {
    const beforeUrl = `https://carpo-pr-review.ndejesus1227.workers.dev/api/review/evidence/pull-requests/8/${SHA}/executions/actions-32981962097-1/before-create.png`;
    const afterUrl = `https://carpo-pr-review.ndejesus1227.workers.dev/api/review/evidence/pull-requests/8/${SHA}/executions/actions-32981962097-1/after-create.png`;
    const body = renderReviewComment({
      ...INPUTS,
      workflowStatus: "success",
      result: {
        status: "passed",
        assertions: [],
        diagnostics: {},
        proofBoundary: "Bounded proof.",
        visualEvidence: {
          requested: true,
          status: "paired",
          baseSha: "37f96f3adf366f61513e8be2dd6c3f07d2a4e36c",
          headSha: SHA,
          comparisons: [
            {
              id: "create",
              label: "Create",
              before: "before-create.png",
              after: "after-create.png",
            },
          ],
        },
      },
      evidence: [
        { file: "before-create.png", label: "Create before", url: beforeUrl },
        { file: "after-create.png", label: "Create after", url: afterUrl },
      ],
    });

    assert.match(body, /Before · base/);
    assert.match(body, /After · head/);
    assert.match(body, /37f96f3/);
    assert.match(body, /f5e8a92/);
    assert.match(body, new RegExp(beforeUrl.replaceAll("/", "\\/")));
    assert.match(body, new RegExp(afterUrl.replaceAll("/", "\\/")));
  });

  it("renders bounded Flue findings and their screenshot evidence as advisory", () => {
    const agenticUrl = `https://carpo-pr-review.ndejesus1227.workers.dev/api/review/evidence/pull-requests/8/${SHA}/executions/actions-32981962097-1/agentic-01.png`;
    const body = renderReviewComment({
      ...INPUTS,
      workflowStatus: "success",
      result: {
        status: "passed",
        assertions: [],
        diagnostics: {},
        proofBoundary: "Deterministic proof.",
        agenticReview: {
          status: "completed",
          advisory: true,
          verdict: "needs_attention",
          summary: "The agent found one concrete concern.",
          findings: [
            {
              severity: "warning",
              title: "Ambiguous state",
              evidence: "The selected view was unclear.",
              screenshot: "agentic-01.png",
            },
          ],
          screenshots: [
            {
              file: "agentic-01.png",
              note: "Library state after navigation",
              path: "/library",
            },
          ],
          remainingRisks: ["Upload and encoding were not exercised."],
          proofBoundary: "Advisory exact-candidate exploration only.",
        },
      },
      evidence: [
        {
          file: "agentic-01.png",
          label: "Flue evidence 01",
          url: agenticUrl,
        },
      ],
    });

    assert.match(body, /Flue exploratory review \(advisory\)/);
    assert.match(body, /NEEDS ATTENTION/);
    assert.match(body, /Ambiguous state/);
    assert.match(body, /Library state after navigation/);
    assert.match(body, /\/library/);
    assert.match(body, /Upload and encoding were not exercised/);
    assert.match(body, new RegExp(agenticUrl.replaceAll("/", "\\/")));
  });

  it("keeps failure text from injecting markup into the PR comment", () => {
    const body = renderReviewComment({
      ...INPUTS,
      workflowStatus: "failure",
      result: {
        status: "failed",
        assertions: [],
        diagnostics: {},
        failure: 'bad\n<img src="https://attacker.example/pixel">',
        proofBoundary: "No proof.\n![pixel](https://attacker.example/pixel)",
      },
      evidence: [],
    });

    assert.doesNotMatch(body, /<img src="https:\/\/attacker/);
    assert.doesNotMatch(body, /!\[pixel\]/);
    assert.match(body, /&lt;img src=&quot;https:\/\/attacker/);
  });

  it("uses the supplied Actions identity without calling the unsupported user endpoint", async () => {
    const author = await resolveCommentAuthor({
      authorLogin: "github-actions[bot]",
      token: "installation-token",
      fetchImpl: async () => {
        throw new Error("GET /user must not run for an Actions installation token");
      },
    });

    assert.equal(author, "github-actions[bot]");
  });

  it("discovers the reporting user for a local manual run", async () => {
    const requests = [];
    const author = await resolveCommentAuthor({
      token: "user-token",
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse({ login: "dayhaysoos" });
      },
    });

    assert.equal(author, "dayhaysoos");
    assert.deepEqual(requests, ["https://api.github.com/user"]);
  });

  it("updates the existing Actions bot comment instead of creating duplicates", async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
      requests.push({ url, init });
      if (init.method === "PATCH") {
        return jsonResponse({ id: 42, html_url: "https://github.com/comment/42" });
      }
      return jsonResponse([
        {
          id: 42,
          body: "<!-- carpo-pr-browser-review -->\nold",
          user: { login: "github-actions[bot]" },
        },
      ]);
    };

    const result = await upsertReviewComment({
      fetchImpl,
      token: "test-token",
      repository: INPUTS.repository,
      pr: INPUTS.pr,
      body: "new comment",
      authorLogin: "github-actions[bot]",
    });

    assert.equal(result.action, "updated");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].init.method, "PATCH");
    assert.equal(
      requests[1].url,
      "https://api.github.com/repos/dayhaysoos/carpo/issues/comments/42",
    );
    assert.deepEqual(JSON.parse(requests[1].init.body), { body: "new comment" });
  });

  it("creates the marker comment when none exists", async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
      requests.push({ url, init });
      if (init.method === "POST") {
        return jsonResponse({ id: 43, html_url: "https://github.com/comment/43" });
      }
      return jsonResponse([]);
    };

    const result = await upsertReviewComment({
      fetchImpl,
      token: "test-token",
      repository: INPUTS.repository,
      pr: INPUTS.pr,
      body: "new comment",
      authorLogin: "github-actions[bot]",
    });

    assert.equal(result.action, "created");
    assert.equal(requests[1].init.method, "POST");
    assert.equal(
      requests[1].url,
      "https://api.github.com/repos/dayhaysoos/carpo/issues/8/comments",
    );
  });
});
