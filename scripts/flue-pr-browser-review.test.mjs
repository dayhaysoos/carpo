import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stripDirectCdpOverride } from "./cloudflare-browser-session.mjs";
import {
  appendHostDiagnosticsFinding,
  BoundedPlaywrightReviewAdapter,
  cloudflareInferenceEnv,
  enforceCoverageBoundary,
  hasUnsupportedCoverageClaim,
  isConsequentialElement,
  isReadOnlyBrowserMethod,
  normalizeEvidenceNote,
  readBoundedReviewMaterial,
  resolveSafeReviewPath,
} from "./flue-pr-browser-review.mjs";

describe("bounded Flue browser review", () => {
  it("removes the legacy direct-CDP override before either wrapper runs", () => {
    assert.deepEqual(
      stripDirectCdpOverride(["--url", "https://example.test", "--ws", "secret", "--output", "out"]),
      ["--url", "https://example.test", "--output", "out"],
    );
  });

  it("allows user-facing same-origin paths and rejects privileged or external routes", () => {
    assert.equal(resolveSafeReviewPath("/library?view=archived"), "/library?view=archived");
    assert.equal(
      resolveSafeReviewPath("/library/videos/8a8dfc12-2917-4331-92db-8ae8a45e7621"),
      "/library/videos/8a8dfc12-2917-4331-92db-8ae8a45e7621",
    );
    assert.equal(
      resolveSafeReviewPath("/?video=8a8dfc12-2917-4331-92db-8ae8a45e7621"),
      "/?video=8a8dfc12-2917-4331-92db-8ae8a45e7621",
    );
    assert.equal(
      resolveSafeReviewPath("/__carpo-review-missing"),
      "/__carpo-review-missing",
    );
    assert.throws(() => resolveSafeReviewPath("https://attacker.example/"), /same-origin path/);
    assert.throws(() => resolveSafeReviewPath("/api/videos"), /outside the bounded/);
    assert.throws(() => resolveSafeReviewPath("/artifacts/clip.mp4"), /outside the bounded/);
    assert.throws(() => resolveSafeReviewPath("/oauth/callback"), /outside the bounded/);
    assert.throws(() => resolveSafeReviewPath("/delete/1"), /route catalog/);
    assert.throws(() => resolveSafeReviewPath("/restore/1"), /route catalog/);
    assert.throws(
      () => resolveSafeReviewPath("/library?view=archived&action=delete"),
      /route catalog/,
    );
    assert.throws(() => resolveSafeReviewPath("/library#secret"), /outside the bounded/);
  });

  it("blocks consequential controls while retaining safe navigation and tabs", () => {
    assert.equal(
      isConsequentialElement({ tag: "button", name: "Create clip" }),
      true,
    );
    assert.equal(
      isConsequentialElement({ tag: "button", name: "Retry GIF" }),
      true,
    );
    assert.equal(
      isConsequentialElement({ tag: "input", type: "file", name: "Video file" }),
      true,
    );
    assert.equal(
      isConsequentialElement({
        tag: "a",
        name: "Archived",
        href: "https://carpo-pr-review.ndejesus1227.workers.dev/library?view=archived",
      }),
      false,
    );
    assert.equal(
      isConsequentialElement({ tag: "button", role: "tab", name: "Upload file" }),
      false,
    );
    assert.equal(
      isConsequentialElement({
        tag: "a",
        name: "Delete video",
        href: "https://carpo-pr-review.ndejesus1227.workers.dev/delete/1",
      }),
      true,
    );
  });

  it("binds Cloudflare-native Flue inference without exposing the model to ambient keys", () => {
    const runtimeEnv = cloudflareInferenceEnv({
      model: "cloudflare-workers-ai/@cf/openai/gpt-oss-120b",
      env: {},
      auth: { type: "oauth", token: "oauth-token" },
      whoami: { accounts: [{ id: "a".repeat(32) }] },
    });
    assert.deepEqual(runtimeEnv, {
      CLOUDFLARE_API_KEY: "oauth-token",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    });
    assert.throws(
      () =>
        cloudflareInferenceEnv({
          model: "cloudflare-workers-ai/@cf/openai/gpt-oss-120b",
          env: {},
          auth: { token: "oauth-token" },
          whoami: { accounts: [] },
        }),
      /requires one authenticated account/,
    );
  });

  it("rejects model claims that exceed the bounded browser authority", () => {
    assert.equal(
      hasUnsupportedCoverageClaim({
        summary: "Completed read-only API smoke checks.",
        testedAreas: ["Create", "Library"],
        findings: [],
      }),
      true,
    );
    assert.equal(
      hasUnsupportedCoverageClaim({
        summary: "Clip creation passed.",
        testedAreas: ["Create"],
        findings: [],
      }),
      true,
    );
    assert.equal(
      hasUnsupportedCoverageClaim({
        summary: "The Create and Library shells rendered without a visible issue.",
        testedAreas: ["Upload form", "Library"],
        findings: [],
      }),
      false,
    );
  });

  it("omits unsupported model claims and downgrades the advisory result", () => {
    const report = enforceCoverageBoundary({
      verdict: "pass",
      summary: "Create rendered and read-only API smoke checks passed.",
      testedAreas: ["Create", "API"],
      findings: [
        {
          severity: "info",
          title: "API works",
          evidence: "The API test passed.",
        },
      ],
      remainingRisks: ["Upload execution remains unverified."],
    });
    assert.equal(report.verdict, "inconclusive");
    assert.deepEqual(report.testedAreas, ["Create"]);
    assert.equal(report.findings.length, 1);
    assert.match(report.findings[0].title, /exceeded browser authority/);
    assert.match(report.summary, /host omitted that claim/);
    assert.match(report.remainingRisks.at(-1), /Direct API behavior/);
  });

  it("normalizes unsupported screenshot notes before they enter evidence", () => {
    assert.equal(
      normalizeEvidenceNote("Clip creation verified"),
      "The host omitted an unsupported coverage claim from this screenshot note.",
    );
    assert.equal(
      normalizeEvidenceNote("Archived view rendered with no visible issue"),
      "Archived view rendered with no visible issue",
    );
  });

  it("rechecks the route catalog after a fill-triggered navigation", async () => {
    let currentUrl = "https://carpo-pr-review.ndejesus1227.workers.dev/";
    const page = {
      url: () => currentUrl,
      locator: () => ({
        async fill() {
          currentUrl =
            "https://carpo-pr-review.ndejesus1227.workers.dev/delete/1";
        },
      }),
    };
    const adapter = new BoundedPlaywrightReviewAdapter({
      page,
      contextText: "",
      diffText: "",
      outputDir: "unused",
      diagnostics: {},
    });
    adapter.elements.set("e1", {
      id: "e1",
      tag: "input",
      type: "text",
      name: "Title",
    });

    await assert.rejects(() => adapter.fill("e1", "New title"), /route catalog/);
  });

  it("only exposes host-defined viewport presets", async () => {
    const sizes = [];
    const adapter = new BoundedPlaywrightReviewAdapter({
      page: {
        async setViewportSize(size) {
          sizes.push(size);
        },
      },
      contextText: "",
      diffText: "",
      outputDir: "unused",
      diagnostics: {},
    });

    assert.deepEqual(await adapter.setViewport("desktop"), {
      preset: "desktop",
      width: 1440,
      height: 1000,
    });
    assert.deepEqual(await adapter.setViewport("mobile"), {
      preset: "mobile",
      width: 390,
      height: 844,
    });
    await assert.rejects(() => adapter.setViewport("custom"), /Unknown review viewport/);
    assert.deepEqual(sizes, [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]);
  });

  it("host-enforces the ordered multilingual Title proof and its screenshots", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-proof-challenge-"));
    let currentValue = "";
    const page = {
      url: () => "https://carpo-pr-review.ndejesus1227.workers.dev/",
      locator: () => ({
        async fill(value) {
          currentValue = value;
        },
        async inputValue() {
          return currentValue;
        },
      }),
      async evaluate() {},
      async screenshot({ path: screenshotPath }) {
        await writeFile(screenshotPath, `visible-title:${currentValue}`);
      },
    };
    const adapter = new BoundedPlaywrightReviewAdapter({
      page,
      contextText: "context",
      diffText: "diff",
      outputDir,
      diagnostics: {},
      proofChallenge: "multilingual-octopus",
    });
    adapter.elements.set("e1", {
      id: "e1",
      tag: "input",
      type: "text",
      name: "Title",
    });
    adapter.elements.set("e2", {
      id: "e2",
      tag: "input",
      type: "text",
      name: "Caption (optional)",
    });

    try {
      await assert.rejects(
        () => adapter.fill("e2", "octopus"),
        /Create Title field/,
      );
      await assert.rejects(
        () => adapter.fill("e1", "pulpo"),
        /exact English value/,
      );
      await assert.rejects(
        () =>
          adapter.finishReview({
            verdict: "pass",
            findings: [],
            remainingRisks: ["Bounded review only."],
          }),
        /all 4 host proof challenge steps/,
      );

      const values = ["octopus", "pulpo", "pieuvre", "タコ"];
      for (const value of values) {
        await adapter.fill("e1", value);
        await adapter.captureEvidence("model supplied note is replaced");
      }

      const result = adapter.proofChallengeResult();
      assert.equal(result.status, "completed");
      assert.deepEqual(
        result.completedSteps.map(({ language, value }) => ({ language, value })),
        [
          { language: "English", value: "octopus" },
          { language: "Spanish", value: "pulpo" },
          { language: "French", value: "pieuvre" },
          { language: "Japanese", value: "タコ" },
        ],
      );
      assert.equal(adapter.screenshots.length, 4);
      assert.match(adapter.screenshots[1].note, /Spanish Title is "pulpo"/);
      assert.equal(adapter.screenshots[3].proofChallenge.step, 4);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("always surfaces host diagnostics and strengthens the advisory verdict", () => {
    const report = appendHostDiagnosticsFinding(
      {
        verdict: "inconclusive",
        summary: "Bounded review was inconclusive.",
        testedAreas: ["Create"],
        findings: [],
        remainingRisks: ["Upload execution was not attempted."],
      },
      {
        consoleErrors: [{ text: "boom" }],
        pageErrors: [],
        failedRequests: [],
        serverErrors: [],
        blockedMutations: [],
      },
    );
    assert.equal(report.verdict, "needs_attention");
    assert.match(report.findings.at(-1).title, /diagnostics were not clean/);
  });

  it("allows only read-only browser requests during exploratory review", () => {
    assert.equal(isReadOnlyBrowserMethod("GET"), true);
    assert.equal(isReadOnlyBrowserMethod("head"), true);
    assert.equal(isReadOnlyBrowserMethod("OPTIONS"), true);
    assert.equal(isReadOnlyBrowserMethod("POST"), false);
    assert.equal(isReadOnlyBrowserMethod("DELETE"), false);
  });

  it("only accepts material reads that consume the frozen context or diff", () => {
    assert.deepEqual(
      readBoundedReviewMaterial({
        source: "context",
        material: "frozen review context",
        offset: 0,
      }),
      {
        source: "context",
        offset: 0,
        totalChars: 21,
        nextOffset: undefined,
        sha256: "67522291f0040f5069ef0350767def2edc8fb5ce2a8bba4d94beb0ec7a0d1601",
        text: "frozen review context",
      },
    );
    assert.throws(
      () =>
        readBoundedReviewMaterial({
          source: "diff",
          material: "exact diff",
          offset: 10,
        }),
      /outside the frozen diff/,
    );
    assert.deepEqual(
      readBoundedReviewMaterial({ source: "diff", material: "", offset: 0 }),
      {
        source: "diff",
        offset: 0,
        totalChars: 0,
        nextOffset: undefined,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        text: "",
      },
    );
  });
});
