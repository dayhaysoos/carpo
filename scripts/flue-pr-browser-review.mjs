import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import {
  resolveAgenticModel,
  runFlueAgenticReview,
} from "./flue-pr-review-agent.mjs";
import {
  browserDiagnosticCount,
  createBrowserDiagnostics,
  observeBrowserDiagnostics,
  readCandidateIdentity,
  REVIEW_COOKIE,
  REVIEW_ORIGIN,
  traceContainsSecret,
} from "./pr-browser-review-runtime.mjs";
import { redactSecrets } from "./pr-browser-review-utils.mjs";
import { resolveProofChallenge } from "./pr-review-proof-challenges.mjs";

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOTS = 12;
const MAX_MATERIAL_CHUNK = 12_000;
const BLOCKED_PATH_PREFIXES = [
  "/api",
  "/artifacts",
  "/agents",
  "/auth",
  "/login",
  "/logout",
  "/oauth",
  "/sign-in",
  "/signin",
  "/cdn-cgi",
];
const VIDEO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL_ACTION =
  /\b(?:create\s+clip|archive|restore|delete|remove|publish|share|approve|reject|submit|confirm|save\s+changes?)\b/i;
const COVERAGE_VERB =
  "(?:tested|verified|validated|exercised|confirmed|completed|passed|succeeded|works?|working)";
const UNAVAILABLE_COVERAGE =
  "(?:(?:direct|read-only)\\s+)?api(?:\\s+(?:smoke|checks?|tests?))?|(?:actual\\s+)?upload(?:ing|\\s+flow)?|clip\\s+creat(?:e|ion)|encod(?:e|ing)|media\\s+playback|youtube(?:\\s+reliability)?|production(?:\\s+behavior)?";
const UNSUPPORTED_COVERAGE_CLAIM = new RegExp(
  `(?:\\b${COVERAGE_VERB}\\b[^.!?\\n]{0,100}\\b${UNAVAILABLE_COVERAGE}\\b|\\b${UNAVAILABLE_COVERAGE}\\b[^.!?\\n]{0,100}\\b${COVERAGE_VERB}\\b)`,
  "i",
);
const UNSUPPORTED_TESTED_AREA =
  /\b(?:api|clip\s+creat(?:e|ion)|encoding|media\s+playback|youtube|production)\b/i;

export function isReadOnlyBrowserMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

export function readBoundedReviewMaterial({ source, material, offset }) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Review material offset must be a non-negative integer");
  }
  if (offset > material.length || (material.length > 0 && offset === material.length)) {
    throw new Error(`Review material offset is outside the frozen ${source}`);
  }
  const text = material.slice(offset, offset + MAX_MATERIAL_CHUNK);
  return {
    source,
    offset,
    totalChars: material.length,
    nextOffset:
      offset + text.length < material.length ? offset + text.length : undefined,
    sha256: sha256(material),
    text,
  };
}

export function cloudflareInferenceEnv({ model, env, auth, whoami }) {
  if (!model.startsWith("cloudflare-workers-ai/")) return env;
  const token = env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN || auth?.token;
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];
  const accountId =
    env.CLOUDFLARE_ACCOUNT_ID ||
    (accounts.length === 1 ? accounts[0]?.id : undefined);
  if (!token || !/^[a-f0-9]{32}$/i.test(accountId ?? "")) {
    throw new Error(
      "Cloudflare-native Flue inference requires one authenticated account and a Workers AI-capable token",
    );
  }
  return {
    ...env,
    CLOUDFLARE_API_KEY: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
}

