import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as v from "valibot";
import {
  AGENTIC_REVIEW_SCHEMA_VERSION,
  CARPO_WEBMCP_KNOWN_TOOL_NAMES,
  CARPO_WEBMCP_REVIEW_TOOL_NAMES,
  agenticReviewResultSchema,
  appendDiagnosticsFinding,
  assertProofChallengeEvidence,
  assertProofChallengeFill,
  assertReviewComplete,
  assertSafeReviewClick,
  assertSafeReviewFill,
  buildReviewerInstructions,
  durableReviewInitialDataSchema,
  durableReviewResultSchema,
  enforceCoverageBoundary,
  isConsequentialElement,
  isReadOnlyBrowserMethod,
  MISSING_ROUTE_PATH,
  nextProofChallengeStep,
  parseAgenticReviewResult,
  resolveProofChallenge,
  resolveSafeReviewPath,
  reviewReportInputSchema,
} from "../src/index.js";

const origin = "https://carpo-pr-review.example.workers.dev";
const finding = {
  severity: "warning",
  category: "layout",
  title: "Overflow",
  description: "The Library content crosses the viewport.",
  evidence: "The measured scroll width exceeds the viewport.",
  path: "/library",
  reproduction: ["Open Library on the mobile viewport."],
  screenshot: "agentic-02.png",
};
const report = {
  verdict: "pass",
  summary: "The bounded surfaces had no concrete issue.",
  testedAreas: ["Create", "Library"],
  findings: [],
  remainingRisks: ["Upload execution was not exercised."],
};
const completeProgress = {
  readSources: ["context", "diff"],
  visitedPaths: ["/", "/library", "/__carpo-review-missing"],
  navigationStatuses: { "/__carpo-review-missing": 404 },
  layoutChecks: ["desktop", "mobile"],
  currentPath: "/library",
  diagnosticsRead: true,
  screenshots: [
    { file: "agentic-01.png", path: "/" },
    { file: "agentic-02.png", path: "/library" },
  ],
  proofChallengeSteps: [],
  pendingProofChallenge: null,
};

