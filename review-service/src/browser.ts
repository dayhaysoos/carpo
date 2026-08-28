import {
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  type CdpSession,
} from "agents/browser";
import {
  assertProofChallengeEvidence,
  assertReviewElementId,
  assertSafeReviewClick,
  assertSafeReviewFill,
  MAX_REVIEW_SCREENSHOTS,
  normalizeEvidenceNote,
  READ_ONLY_BROWSER_METHODS,
  readBoundedReviewMaterial,
  resolveSafeReviewPath,
  VIEWPORT_PRESETS,
} from "@carpo/review-contract";
import type {
  BrowserReviewState,
  DurableReviewInitialData,
  ReviewElement,
  ScreenshotEvidence,
} from "./types";

const REVIEW_COOKIE = "carpo_pr_review";

type CdpResult<T> = T;

function asResult<T>(value: unknown) {
  return value as CdpResult<T>;
}

function escapeExpressionValue(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function waitForReady(cdp: CdpSession, sessionId: string) {
  await cdp.send(
    "Runtime.evaluate",
    {
      expression: `new Promise((resolve) => {
        if (document.readyState === "interactive" || document.readyState === "complete") resolve(true);
        else document.addEventListener("DOMContentLoaded", () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 15000);
      })`,
      awaitPromise: true,
      returnByValue: true,
    },
    { sessionId, timeoutMs: 20_000 },
  );
}

async function evaluate<T>(
  cdp: CdpSession,
  sessionId: string,
  expression: string,
): Promise<T> {
  const response = asResult<{
    result?: { value?: T; description?: string };
    exceptionDetails?: { text?: string };
  }>(
    await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      { sessionId, timeoutMs: 30_000 },
    ),
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.text ??
        response.result?.description ??
        "Browser evaluation failed",
    );
  }
  return response.result?.value as T;
}

async function withPage<T>(
  env: Env,
  state: BrowserReviewState,
  run: (cdp: CdpSession, attachedSessionId: string) => Promise<T>,
) {
  if (!state.browserSessionId || !state.targetId) {
    throw new Error("The recorded Browser Run session has not started");
  }
  const cdp = await connectBrowserSession(
    env.BROWSER,
    state.browserSessionId,
    30_000,
  );
  try {
    const attachedSessionId = await cdp.attachToTarget(state.targetId, {
      timeoutMs: 30_000,
    });
    return await run(cdp, attachedSessionId);
  } finally {
    cdp.disconnect();
  }
}

function browserGuardScript(reviewOrigin: string) {
  return `(() => {
    if (window.__carpoReviewGuardInstalled) return;
    window.__carpoReviewGuardInstalled = true;
    window.__carpoReviewDiagnostics = { console: [], pageErrors: [], requestFailures: [], blockedMutations: [] };
    const diag = window.__carpoReviewDiagnostics;
    const bound = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 2000);
    for (const method of ["error", "warn"]) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        diag.console.push({ level: method, text: bound(args.map(bound).join(" ")), path: location.pathname });
        original(...args);
      };
    }
    addEventListener("error", (event) => diag.pageErrors.push({ text: bound(event.message), path: location.pathname }));
    addEventListener("unhandledrejection", (event) => diag.pageErrors.push({ text: bound(event.reason), path: location.pathname }));
    const originalFetch = fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url, location.href);
      if (!${JSON.stringify(READ_ONLY_BROWSER_METHODS)}.includes(request.method.toUpperCase())) {
        diag.blockedMutations.push({ method: request.method, url: url.origin + url.pathname });
        throw new DOMException("Blocked by Carpo advisory review", "SecurityError");
      }
      try {
        const response = await originalFetch(request);
        if (!response.ok && url.origin === ${escapeExpressionValue(reviewOrigin)}) {
          diag.requestFailures.push({ method: request.method, url: url.pathname, status: response.status });
        }
        return response;
      } catch (error) {
        diag.requestFailures.push({ method: request.method, url: url.origin + url.pathname, error: bound(error) });
        throw error;
      }
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      if (!${JSON.stringify(READ_ONLY_BROWSER_METHODS)}.includes(String(method).toUpperCase())) {
        diag.blockedMutations.push({ method: String(method), url: new URL(String(url), location.href).pathname });
        throw new DOMException("Blocked by Carpo advisory review", "SecurityError");
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    HTMLFormElement.prototype.submit = function() {
      diag.blockedMutations.push({ method: "FORM", url: location.pathname });
      throw new DOMException("Blocked by Carpo advisory review", "SecurityError");
    };
    addEventListener("submit", (event) => {
      event.preventDefault();
      diag.blockedMutations.push({ method: "FORM", url: location.pathname });
    }, true);
    navigator.sendBeacon = () => {
      diag.blockedMutations.push({ method: "BEACON", url: location.pathname });
      return false;
    };
  })()`;
}

