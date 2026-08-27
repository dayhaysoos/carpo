import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assembleVisualComparison,
  attachAgenticReview,
  createManualExecutionId,
  resolveExecutionMetadata,
  shouldCaptureVisualComparison,
} from "./run-pr-review.mjs";
import {
  resolveProofChallenge,
  selectProofChallenge,
} from "./pr-review-proof-challenges.mjs";

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

  it("requests before/after evidence only for user-interface changes", () => {
    assert.equal(
      shouldCaptureVisualComparison([
        { path: "web/src/pages/CreatorPage.tsx" },
      ]),
      true,
    );
    assert.equal(
      shouldCaptureVisualComparison([
        { path: "src/clip-service.ts" },
        { path: "test/api.test.ts" },
      ]),
      false,
    );
  });

  it("selects only the repository-owned one-time proof challenge path", () => {
    assert.equal(
      selectProofChallenge([
        { path: "review-challenges/multilingual-pants.json" },
      ])?.id,
      "multilingual-pants",
    );
    assert.equal(
      selectProofChallenge([
        { path: "docs/research/cloudflare-release-verification-harness.md" },
      ]),
      undefined,
    );
    assert.throws(
      () => resolveProofChallenge("instructions-from-pr-body"),
      /Unknown PR review proof challenge/,
    );
  });

  it("attaches advisory Flue evidence without changing the deterministic status", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-agentic-evidence-"));
    try {
      await Promise.all([
        writeFile(
          path.join(outputDir, "result.json"),
          JSON.stringify({ status: "passed", assertions: [], diagnostics: {} }),
        ),
        writeFile(path.join(outputDir, "summary.md"), "## Deterministic PASS\n"),
        writeFile(
          path.join(outputDir, "agentic-result.json"),
          JSON.stringify({
            schemaVersion: "carpo.pr-browser-review.agentic.v1",
            status: "completed",
            advisory: true,
            verdict: "needs_attention",
            summary: "One exploratory concern was found.",
            findings: [
              {
                severity: "warning",
                title: "Unclear state",
                evidence: "The current selection was ambiguous.",
              },
            ],
            proofBoundary: "Advisory only.",
          }),
        ),
      ]);

      await attachAgenticReview({
        outputDir,
        agenticReview: JSON.parse(
          await readFile(path.join(outputDir, "agentic-result.json"), "utf8"),
        ),
      });
      const result = JSON.parse(
        await readFile(path.join(outputDir, "result.json"), "utf8"),
      );
      const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
      assert.equal(result.status, "passed");
      assert.equal(result.agenticReview.verdict, "needs_attention");
      assert.match(summary, /Flue exploratory review \(advisory\)/);
      assert.match(summary, /Unclear state/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("neutralizes model-authored Markdown in the Actions summary", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-agentic-markdown-"));
    try {
      await Promise.all([
        writeFile(
          path.join(outputDir, "result.json"),
          JSON.stringify({ status: "passed", assertions: [], diagnostics: {} }),
        ),
        writeFile(path.join(outputDir, "summary.md"), "## Deterministic PASS\n"),
        writeFile(
          path.join(outputDir, "agentic-result.json"),
          JSON.stringify({
            schemaVersion: "carpo.pr-browser-review.agentic.v1",
            status: "completed",
            advisory: true,
            verdict: "needs_attention",
            summary: "# Forged heading ![forged](https://attacker.example/image.png)",
            findings: [
              {
                severity: "warning",
                title: "[Injected link](https://attacker.example)",
                evidence: "<img src=x onerror=alert(1)>",
              },
            ],
            proofBoundary: "**Not** a release gate.",
          }),
        ),
      ]);

      await attachAgenticReview({
        outputDir,
        agenticReview: JSON.parse(
          await readFile(path.join(outputDir, "agentic-result.json"), "utf8"),
        ),
      });
      const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
      assert.doesNotMatch(summary, /^# Forged/m);
      assert.doesNotMatch(summary, /!\[forged\]\(/);
      assert.doesNotMatch(summary, /<img src=/);
      assert.match(summary, /\\# Forged heading/);
      assert.match(summary, /&lt;img src=x onerror=alert/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("includes sanitized Flue provider diagnostics in the execution summary", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-agentic-diagnostics-"));
    try {
      await Promise.all([
        writeFile(
          path.join(outputDir, "result.json"),
          JSON.stringify({ status: "passed", assertions: [], diagnostics: {} }),
        ),
        writeFile(path.join(outputDir, "summary.md"), "## Deterministic PASS\n"),
        writeFile(
          path.join(outputDir, "agentic-result.json"),
          JSON.stringify({
            schemaVersion: "carpo.pr-browser-review.agentic.v1",
            status: "failed",
            advisory: true,
            verdict: "inconclusive",
            summary: "The Flue exploratory review did not complete.",
            failure: "[flue] Agent run failed.",
            findings: [],
            providerDiagnostics: {
              turns: [
                {
                  providerId: "cloudflare-workers-ai",
                  requestedModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
                  finishReason: "error",
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
            },
            proofBoundary: "Advisory only.",
          }),
        ),
      ]);

      await attachAgenticReview({
        outputDir,
        agenticReview: JSON.parse(
          await readFile(path.join(outputDir, "agentic-result.json"), "utf8"),
        ),
      });
      const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
      assert.match(summary, /Failure diagnostics/);
      assert.match(summary, /Workers AI upstream unavailable/);
      assert.match(summary, /operation\\_failed/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("assembles exact base/head screenshots into a paired evidence bundle", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-paired-evidence-"));
    const beforeDir = path.join(outputDir, "before");
    const afterDir = path.join(outputDir, "after");
    await mkdir(beforeDir);
    await mkdir(afterDir);

    try {
      await Promise.all([
        writeFile(path.join(beforeDir, "create.png"), "before"),
        writeFile(
          path.join(beforeDir, "result.json"),
          JSON.stringify({ status: "passed", screenshots: ["create.png"] }),
        ),
        writeFile(path.join(afterDir, "create.png"), "after"),
        writeFile(
          path.join(afterDir, "result.json"),
          JSON.stringify({
            status: "passed",
            screenshots: ["create.png"],
            assertions: [],
            diagnostics: {},
            proofBoundary: "Head proof.",
          }),
        ),
        writeFile(path.join(afterDir, "summary.md"), "Head summary.\n"),
      ]);

      await assembleVisualComparison({
        outputDir,
        beforeDir,
        afterDir,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        baselineStatus: "captured",
      });

      const result = JSON.parse(
        await readFile(path.join(outputDir, "result.json"), "utf8"),
      );
      assert.equal(result.visualEvidence.status, "paired");
      assert.deepEqual(result.visualEvidence.comparisons, [
        {
          id: "create",
          label: "Create",
          before: "before-create.png",
          after: "after-create.png",
        },
      ]);
      assert.equal(
        await readFile(path.join(outputDir, "before-create.png"), "utf8"),
        "before",
      );
      assert.equal(
        await readFile(path.join(outputDir, "after-create.png"), "utf8"),
        "after",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
