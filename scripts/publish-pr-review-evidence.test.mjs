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
              category: "navigation",
              title: "Ambiguous state",
              description: "The selected Library view did not identify itself clearly.",
              evidence: "The selected view was unclear.",
              path: "/library",
              reproduction: ["Open Library.", "Select the archived view."],
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
          reportUrl:
            "https://carpo-pr-review-agent.ndejesus1227.workers.dev/reports/manual-20260827T120000Z-1234abcd",
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
    assert.match(body, /navigation/);
    assert.match(body, /Reproduce/);
    assert.match(body, /Select the archived view/);
    assert.match(body, /Library state after navigation/);
    assert.match(body, /\/library/);
    assert.match(body, /Upload and encoding were not exercised/);
    assert.match(body, /private durable report and Browser Run replay/);
    assert.match(body, new RegExp(agenticUrl.replaceAll("/", "\\/")));
  });

  it("renders bounded Flue provider failure diagnostics", () => {
    const body = renderReviewComment({
      ...INPUTS,
      workflowStatus: "success",
      result: {
        status: "passed",
        assertions: [],
        diagnostics: {},
        proofBoundary: "Deterministic proof.",
        agenticReview: {
          status: "failed",
          advisory: true,
          verdict: "inconclusive",
          summary: "The Flue exploratory review did not complete.",
          failure: "[flue] Agent run failed.",
          providerDiagnostics: {
            turns: [
              {
                turnId: "turn-2",
                providerId: "cloudflare-workers-ai",
                requestedModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
                durationMs: 912,
                finishReason: "error",
                providerFinishReason: "upstream_error",
                gatewayLogId: "gateway-log-123",
                error: {
                  type: "_OTHER",
                  message: "Workers AI upstream unavailable.",
                },
              },
            ],
            settlement: {
              outcome: "failed",
              error: {
                type: "operation_failed",
                message: "Agent operation failed.",
              },
            },
            cause: {
              type: "operation_failed",
              message: "Agent operation failed.",
            },
          },
          proofBoundary: "Advisory only.",
        },
      },
      evidence: [],
    });

    assert.match(body, /Failure diagnostics/);
    assert.match(body, /cloudflare\\-workers\\-ai/);
    assert.match(body, /llama\\-4\\-scout/);
    assert.match(body, /upstream\\_error/);
    assert.match(body, /gateway\\-log\\-123/);
    assert.match(body, /Workers AI upstream unavailable/);
    assert.match(body, /operation\\_failed/);
  });

  it("keeps successful provider telemetry out of the failure section", () => {
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
          verdict: "pass",
          summary: "The bounded review completed.",
          providerDiagnostics: {
            turns: [
              {
                providerId: "cloudflare-workers-ai",
                requestedModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
                finishReason: "toolUse",
              },
            ],
            failedOperations: [],
            recoveries: [],
            settlement: { outcome: "completed" },
          },
          proofBoundary: "Advisory only.",
        },
      },
      evidence: [],
    });

    assert.doesNotMatch(body, /Failure diagnostics/);
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

  it("neutralizes mentions in model-authored PR evidence", () => {
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
          summary: "@octocat should inspect this.",
          findings: [
            {
              severity: "warning",
              category: "content",
              title: "Notify @team",
              description: "The page visibly included @everyone.",
              evidence: "Observed @maintainers in rendered content.",
              path: "/",
              reproduction: ["Ask @reviewers to open Create."],
            },
          ],
          remainingRisks: ["@security has not reviewed this."],
          proofBoundary: "Advisory only.",
        },
      },
      evidence: [],
    });

    assert.doesNotMatch(body, /@(octocat|team|everyone|maintainers|reviewers|security)/);
    assert.match(body, /&#64;octocat/);
    assert.match(body, /&#64;team/);
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