export function createInitialBrowserState(): BrowserReviewState {
  return {
    phase: "browsing",
    browserSessionId: null,
    targetId: null,
    currentPath: "/",
    elements: [],
    screenshots: [],
    screenshotHashes: [],
    readSources: [],
    visitedPaths: [],
    navigationStatuses: {},
    layoutChecks: [],
    diagnosticsRead: false,
    startedAt: null,
    proofChallengeSteps: [],
    pendingProofChallenge: null,
  };
}

export async function startBrowserReview(
  env: Env,
  data: DurableReviewInitialData,
) {
  if (!env.TARGET_REVIEW_AUTH_TOKEN) {
    throw new Error("TARGET_REVIEW_AUTH_TOKEN is not configured");
  }
  if (new URL(data.candidate.reviewOrigin).origin !== env.TARGET_REVIEW_ORIGIN) {
    throw new Error("The candidate review origin does not match the trusted Worker setting");
  }
  const browser = await createBrowserSession(env.BROWSER, {
    keepAliveMs: 15 * 60 * 1000,
    includeTargets: true,
    recording: true,
  });
  const targetId = browser.targets?.find((target) => target.type === "page")?.id;
  if (!targetId) {
    await deleteBrowserSession(env.BROWSER, browser.sessionId).catch(() => {});
    throw new Error("Browser Run did not create a page target");
  }

  const state = {
    ...createInitialBrowserState(),
    browserSessionId: browser.sessionId,
    targetId,
    startedAt: new Date().toISOString(),
  };
  try {
    await withPage(env, state, async (cdp, attachedSessionId) => {
      await Promise.all([
        cdp.send("Page.enable", {}, { sessionId: attachedSessionId }),
        cdp.send("Runtime.enable", {}, { sessionId: attachedSessionId }),
        cdp.send("Network.enable", {}, { sessionId: attachedSessionId }),
      ]);
      await cdp.send(
        "Network.setCookie",
        {
          name: REVIEW_COOKIE,
          value: env.TARGET_REVIEW_AUTH_TOKEN,
          url: data.candidate.reviewOrigin,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
        { sessionId: attachedSessionId },
      );
      await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: browserGuardScript(data.candidate.reviewOrigin) },
        { sessionId: attachedSessionId },
      );
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { ...VIEWPORT_PRESETS.desktop, deviceScaleFactor: 1, mobile: false },
        { sessionId: attachedSessionId },
      );
      await cdp.send(
        "Page.navigate",
        { url: new URL("/", data.candidate.reviewOrigin).href },
        { sessionId: attachedSessionId },
      );
      await waitForReady(cdp, attachedSessionId);
      const identity = await evaluate<{ id?: string; tag?: string }>(
        cdp,
        attachedSessionId,
        `(async () => {
          const response = await fetch("/api/review/identity", { credentials: "include" });
          if (!response.ok) throw new Error("identity HTTP " + response.status);
          return await response.json();
        })()`,
      );
      if (identity?.tag !== data.candidate.expectedVersionTag) {
        throw new Error("The deployed candidate identity does not match the frozen head");
      }
    });
    return state;
  } catch (error) {
    await deleteBrowserSession(env.BROWSER, browser.sessionId).catch(() => {});
    throw error;
  }
}

export function readReviewMaterial(
  data: DurableReviewInitialData,
  source: "context" | "diff",
  offset: number,
) {
  const material = source === "context" ? data.contextText : data.diffText;
  return readBoundedReviewMaterial({ source, material, offset });
}