async function resolveInferenceEnv(model, env = process.env) {
  if (!model.startsWith("cloudflare-workers-ai/")) return env;
  if (
    (env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN) &&
    env.CLOUDFLARE_ACCOUNT_ID
  ) {
    return cloudflareInferenceEnv({ model, env });
  }
  const [{ stdout: authOutput }, { stdout: whoamiOutput }] = await Promise.all([
    execFileAsync("npx", ["wrangler", "auth", "token", "--json"], {
      maxBuffer: 256 * 1024,
    }),
    execFileAsync("npx", ["wrangler", "whoami", "--json"], {
      maxBuffer: 512 * 1024,
    }),
  ]);
  return cloudflareInferenceEnv({
    model,
    env,
    auth: JSON.parse(authOutput),
    whoami: JSON.parse(whoamiOutput),
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trimText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function resolveSafeReviewPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error("Review navigation requires an absolute same-origin path");
  }
  const url = new URL(value, REVIEW_ORIGIN);
  if (
    url.origin !== REVIEW_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    BLOCKED_PATH_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    throw new Error("The requested route is outside the bounded user-facing review surface");
  }

  const entries = [...url.searchParams.entries()];
  const rootVideoId =
    url.pathname === "/" && entries.length === 1 && entries[0][0] === "video"
      ? entries[0][1]
      : undefined;
  const libraryView =
    url.pathname === "/library" &&
    entries.length === 1 &&
    entries[0][0] === "view"
      ? entries[0][1]
      : undefined;
  const videoPageMatch = url.pathname.match(/^\/library\/videos\/([^/]+)$/);
  const allowed =
    (url.pathname === "/" &&
      (entries.length === 0 || VIDEO_ID_PATTERN.test(rootVideoId ?? ""))) ||
    (url.pathname === "/library" &&
      (entries.length === 0 || libraryView === "archived")) ||
    (videoPageMatch &&
      entries.length === 0 &&
      VIDEO_ID_PATTERN.test(videoPageMatch[1]));
  if (!allowed) {
    throw new Error("The requested route is not in the read-only review route catalog");
  }
  return `${url.pathname}${url.search}`;
}

export function isConsequentialElement(element) {
  const type = String(element?.type ?? "").toLowerCase();
  const tag = String(element?.tag ?? "").toLowerCase();
  const role = String(element?.role ?? "").toLowerCase();
  if (["file", "password", "hidden", "submit", "reset"].includes(type)) {
    return true;
  }
  if ((tag === "button" || role === "button") && role !== "tab") {
    return true;
  }
  return CONSEQUENTIAL_ACTION.test(
    [element?.name, element?.text, element?.ariaLabel].filter(Boolean).join(" "),
  );
}

export function hasUnsupportedCoverageClaim(report) {
  if (UNSUPPORTED_COVERAGE_CLAIM.test(String(report?.summary ?? ""))) {
    return true;
  }
  if (
    (report?.testedAreas ?? []).some((area) =>
      UNSUPPORTED_TESTED_AREA.test(String(area)),
    )
  ) {
    return true;
  }
  return (report?.findings ?? []).some((finding) =>
    UNSUPPORTED_COVERAGE_CLAIM.test(
      `${String(finding?.title ?? "")} ${String(finding?.evidence ?? "")}`,
    ),
  );
}

export function enforceCoverageBoundary(report) {
  if (!hasUnsupportedCoverageClaim(report)) return report;

  return {
    ...report,
    verdict: "inconclusive",
    summary:
      "The bounded browser exploration completed, but the model submitted a coverage claim outside the available evidence. The host omitted that claim.",
    testedAreas: (report.testedAreas ?? []).filter(
      (area) => !UNSUPPORTED_TESTED_AREA.test(String(area)),
    ),
    findings: [
      ...(report.findings ?? [])
        .filter(
          (finding) =>
            !UNSUPPORTED_COVERAGE_CLAIM.test(
              `${String(finding?.title ?? "")} ${String(finding?.evidence ?? "")}`,
            ),
        )
        .slice(0, 19),
      {
        severity: "warning",
        title: "Model coverage claim exceeded browser authority",
        evidence:
          "The host removed the unsupported claim and marked this advisory result inconclusive. Deterministic checks remain authoritative.",
      },
    ],
    remainingRisks: [
      ...(report.remainingRisks ?? [])
        .filter((risk) => !UNSUPPORTED_COVERAGE_CLAIM.test(String(risk)))
        .slice(0, 19),
      "Direct API behavior, upload execution, clip creation, encoding, media playback, YouTube reliability, and production behavior remain unverified.",
    ],
  };
}

export function normalizeEvidenceNote(note) {
  const bounded = trimText(note, 240);
  if (
    hasUnsupportedCoverageClaim({
      summary: bounded,
      testedAreas: [],
      findings: [],
    })
  ) {
    return "The host omitted an unsupported coverage claim from this screenshot note.";
  }
  return bounded;
}

export class BoundedPlaywrightReviewAdapter {
  constructor({
    page,
    contextText,
    diffText,
    outputDir,
    diagnostics,
    proofChallenge,
  }) {
    this.page = page;
    this.materials = { context: contextText, diff: diffText };
    this.outputDir = outputDir;
    this.diagnostics = diagnostics;
    this.elements = new Map();
    this.screenshots = [];
    this.screenshotHashes = new Set();
    this.visitedPaths = new Set();
    this.readSources = new Set();
    this.diagnosticsRead = false;
    this.proofChallenge = resolveProofChallenge(
      proofChallenge?.id ?? proofChallenge,
    );
    this.proofChallengeSteps = [];
    this.pendingProofChallengeStep = undefined;
  }

  recordCurrentPath() {
    const url = new URL(this.page.url());
    if (url.origin !== REVIEW_ORIGIN) {
      throw new Error("The browser left the bounded Carpo review origin");
    }
    resolveSafeReviewPath(`${url.pathname}${url.search}`);
    this.visitedPaths.add(url.pathname);
  }

  async readReviewMaterial({ source, offset }) {
    const material = this.materials[source];
    const chunk = readBoundedReviewMaterial({ source, material, offset });
    this.readSources.add(source);
    return chunk;
  }

  async inspectPage() {
    this.recordCurrentPath();
    const state = await this.page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const candidates = Array.from(
        document.querySelectorAll(
          'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"]',
        ),
      )
        .filter(visible)
        .slice(0, 100);
      const elements = candidates.map((element, index) => {
        const id = `e${index + 1}`;
        element.setAttribute("data-carpo-agentic-id", id);
        const labels = element.labels ? Array.from(element.labels) : [];
        const name =
          element.getAttribute("aria-label") ||
          labels.map((label) => label.textContent || "").join(" ") ||
          element.getAttribute("name") ||
          element.getAttribute("placeholder") ||
          element.textContent ||
          "";
        return {
          id,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || undefined,
          type: element.getAttribute("type") || undefined,
          name: name.replace(/\s+/g, " ").trim().slice(0, 240),
          text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
          ariaLabel: element.getAttribute("aria-label") || undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          disabled:
            "disabled" in element && typeof element.disabled === "boolean"
              ? element.disabled
              : undefined,
        };
      });
      return {
        url: window.location.href,
        title: document.title,
        heading: document.querySelector("h1, h2")?.textContent?.trim(),
        visibleText: (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8_000),
        elements,
      };
    });
    this.elements = new Map(state.elements.map((element) => [element.id, element]));
    return state;
  }

  async navigate(requestedPath) {
    const safePath = resolveSafeReviewPath(requestedPath);
    await this.page.goto(new URL(safePath, REVIEW_ORIGIN).href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    this.recordCurrentPath();
    this.elements.clear();
    return { url: this.page.url(), path: safePath };
  }

  requireElement(elementId) {
    if (!/^e[1-9][0-9]{0,2}$/.test(elementId)) {
      throw new Error("The browser element id has an invalid format");
    }
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error("The browser element id is stale; inspect the page again");
    }
    if (element.disabled) throw new Error("The requested browser element is disabled");
    return element;
  }

  async click(elementId) {
    const element = this.requireElement(elementId);
    if (isConsequentialElement(element)) {
      throw new Error("The requested click is outside the advisory review authority");
    }
    if (!element.href && element.role !== "link" && element.role !== "tab") {
      throw new Error("Only same-origin navigation links and tabs are clickable");
    }
    if (element.href) {
      const href = new URL(element.href);
      if (href.origin !== REVIEW_ORIGIN) {
        throw new Error("External links are outside the bounded review origin");
      }
      resolveSafeReviewPath(`${href.pathname}${href.search}`);
    }
    await this.page.locator(`[data-carpo-agentic-id="${elementId}"]`).click({
      timeout: 15_000,
    });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    this.recordCurrentPath();
    this.elements.clear();
    return { clicked: elementId, url: this.page.url() };
  }

  async fill(elementId, value) {
    const element = this.requireElement(elementId);
    if (isConsequentialElement(element) || !["input", "textarea"].includes(element.tag)) {
      throw new Error("The requested field is outside the advisory review authority");
    }
    if (value.length > 1_000) throw new Error("The review field value is too long");
    const nextProofStep = this.proofChallenge?.steps[this.proofChallengeSteps.length];
    if (nextProofStep) {
      const currentUrl = new URL(this.page.url());
      const isTitleField =
        currentUrl.pathname === "/" &&
        element.tag === "input" &&
        element.type === "text" &&
        element.name.trim().toLowerCase() === "title";
      if (!isTitleField || value !== nextProofStep.value) {
        throw new Error(
          `Complete proof challenge step ${this.proofChallengeSteps.length + 1} by filling the Create Title field with the exact ${nextProofStep.language} value`,
        );
      }
      if (this.pendingProofChallengeStep) {
        throw new Error("Capture evidence for the current proof challenge value before filling again");
      }
    }
    await this.page.locator(`[data-carpo-agentic-id="${elementId}"]`).fill(value, {
      timeout: 15_000,
    });
    this.recordCurrentPath();
    if (nextProofStep) {
      this.pendingProofChallengeStep = {
        ...nextProofStep,
        elementId,
      };
    }
    return {
      filled: elementId,
      retained: true,
      ...(nextProofStep
        ? {
            proofChallenge: {
              id: this.proofChallenge.id,
              step: this.proofChallengeSteps.length + 1,
              language: nextProofStep.language,
            },
          }
        : {}),
    };
  }

  async captureEvidence(note) {
    if (this.screenshots.length >= MAX_SCREENSHOTS) {
      throw new Error(`The review already captured its ${MAX_SCREENSHOTS}-screenshot budget`);
    }
    this.recordCurrentPath();
    const pendingProof = this.pendingProofChallengeStep;
    if (pendingProof) {
      const currentPath = new URL(this.page.url()).pathname;
      if (currentPath !== "/") {
        throw new Error("Proof challenge evidence must be captured on the Create route");
      }
      const visibleValue = await this.page
        .locator(`[data-carpo-agentic-id="${pendingProof.elementId}"]`)
        .inputValue();
      if (visibleValue !== pendingProof.value) {
        throw new Error("The proof challenge value changed before evidence capture");
      }
    }
    const file = `agentic-${String(this.screenshots.length + 1).padStart(2, "0")}.png`;
    const filePath = path.join(this.outputDir, file);
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path: filePath });
    const digest = sha256(await readFile(filePath));
    if (this.screenshotHashes.has(digest)) {
      await unlink(filePath);
      throw new Error(
        "This viewport duplicates existing evidence; navigate or change the visible state before capturing again",
      );
    }
    this.screenshotHashes.add(digest);
    const evidence = {
      file,
      note: pendingProof
        ? `Proof challenge: ${pendingProof.language} Title is ${JSON.stringify(pendingProof.value)} without submitting.`
        : normalizeEvidenceNote(note),
      url: this.page.url(),
      path: new URL(this.page.url()).pathname,
      sha256: digest,
      ...(pendingProof
        ? {
            proofChallenge: {
              id: this.proofChallenge.id,
              step: this.proofChallengeSteps.length + 1,
              language: pendingProof.language,
              value: pendingProof.value,
            },
          }
        : {}),
    };
    this.screenshots.push(evidence);
    if (pendingProof) {
      this.proofChallengeSteps.push(evidence.proofChallenge);
      this.pendingProofChallengeStep = undefined;
    }
    return evidence;
  }

  proofChallengeResult() {
    if (!this.proofChallenge) return undefined;
    return {
      id: this.proofChallenge.id,
      status:
        this.proofChallengeSteps.length === this.proofChallenge.steps.length &&
        !this.pendingProofChallengeStep
          ? "completed"
          : "incomplete",
      completedSteps: [...this.proofChallengeSteps],
    };
  }

  async readDiagnostics() {
    this.diagnosticsRead = true;
    return this.diagnostics;
  }

  async finishReview(report) {
    if (this.proofChallenge) {
      const challengeResult = this.proofChallengeResult();
      if (challengeResult.status !== "completed") {
        throw new Error(
          `Complete all ${this.proofChallenge.steps.length} host proof challenge steps before finishing`,
        );
      }
    }
    if (!this.readSources.has("context") || !this.readSources.has("diff")) {
      throw new Error("Read both frozen context and exact diff before finishing");
    }
    if (!this.visitedPaths.has("/") || !this.visitedPaths.has("/library")) {
      throw new Error("Inspect both the Create and Library entry points before finishing");
    }
    if (!this.diagnosticsRead) {
      throw new Error("Read browser diagnostics before finishing");
    }
    const evidenceFiles = new Set(this.screenshots.map(({ file }) => file));
    const evidencePaths = new Set(this.screenshots.map(({ path: filePath }) => filePath));
    if (!evidencePaths.has("/") || !evidencePaths.has("/library")) {
      throw new Error("Capture evidence on both the Create and Library entry points");
    }
    const boundedReport = enforceCoverageBoundary(report);
    for (const finding of boundedReport.findings) {
      if (finding.screenshot && !evidenceFiles.has(finding.screenshot)) {
        throw new Error(`Finding references unknown screenshot ${finding.screenshot}`);
      }
    }
    return boundedReport;
  }
}

