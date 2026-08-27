import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AGENTIC_REVIEW_LIMITS,
  buildAgenticReviewPrompt,
  resolveAgenticModel,
  runFlueAgenticReview,
  withScopedProviderEnv,
} from "./flue-pr-review-agent.mjs";

function fakeAdapter() {
  const calls = [];
  const screenshots = new Set();
  let activeReads = 0;
  let maxConcurrentReads = 0;
  return {
    calls,
    get maxConcurrentReads() {
      return maxConcurrentReads;
    },
    async readReviewMaterial(input) {
      activeReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push(["readReviewMaterial", input]);
      activeReads -= 1;
      return { source: input.source, offset: input.offset, text: "untrusted review data" };
    },
    async inspectPage() {
      calls.push(["inspectPage"]);
      return {
        url: "https://carpo-pr-review.ndejesus1227.workers.dev/",
        text: "Carpo New clip",
        elements: [],
      };
    },
    async navigate(path) {
      calls.push(["navigate", path]);
      return { url: `https://carpo-pr-review.ndejesus1227.workers.dev${path}` };
    },
    async click(elementId) {
      calls.push(["click", elementId]);
      return { clicked: elementId };
    },
    async fill(elementId, value) {
      calls.push(["fill", elementId, value]);
      return { filled: elementId };
    },
    async captureEvidence(note) {
      calls.push(["captureEvidence", note]);
      screenshots.add("agentic-01.png");
      return { file: "agentic-01.png", note };
    },
    async readDiagnostics() {
      calls.push(["readDiagnostics"]);
      return { consoleErrors: [], pageErrors: [], failedRequests: [], serverErrors: [] };
    },
    async finishReview(report) {
      calls.push(["finishReview", report]);
      for (const finding of report.findings) {
        if (finding.screenshot && !screenshots.has(finding.screenshot)) {
          throw new Error("unknown screenshot");
        }
      }
      return report;
    },
  };
}

describe("Flue PR review agent", () => {
  it("validates bounded execution and model identifiers", () => {
    assert.equal(
      resolveAgenticModel(""),
      "cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
    );
    assert.equal(resolveAgenticModel("anthropic/claude-sonnet-4-6"), "anthropic/claude-sonnet-4-6");
    assert.throws(() => resolveAgenticModel("../../bad"), /invalid provider\/model/);
    assert.match(
      buildAgenticReviewPrompt({
        executionId: "test-agentic-review",
        expectedVersionTag: "abc123",
      }),
      /exact Worker version tag abc123/,
    );
    const challengePrompt = buildAgenticReviewPrompt({
      executionId: "test-agentic-review",
      expectedVersionTag: "abc123",
      proofChallenge: "multilingual-pants",
    });
    assert.match(challengePrompt, /Trusted host proof challenge/);
    assert.match(challengePrompt, /English = "pants"/);
    assert.match(challengePrompt, /Spanish = "pantalones"/);
    assert.match(challengePrompt, /French = "pantalon"/);
    assert.match(challengePrompt, /Japanese = "ズボン"/);
    assert.match(challengePrompt, /Do not submit/);
    assert.equal(AGENTIC_REVIEW_LIMITS.maxToolCalls, 30);
    assert.equal(AGENTIC_REVIEW_LIMITS.maxFinishReminders, 8);
  });

  it("exposes Cloudflare provider credentials only for the bounded run", async () => {
    const originalKey = process.env.CLOUDFLARE_API_KEY;
    const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_KEY;
    process.env.CLOUDFLARE_ACCOUNT_ID = "existing-account";
    try {
      await withScopedProviderEnv(
        {
          CLOUDFLARE_API_KEY: "ephemeral-key",
          CLOUDFLARE_ACCOUNT_ID: "ephemeral-account",
        },
        async () => {
          assert.equal(process.env.CLOUDFLARE_API_KEY, "ephemeral-key");
          assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, "ephemeral-account");
        },
      );
      assert.equal(process.env.CLOUDFLARE_API_KEY, undefined);
      assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, "existing-account");
    } finally {
      if (originalKey === undefined) delete process.env.CLOUDFLARE_API_KEY;
      else process.env.CLOUDFLARE_API_KEY = originalKey;
      if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    }
  });

  it("lets Flue choose browser tools and requires a structured finish", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read_review_material", { source: "context", offset: 0 }),
          fauxToolCall("read_review_material", { source: "diff", offset: 0 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("inspect_page", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("capture_evidence", { note: "Create page rendered" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("read_browser_diagnostics", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("finish_review", {
            verdict: "pass",
            summary: "The bounded Create surface inspection found no concrete issue.",
            testedAreas: ["Create shell"],
            findings: [
              {
                severity: "info",
                title: "Create shell rendered",
                evidence: "Observed the upload-first Create surface.",
                screenshot: "agentic-01.png",
              },
            ],
            remainingRisks: ["Upload and encoding were not exercised."],
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Review complete.")]),
    ]);

    const adapter = fakeAdapter();
    const result = await runFlueAgenticReview({
      executionId: "test-agentic-review",
      expectedVersionTag: "abc123",
      adapter,
      model: "faux/faux-1",
      providers: [faux.provider],
      timeoutMs: 10_000,
    });

    assert.equal(result.report.verdict, "pass");
    assert.equal(result.report.findings[0].screenshot, "agentic-01.png");
    assert.deepEqual(
      adapter.calls.map(([name]) => name),
      [
        "readReviewMaterial",
        "readReviewMaterial",
        "inspectPage",
        "captureEvidence",
        "readDiagnostics",
        "finishReview",
      ],
    );
    assert.equal(adapter.maxConcurrentReads, 1);
    assert.equal(result.toolCalls, 6);
  });

  it("fails closed when the model never calls finish_review", async () => {
    const faux = fauxProvider();
    faux.setResponses(
      Array.from({ length: 9 }, () =>
        fauxAssistantMessage([fauxText("Looks fine.")]),
      ),
    );

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        runFlueAgenticReview({
          executionId: "test-missing-finish",
          expectedVersionTag: "abc123",
          adapter: fakeAdapter(),
          model: "faux/faux-1",
          providers: [faux.provider],
          timeoutMs: 10_000,
        }),
        /Agent run failed|without calling finish_review/,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("records the host-normalized screenshot note in the timeline", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("capture_evidence", { note: "Clip creation verified" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("finish_review", {
            verdict: "inconclusive",
            summary: "The bounded review was inconclusive.",
            testedAreas: [],
            findings: [],
            remainingRisks: ["No product behavior was established."],
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    const adapter = fakeAdapter();
    adapter.captureEvidence = async (note) => ({
      file: "agentic-01.png",
      note:
        note === "Clip creation verified"
          ? "The host omitted an unsupported coverage claim from this screenshot note."
          : note,
    });
    const result = await runFlueAgenticReview({
      executionId: "test-note-normalization",
      expectedVersionTag: "abc123",
      adapter,
      model: "faux/faux-1",
      providers: [faux.provider],
      timeoutMs: 10_000,
    });

    assert.equal(
      result.timeline[0].input.note,
      "The host omitted an unsupported coverage claim from this screenshot note.",
    );
  });
});