export async function inspectPage(env: Env, state: BrowserReviewState) {
  return withPage(env, state, async (cdp, attachedSessionId) =>
    evaluate<{
      url: string;
      title: string;
      heading?: string;
      viewport: { width: number; height: number };
      layout: {
        clientWidth: number;
        scrollWidth: number;
        hasHorizontalOverflow: boolean;
        overflowingElements: unknown[];
      };
      visibleText: string;
      elements: ReviewElement[];
    }>(
      cdp,
      attachedSessionId,
      `(() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"]')).filter(visible).slice(0, 100);
        const elements = candidates.map((element, index) => {
          const id = "e" + (index + 1);
          element.setAttribute("data-carpo-agentic-id", id);
          const labels = element.labels ? Array.from(element.labels) : [];
          const name = element.getAttribute("aria-label") || labels.map((label) => label.textContent || "").join(" ") || element.getAttribute("name") || element.getAttribute("placeholder") || element.textContent || "";
          return { id, tag: element.tagName.toLowerCase(), role: element.getAttribute("role") || undefined, type: element.getAttribute("type") || undefined, name: name.replace(/\\s+/g, " ").trim().slice(0, 240), text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240), ariaLabel: element.getAttribute("aria-label") || undefined, href: element instanceof HTMLAnchorElement ? element.href : undefined, disabled: "disabled" in element && typeof element.disabled === "boolean" ? element.disabled : undefined };
        });
        const clientWidth = document.documentElement.clientWidth;
        return { url: location.href, title: document.title, heading: document.querySelector("h1, h2")?.textContent?.trim(), viewport: { width: innerWidth, height: innerHeight }, layout: { clientWidth, scrollWidth: document.documentElement.scrollWidth, hasHorizontalOverflow: document.documentElement.scrollWidth > clientWidth + 1, overflowingElements: Array.from(document.querySelectorAll("body *")).filter((element) => { const rect = element.getBoundingClientRect(); return rect.right > clientWidth + 1 || rect.left < -1; }).slice(0, 12).map((element) => ({ tag: element.tagName.toLowerCase(), id: element.id || undefined, className: typeof element.className === "string" ? element.className.replace(/\\s+/g, " ").trim().slice(0, 160) : undefined, text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160) })) }, visibleText: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 8000), elements };
      })()`,
    ),
  );
}

export async function navigatePage(
  env: Env,
  state: BrowserReviewState,
  requestedPath: string,
  reviewOrigin: string,
) {
  const safePath = resolveSafeReviewPath(requestedPath, reviewOrigin);
  return withPage(env, state, async (cdp, attachedSessionId) => {
    await cdp.send(
      "Page.navigate",
      { url: new URL(safePath, reviewOrigin).href },
      { sessionId: attachedSessionId },
    );
    await waitForReady(cdp, attachedSessionId);
    return evaluate<{ url: string; path: string; status: number | null }>(
      cdp,
      attachedSessionId,
      `(() => { const entry = performance.getEntriesByType("navigation")[0]; return { url: location.href, path: location.pathname, status: typeof entry?.responseStatus === "number" ? entry.responseStatus : null }; })()`,
    );
  });
}

export async function setViewport(
  env: Env,
  state: BrowserReviewState,
  preset: keyof typeof VIEWPORT_PRESETS,
) {
  const viewport = VIEWPORT_PRESETS[preset];
  await withPage(env, state, (cdp, attachedSessionId) =>
    cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: preset === "mobile",
      },
      { sessionId: attachedSessionId },
    ),
  );
  return { preset, ...viewport };
}

function requireElement(state: BrowserReviewState, elementId: string) {
  assertReviewElementId(elementId);
  const element = state.elements.find(({ id }) => id === elementId);
  if (!element) throw new Error("The browser element id is stale; inspect again");
  if (element.disabled) throw new Error("The requested browser element is disabled");
  return element;
}

