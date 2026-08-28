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
    async setViewport(preset) {
      calls.push(["setViewport", preset]);
      return preset === "mobile"
        ? { preset, width: 390, height: 844 }
        : { preset, width: 1440, height: 1000 };
    },
    async click(elementId) {
      calls.push(["click", elementId]);
      return { clicked: elementId };
    },
    async fill(elementId, value) {
      calls.push(["fill", elementId, value]);
      return { filled: elementId };
    },
    async listWebMcpTools() {
      calls.push(["listWebMcpTools"]);
      return {
        apiSurface: "navigator.modelContextTesting",
        tools: [
          { name: "getCarpoInstructions" },
          { name: "readClipWorkspace" },
          { name: "proposeClips" },
        ],
      };
    },
    async callWebMcpTool(input) {
      calls.push(["callWebMcpTool", input]);
      return { ok: true };
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
      "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
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
      proofChallenge: "multilingual-octopus",
    });
    assert.match(challengePrompt, /selected proof challenge multilingual-octopus/);
    assert.match(challengePrompt, /system instructions and host-enforced sequence/);
    assert.doesNotMatch(challengePrompt, /pulpo/);
    assert.match(
      buildAgenticReviewPrompt({
        executionId: "test-agentic-review",
        expectedVersionTag: "abc123",
        webMcpFixtureVideoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
      }),
      /live WebMCP journey/,
    );
    assert.equal(AGENTIC_REVIEW_LIMITS.maxToolCalls, 38);
    assert.equal(AGENTIC_REVIEW_LIMITS.maxFinishReminders, 8);
    assert.equal(AGENTIC_REVIEW_LIMITS.maxRepeatedFinishRejections, 2);
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
                category: "content",
                title: "Create shell rendered",
                description: "The upload-first Create shell was visible.",
                evidence: "Observed the upload-first Create surface.",
                path: "/",
                reproduction: ["Open the Create route."],
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
    assert.equal(result.providerDiagnostics.settlement.outcome, "completed");
    assert.equal(result.providerDiagnostics.turns.length, 5);
    assert.doesNotMatch(
      JSON.stringify(result.providerDiagnostics),
      /untrusted review data/,
    );
  });

  it("exposes each live WebMCP call through a typed Flue tool", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("list_webmcp_tools", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("webmcp_get_carpo_instructions", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("webmcp_read_clip_workspace", {
            transcriptOffset: 0,
            transcriptLimit: 4,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("webmcp_propose_clip", {
            requestId: "live-review-1",
            videoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
            workspaceRevision: "carpo-workspace-v1:fixture:revision",
            proposals: [
              {
                proposalId: "opening",
                title: "A concrete opening",
                startSeconds: 0,
                endSeconds: 4,
                sourceBlockIds: ["cue-0-0"],
                rationale: "The opening makes a concrete promise.",
              },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("capture_evidence", { note: "WebMCP review is visible" })],
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
            summary: "The bounded WebMCP journey completed.",
            testedAreas: ["Live WebMCP fixture"],
            findings: [],
            remainingRisks: ["Clip creation and playback were not exercised."],
            webMcpExperience: {
              verdict: "usable",
              summary: "The semantic tool journey was direct and inspectable.",
              strengths: ["The proposal remained editable."],
              frictions: [],
              recommendations: [],
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    const adapter = fakeAdapter();
    await runFlueAgenticReview({
      executionId: "test-webmcp-tools",
      expectedVersionTag: "abc123",
      adapter,
      model: "faux/faux-1",
      providers: [faux.provider],
      webMcpFixtureVideoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
      timeoutMs: 10_000,
    });

    assert.deepEqual(
      adapter.calls.filter(([name]) => name === "callWebMcpTool"),
      [
        [
          "callWebMcpTool",
          { name: "getCarpoInstructions", arguments: {} },
        ],
        [
          "callWebMcpTool",
          {
            name: "readClipWorkspace",
            arguments: { transcriptOffset: 0, transcriptLimit: 4 },
          },
        ],
        [
          "callWebMcpTool",
          {
            name: "proposeClips",
            arguments: {
              requestId: "live-review-1",
              videoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
              workspaceRevision: "carpo-workspace-v1:fixture:revision",
              proposals: [
                {
                  proposalId: "opening",
                  title: "A concrete opening",
                  startSeconds: 0,
                  endSeconds: 4,
                  sourceBlockIds: ["cue-0-0"],
                  rationale: "The opening makes a concrete promise.",
                },
              ],
            },
          },
        ],
      ],
    );
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

  it("terminates after the same rejected finish is repeated twice", async () => {
    const faux = fauxProvider();
    const rejectedReport = {
      verdict: "pass",
      summary: "Everything passed.",
      testedAreas: ["Create", "Library"],
      findings: [],
      remainingRisks: ["Upload was not exercised."],
    };
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("finish_review", rejectedReport)],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("finish_review", rejectedReport)],
        { stopReason: "toolUse" },
      ),
    ]);
    const adapter = fakeAdapter();
    adapter.finishReview = async (report) => {
      adapter.calls.push(["finishReview", report]);
      throw new Error(
        "Review incomplete:\n- Capture evidence on both the Create and Library entry points",
      );
    };

    await assert.rejects(
      runFlueAgenticReview({
        executionId: "test-repeated-finish",
        expectedVersionTag: "abc123",
        adapter,
        model: "faux/faux-1",
        providers: [faux.provider],
        timeoutMs: 10_000,
      }),
      /repeated the same rejected finish_review call twice.*Capture evidence/s,
    );
    assert.equal(
      adapter.calls.filter(([name]) => name === "finishReview").length,
      2,
    );
  });

  it("reserves diagnostics and structured completion after exploration is exhausted", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      ...Array.from({ length: AGENTIC_REVIEW_LIMITS.maxToolCalls }, () =>
        fauxAssistantMessage(
          [fauxToolCall("inspect_page", {})],
          { stopReason: "toolUse" },
        ),
      ),
      fauxAssistantMessage(
        [fauxToolCall("read_browser_diagnostics", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("finish_review", {
            verdict: "inconclusive",
            summary: "The bounded review exhausted its exploration budget.",
            testedAreas: ["Create"],
            findings: [],
            remainingRisks: ["Further exploratory coverage remains unverified."],
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    const result = await runFlueAgenticReview({
      executionId: "test-budgeted-finish",
      expectedVersionTag: "abc123",
      adapter: fakeAdapter(),
      model: "faux/faux-1",
      providers: [faux.provider],
      timeoutMs: 10_000,
    });

    assert.equal(result.report.verdict, "inconclusive");
    assert.equal(result.toolCalls, AGENTIC_REVIEW_LIMITS.maxToolCalls + 2);
  });

  it("retains sanitized provider and settlement diagnostics when a model turn fails", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("inspect_page", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "Workers AI upstream unavailable; echoed provider-secret-123",
      }),
    ]);

    const originalConsoleError = console.error;
    console.error = () => {};
    let capturedError;
    try {
      await assert.rejects(
        runFlueAgenticReview({
          executionId: "test-provider-failure",
          expectedVersionTag: "abc123",
          adapter: fakeAdapter(),
          model: "faux/faux-1",
          providers: [faux.provider],
          runtimeEnv: {
            CLOUDFLARE_API_KEY: "provider-secret-123",
          },
          timeoutMs: 10_000,
        }),
        (error) => {
          capturedError = error;
          return /Agent run failed/.test(error.message);
        },
      );
    } finally {
      console.error = originalConsoleError;
    }

    const diagnostics = capturedError.agenticProgress.providerDiagnostics;
    assert.equal(diagnostics.turns.length, 2);
    assert.equal(diagnostics.turns[0].finishReason, "toolUse");
    assert.equal(diagnostics.turns[1].finishReason, "error");
    assert.equal(diagnostics.turns[1].providerId, "faux");
    assert.match(
      diagnostics.turns[1].error.message,
      /Workers AI upstream unavailable/,
    );
    assert.doesNotMatch(JSON.stringify(diagnostics), /provider-secret-123/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /\"stack\"/);
    assert.equal(diagnostics.settlement.outcome, "failed");
    assert.equal(diagnostics.cause.type, "operation_failed");
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
