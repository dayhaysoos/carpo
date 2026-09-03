import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ADVISORY_REVIEW_PROOF_BOUNDARY,
  AGENTIC_REVIEW_SCHEMA_VERSION,
  appendDiagnosticsFinding,
  assertProofChallengeEvidence,
  assertProofChallengeFill,
  assertReviewComplete,
  assertReviewElementId,
  assertSafeReviewClick,
  assertSafeReviewFill,
  enforceCoverageBoundary,
  hasUnsupportedCoverageClaim,
  isConsequentialElement,
  isReadOnlyBrowserMethod,
  MAX_REVIEW_SCREENSHOTS,
  normalizeEvidenceNote,
  readBoundedReviewMaterial as readContractReviewMaterial,
  resolveSafeReviewPath as resolveContractReviewPath,
  VIEWPORT_PRESETS,
} from "@carpo/review-contract";
import { chromium } from "playwright-core";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import {
  resolveAgenticModel,
  runFlueAgenticReview,
} from "./flue-pr-review-agent.mjs";
import {
  createBrowserDiagnostics,
  observeBrowserDiagnostics,
  readCandidateIdentity,
  REVIEW_COOKIE,
  REVIEW_ORIGIN,
  traceContainsSecret,
} from "./pr-browser-review-runtime.mjs";
import { redactSecrets } from "./pr-browser-review-utils.mjs";
import { resolveProofChallenge } from "./pr-review-proof-challenges.mjs";
import { createLiveWebMcpVerificationJourney } from "./live-webmcp-verification-journey.mjs";

const execFileAsync = promisify(execFile);

export {
  enforceCoverageBoundary,
  hasUnsupportedCoverageClaim,
  isConsequentialElement,
  isReadOnlyBrowserMethod,
  normalizeEvidenceNote,
};