export async function clickElement(
  env: Env,
  state: BrowserReviewState,
  elementId: string,
  reviewOrigin: string,
) {
  const element = requireElement(state, elementId);
  assertSafeReviewClick(element, reviewOrigin);
  return withPage(env, state, async (cdp, attachedSessionId) => {
    await evaluate(
      cdp,
      attachedSessionId,
      `(() => { const element = document.querySelector(${escapeExpressionValue(`[data-carpo-agentic-id="${elementId}"]`)}); if (!element) throw new Error("stale element"); element.click(); return true; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    return evaluate<{ clicked: string; url: string; path: string }>(
      cdp,
      attachedSessionId,
      `({ clicked: ${escapeExpressionValue(elementId)}, url: location.href, path: location.pathname })`,
    );
  });
}

export async function fillElement(
  env: Env,
  state: BrowserReviewState,
  elementId: string,
  value: string,
) {
  const element = requireElement(state, elementId);
  assertSafeReviewFill(element, value);
  await withPage(env, state, (cdp, attachedSessionId) =>
    evaluate(
      cdp,
      attachedSessionId,
      `(() => { const element = document.querySelector(${escapeExpressionValue(`[data-carpo-agentic-id="${elementId}"]`)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("stale or unsupported field"); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set; setter?.call(element, ${escapeExpressionValue(value)}); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); return { filled: ${escapeExpressionValue(elementId)}, retained: true, path: location.pathname }; })()`,
    ),
  );
  return { filled: elementId, retained: true };
}

function base64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function captureEvidence(
  env: Env,
  state: BrowserReviewState,
  data: DurableReviewInitialData,
  note: string,
): Promise<ScreenshotEvidence> {
  if (state.screenshots.length >= MAX_REVIEW_SCREENSHOTS) {
    throw new Error(
      `The review already captured ${MAX_REVIEW_SCREENSHOTS} screenshots`,
    );
  }
  const captured = await withPage(env, state, async (cdp, attachedSessionId) => {
    await evaluate(cdp, attachedSessionId, "scrollTo(0, 0); true");
    if (state.pendingProofChallenge) {
      const observed = await evaluate<{ path: string; value: string | null }>(
        cdp,
        attachedSessionId,
        `(() => { const element = document.querySelector(${escapeExpressionValue(`[data-carpo-agentic-id="${state.pendingProofChallenge.elementId}"]`)}); return { path: location.pathname, value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : null }; })()`,
      );
      assertProofChallengeEvidence({
        pending: state.pendingProofChallenge,
        currentPath: observed.path,
        observedValue: observed.value,
      });
    }
    const page = await evaluate<{ url: string; path: string }>(
      cdp,
      attachedSessionId,
      "({ url: location.href, path: location.pathname })",
    );
    const screenshot = asResult<{ data: string }>(
      await cdp.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        { sessionId: attachedSessionId, timeoutMs: 30_000 },
      ),
    );
    return { ...page, bytes: base64Bytes(screenshot.data) };
  });
  const sha256 = hex(await crypto.subtle.digest("SHA-256", captured.bytes));
  if (state.screenshotHashes.includes(sha256)) {
    throw new Error("This viewport duplicates existing evidence");
  }
  const file = `agentic-${String(state.screenshots.length + 1).padStart(2, "0")}.png`;
  await env.EVIDENCE_BUCKET.put(
    `durable-reviews/${data.executionId}/${file}`,
    captured.bytes,
    {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        executionId: data.executionId,
        headSha: data.candidate.headSha,
      },
    },
  );
  return {
    file,
    note: state.pendingProofChallenge ? note : normalizeEvidenceNote(note),
    url: captured.url,
    path: captured.path,
    sha256,
    downloadUrl: `${env.REPORT_ORIGIN}/api/reviews/${encodeURIComponent(data.executionId)}/evidence/${file}`,
  };
}

export async function readDiagnostics(env: Env, state: BrowserReviewState) {
  return withPage(env, state, (cdp, attachedSessionId) =>
    evaluate<{
      console: unknown[];
      pageErrors: unknown[];
      requestFailures: unknown[];
      blockedMutations: unknown[];
    }>(
      cdp,
      attachedSessionId,
      `window.__carpoReviewDiagnostics ?? { console: [], pageErrors: [], requestFailures: [], blockedMutations: [] }`,
    ),
  );
}

export async function verifyCandidateIdentity(
  env: Env,
  state: BrowserReviewState,
  expectedVersionTag: string,
) {
  return withPage(env, state, async (cdp, attachedSessionId) => {
    const identity = await evaluate<{ tag?: string }>(
      cdp,
      attachedSessionId,
      `(async () => { const response = await fetch("/api/review/identity", { credentials: "include" }); if (!response.ok) throw new Error("identity HTTP " + response.status); return await response.json(); })()`,
    );
    if (identity?.tag !== expectedVersionTag) {
      throw new Error("Candidate identity changed during the browser review");
    }
    return identity;
  });
}

export async function closeBrowserReview(env: Env, state: BrowserReviewState) {
  if (!state.browserSessionId) return;
  await deleteBrowserSession(env.BROWSER, state.browserSessionId);
}