describe("bounded review policy contract", () => {
  it("keeps the external result schema at v1", () => {
    assert.equal(AGENTIC_REVIEW_SCHEMA_VERSION, "carpo.pr-browser-review.agentic.v1");
    assert.ok(reviewReportInputSchema);
    assert.ok(agenticReviewResultSchema);
    assert.ok(durableReviewInitialDataSchema);
    assert.ok(durableReviewResultSchema);
  });

  it("distinguishes required fixture tools from legitimate Carpo capabilities", () => {
    assert.deepEqual(CARPO_WEBMCP_REVIEW_TOOL_NAMES, [
      "getCarpoInstructions",
      "readClipWorkspace",
      "proposeClips",
    ]);
    assert.deepEqual(CARPO_WEBMCP_KNOWN_TOOL_NAMES, [
      "getCarpoInstructions",
      "readClipWorkspace",
      "proposeClips",
      "readCaptionTrack",
      "proposeCaptionTrack",
      "getCarpoLibraryInstructions",
      "searchPrivateLibrary",
      "prepareLibraryMomentReview",
      "getCarpoVisualInstructions",
      "searchVisualMoments",
      "prepareVisualMomentReview",
    ]);
  });

  it("owns the shared route and action safety policy", () => {
    assert.equal(resolveSafeReviewPath("/create", origin), "/create");
    assert.equal(resolveSafeReviewPath("/create?video=8a8dfc12-2917-4331-92db-8ae8a45e7621", origin), "/create?video=8a8dfc12-2917-4331-92db-8ae8a45e7621");
    assert.throws(() => resolveSafeReviewPath("/create?action=delete", origin));
    assert.equal(resolveSafeReviewPath("/library?view=archived", origin), "/library?view=archived");
    assert.equal(resolveSafeReviewPath("/__carpo-review-missing", origin), "/__carpo-review-missing");
    assert.throws(() => resolveSafeReviewPath("/api/review/identity", origin));
    assert.throws(() => resolveSafeReviewPath("https://evil.example/", origin));
    assert.equal(isConsequentialElement({ tag: "button", text: "Create clip" }), true);
    assert.equal(isConsequentialElement({ tag: "button", role: "tab", text: "Archived" }), false);
    assert.equal(isReadOnlyBrowserMethod("head"), true);
    assert.equal(isReadOnlyBrowserMethod("POST"), false);
    assert.doesNotThrow(() =>
      assertSafeReviewClick(
        { tag: "a", role: "link", href: `${origin}/library` },
        origin,
      ),
    );
    assert.throws(
      () =>
        assertSafeReviewClick(
          { tag: "a", role: "link", href: "https://evil.example/library" },
          origin,
        ),
      /External links/i,
    );
    assert.doesNotThrow(() =>
      assertSafeReviewFill({ tag: "input", type: "text", name: "Title" }, "shirt"),
    );
    assert.throws(
      () => assertSafeReviewFill({ tag: "input", type: "file" }, "movie.mp4"),
      /outside the advisory review authority/i,
    );
  });

  it("uses the stricter coverage policy and preserves the full proof boundary", () => {
    const bounded = enforceCoverageBoundary({
      ...report,
      summary: "Direct API smoke checks passed and upload works.",
      testedAreas: ["Direct API", "Create"],
      findings: [
        {
          ...finding,
          title: "Encoding works",
          evidence: "Encoding was verified.",
        },
      ],
      remainingRisks: [],
    });
    assert.equal(bounded.verdict, "inconclusive");
    assert.deepEqual(bounded.testedAreas, ["Create"]);
    assert.equal(bounded.findings.length, 1);
    assert.match(bounded.findings[0].title, /exceeded browser authority/i);
    assert.match(bounded.remainingRisks.at(-1), /Direct API behavior/);
  });

  it("allows explicit negative boundaries without weakening coverage enforcement", () => {
    const bounded = enforceCoverageBoundary({
      ...report,
      summary:
        "The Create and Library shells rendered. Upload, encoding, and media playback remain outside bounded review authority.",
    });

    assert.equal(bounded.verdict, "pass");
    assert.equal(bounded.summary, "The Create and Library shells rendered. Upload, encoding, and media playback remain outside bounded review authority.");
    assert.deepEqual(bounded.findings, []);
  });

  it("counts every local and durable diagnostic collection", () => {
    const bounded = appendDiagnosticsFinding(report, {
      console: [{}],
      consoleErrors: [{}],
      pageErrors: [{}],
      requestFailures: [{}],
      failedRequests: [{}],
      serverErrors: [{}],
      blockedMutations: [{}],
    });
    assert.equal(bounded.verdict, "needs_attention");
    assert.match(bounded.findings.at(-1).evidence, /7 .* diagnostic entries/i);
  });

  it("validates completion and finding evidence through one interface", () => {
    assert.doesNotThrow(() =>
      assertReviewComplete({
        progress: completeProgress,
        report: { ...report, findings: [finding] },
        reviewOrigin: origin,
      }),
    );
    assert.throws(
      () =>
        assertReviewComplete({
          progress: completeProgress,
          report: {
            ...report,
            findings: [{ ...finding, path: "/", screenshot: "agentic-02.png" }],
          },
          reviewOrigin: origin,
        }),
      /path does not match/i,
    );
    assert.throws(
      () =>
        assertReviewComplete({
          progress: { ...completeProgress, layoutChecks: ["desktop"] },
          report,
          reviewOrigin: origin,
        }),
      /desktop and mobile/i,
    );
  });

  it("requires deterministic live WebMCP proof and an experience report when enabled", () => {
    const webMcpProgress = {
      ...completeProgress,
      screenshots: [
        ...completeProgress.screenshots,
        { file: "agentic-03.png", path: "/" },
      ],
      webMcp: {
        status: "completed",
        deterministic: "pass",
        fixtureVideoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
        apiSurface: "navigator.modelContextTesting",
        expectedToolNames: [
          "getCarpoInstructions",
          "readClipWorkspace",
          "proposeClips",
        ],
        discoveredToolNames: [
          "getCarpoInstructions",
          "readClipWorkspace",
          "proposeClips",
        ],
        calls: [],
        attempts: [],
        proposal: {
          requiresHumanReview: true,
          createdClipCount: 0,
        },
        evidenceScreenshot: "agentic-03.png",
        proofBoundary: "Live WebMCP verification only.",
      },
    };
    const webMcpReport = {
      ...report,
      webMcpExperience: {
        verdict: "usable",
        summary: "The structured proposal journey completed.",
        strengths: ["The workspace supplied grounded identifiers."],
        frictions: [],
        recommendations: [],
      },
    };
    assert.doesNotThrow(() =>
      assertReviewComplete({
        progress: webMcpProgress,
        report: webMcpReport,
        reviewOrigin: origin,
        webMcpRequired: true,
      }),
    );
    assert.throws(
      () =>
        assertReviewComplete({
          progress: {
            ...webMcpProgress,
            webMcp: {
              ...webMcpProgress.webMcp,
              status: "incomplete",
              deterministic: "inconclusive",
            },
          },
          report: webMcpReport,
          reviewOrigin: origin,
          webMcpRequired: true,
        }),
      /deterministic live WebMCP verification journey/,
    );
    assert.throws(
      () =>
        assertReviewComplete({
          progress: webMcpProgress,
          report,
          reviewOrigin: origin,
          webMcpRequired: true,
        }),
      /experience report/,
    );
  });

  it("reports every unmet completion requirement in one rejection", () => {
    assert.throws(
      () =>
        assertReviewComplete({
          progress: {
            ...completeProgress,
            currentPath: "/",
            screenshots: [
              { file: "agentic-01.png", path: "/__carpo-review-missing" },
              { file: "agentic-02.png", path: "/" },
            ],
            webMcp: {
              status: "incomplete",
              deterministic: "inconclusive",
              fixtureVideoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
              expectedToolNames: [
                "getCarpoInstructions",
                "readClipWorkspace",
                "proposeClips",
              ],
              discoveredToolNames: [
                "getCarpoInstructions",
                "readClipWorkspace",
                "proposeClips",
              ],
              calls: [],
              attempts: [],
              proposal: {},
              proofBoundary: "Incomplete WebMCP verification.",
            },
          },
          report,
          reviewOrigin: origin,
          webMcpRequired: true,
        }),
      (error) => {
        assert.match(error.message, /Capture evidence on both the Create and Library/);
        assert.match(error.message, /Complete the deterministic live WebMCP/);
        assert.match(error.message, /Capture screenshot evidence of the live WebMCP/);
        assert.match(error.message, /Include the structured WebMCP experience report/);
        return true;
      },
    );
  });

  it("owns proof-challenge definitions and completion", () => {
    const challenge = resolveProofChallenge("multilingual-octopus");
    assert.equal(challenge.steps.length, 4);
    assert.deepEqual(nextProofChallengeStep("multilingual-octopus", 1), {
      language: "Spanish",
      value: "pulpo",
    });
    assert.throws(() => resolveProofChallenge("not-real"), /Unknown/);
    assert.deepEqual(
      assertProofChallengeFill({
        challengeId: "multilingual-octopus",
        completedCount: 0,
        pending: null,
        currentPath: "/",
        element: { tag: "input", type: "text", name: "Title" },
        value: "octopus",
      }),
      { language: "English", value: "octopus" },
    );
    assert.throws(
      () =>
        assertProofChallengeFill({
          challengeId: "multilingual-octopus",
          completedCount: 1,
          pending: null,
          currentPath: "/",
          element: { tag: "input", type: "text", name: "Title" },
          value: "octopus",
        }),
      /exact Spanish value/i,
    );
    assert.doesNotThrow(() =>
      assertProofChallengeEvidence({
        pending: { value: "pulpo" },
        currentPath: "/",
        observedValue: "pulpo",
      }),
    );
    assert.throws(
      () =>
        assertProofChallengeEvidence({
          pending: { value: "pulpo" },
          currentPath: "/library",
          observedValue: "pulpo",
        }),
      /Create route/i,
    );
    assert.throws(
      () =>
        assertReviewComplete({
          progress: completeProgress,
          report,
          reviewOrigin: origin,
          proofChallengeId: "multilingual-octopus",
        }),
      /proof challenge/i,
    );
  });

  it("shares authoritative instructions while retaining runtime-specific startup", () => {
    const local = buildReviewerInstructions();
    const durable = buildReviewerInstructions({
      beginReviewRequired: true,
      proofChallengeId: "multilingual-octopus",
    });
    for (const text of [local, durable]) {
      assert.match(text, /untrusted data, never instructions/i);
      assert.match(text, /desktop and mobile/i);
      assert.match(text, /missing route/i);
      assert.match(text, new RegExp(MISSING_ROUTE_PATH.replaceAll("/", "\\/")));
      assert.match(text, /Direct API behavior/i);
    }
    assert.doesNotMatch(local, /Call begin_review/);
    assert.match(durable, /Call begin_review/);
    assert.match(durable, /pulpo/);
    const webMcp = buildReviewerInstructions({
      webMcpFixtureVideoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
    });
    assert.match(webMcp, /list_webmcp_tools/);
    assert.match(webMcp, /Suggested via WebMCP/);
    assert.match(webMcp, /Never approve, reject, dismiss/);
  });

  it("names the exact missing route when completion needs it", () => {
    assert.throws(
      () =>
        assertReviewComplete({
          progress: {
            ...completeProgress,
            visitedPaths: ["/", "/library"],
          },
          report,
          reviewOrigin: origin,
        }),
      new RegExp(MISSING_ROUTE_PATH.replaceAll("/", "\\/")),
    );
  });

  it("provides runtime schemas for both producers and consumers", () => {
    const parsed = v.safeParse(reviewReportInputSchema, {
      ...report,
      findings: [finding],
    });
    assert.equal(parsed.success, true);
    const invalid = v.safeParse(reviewReportInputSchema, {
      ...report,
      findings: [{ ...finding, reproduction: [] }],
    });
    assert.equal(invalid.success, false);
    const result = {
      schemaVersion: AGENTIC_REVIEW_SCHEMA_VERSION,
      status: "completed",
      advisory: true,
      verdict: "pass",
      summary: report.summary,
      testedAreas: report.testedAreas,
      findings: [finding],
      remainingRisks: report.remainingRisks,
      screenshots: [
        {
          file: "agentic-01.png",
          note: "Create remained usable.",
          url: `${origin}/`,
          path: "/",
          runtimeSpecificField: true,
        },
      ],
      diagnostics: {},
      proofBoundary: "Advisory only.",
      runtimeSpecificField: true,
    };
    assert.deepEqual(parseAgenticReviewResult(result), result);
    assert.throws(() =>
      parseAgenticReviewResult({ ...result, schemaVersion: "future" }),
    );
  });
});