export function appendHostDiagnosticsFinding(report, diagnostics) {
  const count = browserDiagnosticCount(diagnostics);
  if (count === 0) return report;
  return {
    ...report,
    verdict: "needs_attention",
    findings: [
      ...report.findings.slice(0, 19),
      {
        severity: "error",
        title: "Browser diagnostics were not clean",
        evidence: `The host recorded ${count} console, page, request, or server diagnostic entries during exploratory review.`,
      },
    ],
  };
}

async function runAgenticBrowserReview(args) {
  const cdpEndpoint = process.env.CARPO_BROWSER_CDP_URL ?? args.ws;
  const authToken = process.env.CARPO_PR_REVIEW_AUTH_TOKEN;
  const expectedVersionTag = args["expected-version-tag"];
  const executionId = args["execution-id"];
  const outputDir = path.resolve(args.output ?? "test-output/pr-review");
  const proofChallenge = resolveProofChallenge(args["proof-challenge"]);
  if (
    args.url !== REVIEW_ORIGIN &&
    args.url !== `${REVIEW_ORIGIN}/`
  ) {
    throw new Error(`The Flue review target must be exactly ${REVIEW_ORIGIN}`);
  }
  if (!cdpEndpoint || !authToken || !expectedVersionTag || !executionId) {
    throw new Error(
      "Usage: flue-pr-browser-review.mjs --url <review-url> --expected-version-tag <tag> --execution-id <id> with Browser Run and review-auth credentials",
    );
  }
  await mkdir(outputDir, { recursive: true });
  const [contextText, diffText] = await Promise.all([
    readFile(args.context, "utf8"),
    readFile(args.diff, "utf8"),
  ]);
  const diagnostics = createBrowserDiagnostics();
  const startedAt = new Date().toISOString();
  const model = resolveAgenticModel();
  const inferenceEnv = await resolveInferenceEnv(model);
  const providers = model.startsWith("cloudflare-workers-ai/")
    ? [cloudflareWorkersAIProvider()]
    : undefined;
  let browser;
  let browserContext;
  let page;
  let adapter;
  let candidate;
  let trace;
  let agentResult;
  let failure;
  let failureScreenshot;

  try {
    const cdpUrl = new URL(cdpEndpoint);
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const connectionOptions =
      cdpUrl.hostname === "api.cloudflare.com" && apiToken
        ? { headers: { Authorization: `Bearer ${apiToken}` } }
        : undefined;
    browser = await chromium.connectOverCDP(cdpEndpoint, connectionOptions);
    browserContext = browser.contexts()[0] ?? (await browser.newContext());
    await browserContext.route("**/*", async (route) => {
      const request = route.request();
      if (isReadOnlyBrowserMethod(request.method())) {
        await route.continue();
        return;
      }
      const requestUrl = new URL(request.url());
      diagnostics.blockedMutations.push({
        method: request.method(),
        url: `${requestUrl.origin}${requestUrl.pathname}`,
      });
      await route.abort("blockedbyclient");
    });
    await browserContext.addCookies([
      {
        name: REVIEW_COOKIE,
        value: authToken,
        url: REVIEW_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
    page = browserContext.pages()[0] ?? (await browserContext.newPage());
    await page.setViewportSize({ width: 1440, height: 1000 });
    observeBrowserDiagnostics(page, REVIEW_ORIGIN, diagnostics);
    await browserContext.tracing.start({ screenshots: true, snapshots: false });
    candidate = await readCandidateIdentity(page, {
      reviewOrigin: REVIEW_ORIGIN,
      expectedVersionTag,
    });
    await page.goto(`${REVIEW_ORIGIN}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    adapter = new BoundedPlaywrightReviewAdapter({
      page,
      contextText,
      diffText,
      outputDir,
      diagnostics,
      proofChallenge,
    });
    adapter.recordCurrentPath();
    agentResult = await runFlueAgenticReview({
      executionId,
      expectedVersionTag,
      adapter,
      model,
      providers,
      runtimeEnv: inferenceEnv,
      proofChallenge,
    });
    await readCandidateIdentity(page, {
      reviewOrigin: REVIEW_ORIGIN,
      expectedVersionTag,
      expectedVersionId: candidate.id,
    });
    agentResult.report = appendHostDiagnosticsFinding(
      agentResult.report,
      diagnostics,
    );
  } catch (error) {
    agentResult = error?.agenticProgress;
    failure = redactSecrets(error instanceof Error ? error.message : error);
    if (page) {
      const file = "agentic-failure.png";
      try {
        await page.screenshot({ path: path.join(outputDir, file) });
        const failureUrl = new URL(page.url());
        failureScreenshot = {
          file,
          note: "Host capture when the Flue review became inconclusive",
          url: page.url(),
          path:
            failureUrl.origin === REVIEW_ORIGIN ? failureUrl.pathname : "unknown path",
        };
      } catch {}
    }
  } finally {
    if (browserContext) {
      const tracePath = path.join(outputDir, "agentic-trace.zip");
      try {
        await browserContext.tracing.stop({ path: tracePath });
        if (await traceContainsSecret(tracePath, authToken)) {
          throw new Error("The agentic trace retained the review credential");
        }
        trace = "agentic-trace.zip";
      } catch (error) {
        await unlink(tracePath).catch(() => {});
        failure ??= redactSecrets(error instanceof Error ? error.message : error);
      }
    }
    await browser?.close().catch(() => {});
  }

  const report = agentResult?.report;
  const result = {
    schemaVersion: "carpo.pr-browser-review.agentic.v1",
    status: failure ? "failed" : "completed",
    advisory: true,
    verdict: failure ? "inconclusive" : report.verdict,
    startedAt,
    completedAt: new Date().toISOString(),
    model,
    targetOrigin: REVIEW_ORIGIN,
    expectedVersionTag,
    candidate,
    contextSha256: sha256(contextText),
    diffSha256: sha256(diffText),
    summary: failure ? "The Flue exploratory review did not complete." : report.summary,
    testedAreas: report?.testedAreas ?? [],
    findings: report?.findings ?? [],
    remainingRisks: report?.remainingRisks ?? [],
    screenshots: [
      ...(adapter?.screenshots ?? []),
      ...(failureScreenshot ? [failureScreenshot] : []),
    ],
    proofChallenge:
      adapter?.proofChallengeResult() ??
      (proofChallenge
        ? { id: proofChallenge.id, status: "not_started", completedSteps: [] }
        : undefined),
    diagnostics,
    toolCalls: agentResult?.toolCalls ?? 0,
    timeline: agentResult?.timeline ?? [],
    trace,
    failure,
    proofBoundary:
      "This is advisory Flue exploration of one exact tagged Worker through bounded same-origin tools. It cannot approve the candidate and does not prove upload, encoding, media playback, YouTube reliability, production behavior, or correctness outside the inspected paths.",
  };
  await writeFile(
    path.join(outputDir, "agentic-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `\nFlue exploratory review: ${result.status.toUpperCase()} · ${result.verdict}\n${result.summary}\n`,
  );
  if (failure) process.exitCode = 1;
  return result;
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  runAgenticBrowserReview(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.stack ?? error.message : error));
    process.exitCode = 1;
  });
}
