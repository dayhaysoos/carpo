import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REVIEW_COOKIE = "carpo_pr_review";
export const REVIEW_ORIGIN =
  "https://carpo-pr-review.ndejesus1227.workers.dev";

function boundedText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function createBrowserDiagnostics() {
  return {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    serverErrors: [],
    blockedMutations: [],
  };
}

export function observeBrowserDiagnostics(page, reviewOrigin, diagnostics) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors.push({
        text: boundedText(message.text(), 2_000),
        location: message.location(),
      });
    }
  });
  page.on("pageerror", (error) =>
    diagnostics.pageErrors.push(boundedText(error.message, 2_000)),
  );
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === reviewOrigin) {
      diagnostics.failedRequests.push({
        url: request.url(),
        reason: boundedText(request.failure()?.errorText, 500),
      });
    }
  });
  page.on("response", (response) => {
    if (
      new URL(response.url()).origin === reviewOrigin &&
      response.status() >= 500
    ) {
      diagnostics.serverErrors.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });
}

export function browserDiagnosticCount(diagnostics) {
  return Object.values(diagnostics).reduce(
    (total, entries) => total + entries.length,
    0,
  );
}

export async function traceContainsSecret(tracePath, secret) {
  const { stdout } = await execFileAsync("unzip", ["-p", tracePath], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.includes(Buffer.from(secret));
}

export async function readCandidateIdentity(
  page,
  { reviewOrigin, expectedVersionTag, expectedVersionId },
) {
  const response = await page.goto(`${reviewOrigin}/api/review/identity`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!response?.ok()) {
    throw new Error(
      `Candidate identity request failed with status ${response?.status() ?? "unknown"}`,
    );
  }
  const candidate = await response.json();
  if (
    typeof candidate?.id !== "string" ||
    typeof candidate?.tag !== "string" ||
    typeof candidate?.timestamp !== "string"
  ) {
    throw new Error("Candidate identity returned invalid Worker version metadata");
  }
  if (candidate.tag !== expectedVersionTag) {
    throw new Error(
      `Deployed Worker tag ${JSON.stringify(candidate.tag)} does not match expected tag ${JSON.stringify(expectedVersionTag)}`,
    );
  }
  if (expectedVersionId && candidate.id !== expectedVersionId) {
    throw new Error(
      `Deployed Worker version changed from ${expectedVersionId} to ${candidate.id} during browser review`,
    );
  }
  return candidate;
}