export function readBoundedReviewMaterial({ source, material, offset }) {
  return readContractReviewMaterial({
    source,
    material,
    offset,
    digest: sha256(material),
  });
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

export function resolveSafeReviewPath(value) {
  return resolveContractReviewPath(value, REVIEW_ORIGIN);
}

export class BoundedPlaywrightReviewAdapter {
  constructor({
    page,
    contextText,
    diffText,
    outputDir,
    diagnostics,
    proofChallenge,
    webMcpFixtureVideoId,
  }) {
    this.page = page;
    this.materials = { context: contextText, diff: diffText };
    this.outputDir = outputDir;
    this.diagnostics = diagnostics;
    this.elements = new Map();
    this.screenshots = [];
    this.screenshotHashes = new Set();
    this.visitedPaths = new Set();
    this.navigationStatuses = new Map();
    this.layoutChecks = new Set();
    this.readSources = new Set();
    this.diagnosticsRead = false;
    this.proofChallenge = resolveProofChallenge(
      proofChallenge?.id ?? proofChallenge,
    );
    this.proofChallengeSteps = [];
    this.pendingProofChallengeStep = undefined;
    this.webMcpJourney = webMcpFixtureVideoId
      ? createLiveWebMcpVerificationJourney({
          fixtureVideoId: webMcpFixtureVideoId,
          browser: {
            discoverTools: (input) => this.discoverLiveWebMcpTools(input),
            invokeTool: (input) => this.invokeLiveWebMcpTool(input),
            observeProposalReview: (input) =>
              this.observeLiveWebMcpProposalReview(input),
            captureProof: (input) => this.captureLiveWebMcpProof(input),
          },
        })
      : undefined;
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
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        layout: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          hasHorizontalOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          overflowingElements: Array.from(document.querySelectorAll("body *"))
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.right > document.documentElement.clientWidth + 1 || rect.left < -1;
            })
            .slice(0, 12)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              id: element.id || undefined,
              className:
                typeof element.className === "string"
                  ? element.className.replace(/\s+/g, " ").trim().slice(0, 160)
                  : undefined,
              text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
            })),
        },
        visibleText: (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8_000),
        elements,
      };
    });
    this.elements = new Map(state.elements.map((element) => [element.id, element]));
    for (const [preset, dimensions] of Object.entries(VIEWPORT_PRESETS)) {
      if (
        state.viewport.width === dimensions.width &&
        state.viewport.height === dimensions.height
      ) {
        this.layoutChecks.add(preset);
      }
    }
    return state;
  }

  async navigate(requestedPath) {
    const safePath = resolveSafeReviewPath(requestedPath);
    const response = await this.page.goto(new URL(safePath, REVIEW_ORIGIN).href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    this.recordCurrentPath();
    const status = typeof response?.status === "function" ? response.status() : undefined;
    this.navigationStatuses.set(new URL(this.page.url()).pathname, status);
    this.elements.clear();
    return { url: this.page.url(), path: safePath, status };
  }

  async setViewport(preset) {
    const viewport = VIEWPORT_PRESETS[preset];
    if (!viewport) throw new Error("Unknown review viewport preset");
    await this.page.setViewportSize(viewport);
    this.elements.clear();
    return { preset, ...viewport };
  }

  async discoverLiveWebMcpTools({
    fixtureVideoId,
    expectedToolNames,
    knownToolNames,
  }) {
    const currentUrl = new URL(this.page.url());
    if (
      currentUrl.pathname !== "/create" ||
      currentUrl.searchParams.get("video") !== fixtureVideoId
    ) {
      await this.navigate(`/create?video=${encodeURIComponent(fixtureVideoId)}`);
    }
    this.recordCurrentPath();
    const discovery = await this.page.evaluate(
      async ({ allowedNames, knownNames }) => {
        const normalizeSchema = (value) => {
          if (typeof value !== "string") return value ?? {};
          try {
            return JSON.parse(value);
          } catch {
            return value.slice(0, 8_000);
          }
        };
        const project = (tool) => ({
          name: String(tool?.name ?? "").slice(0, 160),
          title:
            typeof tool?.title === "string"
              ? tool.title.slice(0, 240)
              : undefined,
          description:
            typeof tool?.description === "string"
              ? tool.description.slice(0, 2_000)
              : "",
          inputSchema: normalizeSchema(tool?.inputSchema),
          annotations:
            tool?.annotations && typeof tool.annotations === "object"
              ? {
                  readOnlyHint: tool.annotations.readOnlyHint === true,
                  untrustedContentHint:
                    tool.annotations.untrustedContentHint === true,
                }
              : undefined,
        });
        const readTools = async () => {
          const testing = navigator.modelContextTesting;
          if (typeof testing?.listTools === "function") {
            return {
              apiSurface: "navigator.modelContextTesting",
              tools: (await testing.listTools()).map(project),
            };
          }
          if (typeof document.modelContext?.getTools === "function") {
            return {
              apiSurface: "document.modelContext",
              tools: (await document.modelContext.getTools()).map(project),
            };
          }
          return undefined;
        };
        let last;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          last = await readTools();
          if (
            last &&
            allowedNames.every((name) =>
              last.tools.some((tool) => tool.name === name),
            )
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return {
          available: Boolean(last),
          apiSurface: last?.apiSurface,
          userAgent: navigator.userAgent.slice(0, 500),
          tools: (last?.tools ?? []).filter((tool) =>
            allowedNames.includes(tool.name),
          ),
          unexpectedToolNames: (last?.tools ?? [])
            .map((tool) => tool.name)
            .filter((name) => name && !knownNames.includes(name))
            .slice(0, 20),
        };
      },
      { allowedNames: expectedToolNames, knownNames: knownToolNames },
    );
    return discovery;
  }

  async invokeLiveWebMcpTool({ apiSurface, name, arguments: input }) {
    return this.page.evaluate(
      async ({ apiSurface: surface, name: toolName, input: toolInput }) => {
        let result;
        if (surface === "navigator.modelContextTesting") {
          result = await navigator.modelContextTesting.executeTool(
            toolName,
            JSON.stringify(toolInput),
          );
        } else {
          const tools = await document.modelContext.getTools();
          const tool = tools.find(({ name }) => name === toolName);
          if (!tool) throw new Error(`WebMCP tool ${toolName} is no longer registered`);
          result = await document.modelContext.executeTool(
            tool,
            JSON.stringify(toolInput),
          );
        }
        if (typeof result === "string") {
          try {
            return JSON.parse(result);
          } catch {
            return result;
          }
        }
        return result;
      },
      { apiSurface, name, input },
    );
  }

  async observeLiveWebMcpProposalReview({ fixtureVideoId }) {
    return this.page.evaluate(async (videoId) => {
      let modalVisible = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const text = document.body?.innerText ?? "";
        modalVisible =
          text.includes("Review clips") && text.includes("Suggested via WebMCP");
        if (modalVisible) break;
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
      const response = await fetch(
        `/api/videos/${encodeURIComponent(videoId)}`,
        { credentials: "include" },
      );
      const detail = response.ok ? await response.json() : undefined;
      return {
        modalVisible,
        persistenceStatus: response.status,
        clipCount: Array.isArray(detail?.clips) ? detail.clips.length : null,
      };
    }, fixtureVideoId);
  }

  requireWebMcpJourney() {
    if (!this.webMcpJourney) {
      throw new Error("The host did not provide a live WebMCP fixture workspace");
    }
    return this.webMcpJourney;
  }

  unwrapWebMcpReceipt(receipt) {
    if (receipt.status === "advanced" || receipt.output !== undefined) {
      return receipt.output;
    }
    throw new Error(receipt.error?.message ?? "The live WebMCP journey failed");
  }

  async listWebMcpTools() {
    const receipt = await this.requireWebMcpJourney().perform({ kind: "discover" });
    return this.unwrapWebMcpReceipt(receipt);
  }

  async callWebMcpTool({ name, arguments: input }) {
    const action =
      name === "getCarpoInstructions"
        ? "get-instructions"
        : name === "readClipWorkspace"
          ? "read-workspace"
          : name === "proposeClips"
            ? "propose-clip"
            : undefined;
    if (!action) {
      throw new Error("The requested WebMCP tool is outside Carpo's review allowlist");
    }
    const receipt = await this.requireWebMcpJourney().perform({
      kind: action,
      input,
    });
    return this.unwrapWebMcpReceipt(receipt);
  }

  requireElement(elementId) {
    assertReviewElementId(elementId);
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error("The browser element id is stale; inspect the page again");
    }
    if (element.disabled) throw new Error("The requested browser element is disabled");
    return element;
  }

  async click(elementId) {
    const element = this.requireElement(elementId);
    assertSafeReviewClick(element, REVIEW_ORIGIN);
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
    assertSafeReviewFill(element, value);
    const nextProofStep = assertProofChallengeFill({
      challengeId: this.proofChallenge?.id,
      completedCount: this.proofChallengeSteps.length,
      pending: this.pendingProofChallengeStep,
      currentPath: new URL(this.page.url()).pathname,
      element,
      value,
    });
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

  async captureRawEvidence(note) {
    if (this.screenshots.length >= MAX_REVIEW_SCREENSHOTS) {
      throw new Error(
        `The review already captured its ${MAX_REVIEW_SCREENSHOTS}-screenshot budget`,
      );
    }
    this.recordCurrentPath();
    const pendingProof = this.pendingProofChallengeStep;
    if (pendingProof) {
      const currentPath = new URL(this.page.url()).pathname;
      const visibleValue = await this.page
        .locator(`[data-carpo-agentic-id="${pendingProof.elementId}"]`)
        .inputValue();
      assertProofChallengeEvidence({
        pending: pendingProof,
        currentPath,
        observedValue: visibleValue,
      });
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

  async captureLiveWebMcpProof({ note, fixtureVideoId }) {
    const evidence = await this.captureRawEvidence(note);
    const observation = await this.observeLiveWebMcpProposalReview({
      fixtureVideoId,
    });
    evidence.webMcp = {
      reviewVisible: observation.modalVisible,
      createdClipCount: observation.clipCount,
    };
    return {
      evidence,
      reviewVisible: observation.modalVisible,
      createdClipCount: observation.clipCount,
    };
  }

  async captureEvidence(note) {
    if (this.webMcpJourney?.view().nextAction === "capture-proof") {
      const receipt = await this.webMcpJourney.perform({
        kind: "capture-proof",
        note,
      });
      return this.unwrapWebMcpReceipt(receipt);
    }
    return this.captureRawEvidence(note);
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

  webMcpResult(experience) {
    return this.webMcpJourney?.dossier(experience);
  }

  async readDiagnostics() {
    this.diagnosticsRead = true;
    return this.diagnostics;
  }

  async finishReview(report) {
    assertReviewComplete({
      progress: {
        readSources: this.readSources,
        visitedPaths: this.visitedPaths,
        navigationStatuses: this.navigationStatuses,
        layoutChecks: this.layoutChecks,
        currentPath: new URL(this.page.url()).pathname,
        diagnosticsRead: this.diagnosticsRead,
        screenshots: this.screenshots,
        proofChallengeSteps: this.proofChallengeSteps,
        pendingProofChallenge: this.pendingProofChallengeStep,
        webMcp: this.webMcpResult(report.webMcpExperience),
      },
      report,
      reviewOrigin: REVIEW_ORIGIN,
      proofChallengeId: this.proofChallenge?.id,
      webMcpRequired: Boolean(this.webMcpJourney),
    });
    const boundedReport = enforceCoverageBoundary(report);
    return boundedReport;
  }
}

export function appendHostDiagnosticsFinding(report, diagnostics) {
  return appendDiagnosticsFinding(report, diagnostics);
}

function unstartedWebMcpDossier(fixtureVideoId) {
  return {
    ...createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser: {},
    }).dossier(),
    proofBoundary:
      "No live WebMCP proof was established because the bounded Flue review did not start the WebMCP journey.",
  };
}

async function runAgenticBrowserReview(args) {
  const cdpEndpoint = process.env.CARPO_BROWSER_CDP_URL ?? args.ws;
  const authToken = process.env.CARPO_PR_REVIEW_AUTH_TOKEN;
  const expectedVersionTag = args["expected-version-tag"];
  const executionId = args["execution-id"];
  const outputDir = path.resolve(args.output ?? "test-output/pr-review");
  const proofChallenge = resolveProofChallenge(args["proof-challenge"]);
  const webMcpFixtureVideoId = args["webmcp-video-id"];
  if (
    args.url !== REVIEW_ORIGIN &&
    args.url !== `${REVIEW_ORIGIN}/`
  ) {
    throw new Error(`The Flue review target must be exactly ${REVIEW_ORIGIN}`);
  }
  if (
    !cdpEndpoint ||
    !authToken ||
    !expectedVersionTag ||
    !executionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      webMcpFixtureVideoId ?? "",
    )
  ) {
    throw new Error(
      "Usage: flue-pr-browser-review.mjs --url <review-url> --expected-version-tag <tag> --execution-id <id> --webmcp-video-id <uuid> with Browser Run and review-auth credentials",
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
    await page.goto(`${REVIEW_ORIGIN}/create`, {
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
      webMcpFixtureVideoId,
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
      webMcpFixtureVideoId,
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
    schemaVersion: AGENTIC_REVIEW_SCHEMA_VERSION,
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
    webMcp:
      adapter?.webMcpResult(report?.webMcpExperience) ??
      unstartedWebMcpDossier(webMcpFixtureVideoId),
    diagnostics,
    toolCalls: agentResult?.toolCalls ?? 0,
    timeline: agentResult?.timeline ?? [],
    providerDiagnostics: agentResult?.providerDiagnostics,
    trace,
    failure,
    proofBoundary: ADVISORY_REVIEW_PROOF_BOUNDARY,
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
