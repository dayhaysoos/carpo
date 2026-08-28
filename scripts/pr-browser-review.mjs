import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  browserDiagnosticCount,
  createBrowserDiagnostics,
  observeBrowserDiagnostics,
  readCandidateIdentity,
  REVIEW_COOKIE,
  REVIEW_ORIGIN,
  traceContainsSecret,
} from "./pr-browser-review-runtime.mjs";
import {
  prepareReviewOutput,
  redactSecrets,
} from "./pr-browser-review-utils.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readOptional(filePath, fallback) {
  if (!filePath) return fallback;
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function changedPaths(context) {
  if (!context || !Array.isArray(context.files)) return [];
  return context.files.flatMap((file) => {
    if (typeof file === "string") return [file];
    return typeof file?.path === "string" ? [file.path] : [];
  });
}

function reviewContextText(context) {
  const text = [];
  const append = (value) => {
    if (typeof value === "string") text.push(value);
  };
  const appendComments = (comments) => {
    if (!Array.isArray(comments)) return;
    for (const comment of comments) append(comment?.body);
  };

  append(context?.title);
  append(context?.body);
  appendComments(context?.comments);
  if (Array.isArray(context?.commits)) {
    for (const commit of context.commits) {
      append(commit?.messageHeadline);
      append(commit?.messageBody);
    }
  }
  if (Array.isArray(context?.linkedIssueContext)) {
    for (const issue of context.linkedIssueContext) {
      append(issue?.title);
      append(issue?.body);
      appendComments(issue?.comments?.nodes ?? issue?.comments);
    }
  }
  return text.join("\n");
}

function selectSurfaces(paths, contextText) {
  const selected = [
    {
      id: "create-shell",
      route: "/",
      reason: "Permanent smoke check for the upload-first product entry point",
    },
    {
      id: "library-shell",
      route: "/library",
      reason: "Permanent smoke check for persisted-video navigation and API settlement",
    },
  ];
  const selectedByDiff = paths.some((file) =>
    /Library|library|source-video|routes\.ts/.test(file),
  );
  const selectedByContext = /\b(?:archive(?:d|s|ing)?|librar(?:y|ies))\b/i.test(
    contextText,
  );

  if (paths.length === 0 || selectedByDiff || selectedByContext) {
    const signals = [];
    if (paths.length === 0) signals.push("manual run without changed-path context");
    if (selectedByDiff) signals.push("exact changed-path map");
    if (selectedByContext) signals.push("bounded PR or linked-issue context map");
    selected.push({
      id: "archive-shell",
      route: "/library?view=archived",
      reason: `Selected by ${signals.join(" and ")}`,
    });
  }

  return selected;
}

async function createReviewPlan(args, outputDir) {
  const cdpEndpoint = process.env.CARPO_BROWSER_CDP_URL ?? args.ws;
  const authToken = process.env.CARPO_PR_REVIEW_AUTH_TOKEN;
  if (
    typeof args.url !== "string" ||
    typeof cdpEndpoint !== "string" ||
    typeof args["expected-version-tag"] !== "string" ||
    !authToken
  ) {
    throw new Error(
      "Usage: pr-browser-review.mjs --url <https-url> --expected-version-tag <tag> with Browser Run and review-auth credentials",
    );
  }

  const baseUrl = new URL(args.url);
  if (baseUrl.href !== `${REVIEW_ORIGIN}/`) {
    throw new Error(`The PR review target must be exactly ${REVIEW_ORIGIN}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(args["expected-version-tag"])) {
    throw new Error("The expected Worker version tag has an invalid format");
  }

  const contextText = await readOptional(args.context, "{}");
  const diffText = await readOptional(args.diff, "");
  const context = JSON.parse(contextText);
  const paths = changedPaths(context);
  const surfaces = selectSurfaces(paths, reviewContextText(context));

  return {
    schemaVersion: "carpo.pr-browser-review.v0",
    baseUrl,
    cdpEndpoint,
    authToken,
    expectedVersionTag: args["expected-version-tag"],
    outputDir,
    contextSha256: sha256(contextText),
    diffSha256: sha256(diffText),
    changedPaths: paths,
    surfaces,
  };
}

async function visible(locator, label, assertions) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  assertions.push({ label, status: "passed" });
}

async function capturePage(page, filePath) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: filePath });
}

async function assertCandidateIdentity(
  page,
  plan,
  assertions,
  expectedVersionId,
) {
  const candidate = await readCandidateIdentity(page, {
    reviewOrigin: plan.baseUrl.origin,
    expectedVersionTag: plan.expectedVersionTag,
    expectedVersionId,
  });
  assertions.push({
    label: expectedVersionId
      ? "Deployed Worker version stayed fixed throughout browser review"
      : `Deployed Worker tag matches ${plan.expectedVersionTag}`,
    status: "passed",
  });
  return candidate;
}

async function assertLibrarySettled(page, heading, label, assertions) {
  await visible(page.getByRole("heading", heading), `${label} renders`, assertions);
  const panel = page.locator(".library-panel");
  await panel
    .getByText("Loading your videos…", { exact: true })
    .waitFor({ state: "hidden", timeout: 15_000 });
  await panel
    .locator(".empty-state, .video-list, .form-error")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  const error = panel.locator(".form-error").first();
  if (await error.isVisible().catch(() => false)) {
    throw new Error(`${label} reported an error: ${await error.innerText()}`);
  }
  assertions.push({ label: `${label} request settles without an error`, status: "passed" });
}

async function assertCreateSettled(page, assertions) {
  const jobsPanel = page.locator(".status-panel");
  await jobsPanel
    .getByRole("heading", { name: "Jobs", level: 2 })
    .waitFor({ state: "visible", timeout: 15_000 });
  await jobsPanel
    .getByText("Loading jobs…", { exact: true })
    .waitFor({ state: "hidden", timeout: 15_000 });
  await jobsPanel
    .locator(":scope > .empty-state, :scope > .job-list, :scope > .job-error")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  const error = jobsPanel.locator(":scope > .job-error");
  if (await error.isVisible().catch(() => false)) {
    throw new Error(`Create jobs request reported an error: ${await error.innerText()}`);
  }
  assertions.push({ label: "Create jobs request settles without an error", status: "passed" });
}

async function reviewProductSurfaces(page, plan, run) {
  await page.goto(new URL("/", plan.baseUrl).href, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await visible(page.getByRole("heading", { name: "Carpo", level: 1 }), "Carpo shell renders", run.assertions);
  await visible(page.getByRole("heading", { name: "New clip", level: 2 }), "Create surface renders", run.assertions);
  await assertCreateSettled(page, run.assertions);
  const uploadTab = page.getByRole("tab", { name: "Upload file" });
  await uploadTab.waitFor({ state: "visible", timeout: 15_000 });
  if ((await uploadTab.getAttribute("aria-selected")) !== "true") {
    throw new Error("Owned-video upload is not the default source mode");
  }
  run.assertions.push({ label: "Owned-video upload is the default source mode", status: "passed" });
  await visible(page.getByRole("tab", { name: "YouTube URL" }), "Best-effort YouTube source remains available", run.assertions);
  const title = page.getByLabel("Title");
  const overlayText = page
    .getByLabel("Overlay text (optional)")
    .or(page.getByLabel("Caption (optional)"));
  await title.fill("Manual review title");
  await overlayText.fill("Manual review overlay text");
  if ((await title.inputValue()) !== "Manual review title") {
    throw new Error("Manual title editing did not retain the entered value");
  }
  if ((await overlayText.inputValue()) !== "Manual review overlay text") {
    throw new Error("Manual overlay-text editing did not retain the entered value");
  }
  run.assertions.push({ label: "Manual title editing remains available", status: "passed" });
  run.assertions.push({ label: "Manual overlay-text editing remains available", status: "passed" });

  await uploadTab.click();
  await visible(page.getByLabel("Video file"), "File picker renders after selecting upload", run.assertions);
  if (!(await page.getByRole("button", { name: "Create clip" }).isDisabled())) {
    throw new Error("Create clip should be disabled before a source and title are supplied");
  }
  run.assertions.push({ label: "Incomplete clip cannot be submitted", status: "passed" });
  await capturePage(page, path.join(plan.outputDir, "create.png"));
  run.screenshots.push("create.png");

  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.waitForURL(/\/library(?:\?.*)?$/, { timeout: 15_000 });
  await visible(page.getByRole("link", { name: "Videos" }), "Active videos view is available", run.assertions);
  await visible(page.getByRole("link", { name: "Archived" }), "Archived videos view is available", run.assertions);
  await assertLibrarySettled(page, { name: "Library", level: 2 }, "Library surface", run.assertions);
  await capturePage(page, path.join(plan.outputDir, "library.png"));
  run.screenshots.push("library.png");

  if (plan.surfaces.some((surface) => surface.id === "archive-shell")) {
    await page.getByRole("link", { name: "Archived" }).click();
    await assertLibrarySettled(page, { name: "Archived videos", level: 2 }, "Archived library surface", run.assertions);
    await capturePage(page, path.join(plan.outputDir, "archived.png"));
    run.screenshots.push("archived.png");
  }
}

async function runBrowserReview(plan) {
  const run = {
    startedAt: new Date().toISOString(),
    assertions: [],
    diagnostics: createBrowserDiagnostics(),
    screenshots: [],
    candidate: undefined,
    trace: undefined,
    failure: undefined,
  };
  let browser;
  let browserContext;
  let page;

  try {
    const cdpUrl = new URL(plan.cdpEndpoint);
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const connectionOptions =
      cdpUrl.hostname === "api.cloudflare.com" && apiToken
        ? { headers: { Authorization: `Bearer ${apiToken}` } }
        : undefined;
    browser = await chromium.connectOverCDP(plan.cdpEndpoint, connectionOptions);
    browserContext = browser.contexts()[0] ?? (await browser.newContext());
    await browserContext.addCookies([
      {
        name: REVIEW_COOKIE,
        value: plan.authToken,
        url: plan.baseUrl.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
    page = browserContext.pages()[0] ?? (await browserContext.newPage());
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Network/DOM snapshots retain request headers. The action timeline and
    // screenshots remain useful while keeping the review cookie out of traces.
    await browserContext.tracing.start({ screenshots: true, snapshots: false });
    observeBrowserDiagnostics(page, plan.baseUrl.origin, run.diagnostics);

    run.candidate = await assertCandidateIdentity(page, plan, run.assertions);
    await reviewProductSurfaces(page, plan, run);
    await assertCandidateIdentity(
      page,
      plan,
      run.assertions,
      run.candidate.id,
    );

    if (browserDiagnosticCount(run.diagnostics) > 0) {
      const { consoleErrors, pageErrors, failedRequests, serverErrors } = run.diagnostics;
      throw new Error(
        `Browser diagnostics were not clean (${consoleErrors.length} console, ${pageErrors.length} page, ${failedRequests.length} request, ${serverErrors.length} server errors)`,
      );
    }
  } catch (error) {
    run.failure = redactSecrets(error instanceof Error ? error.message : error);
    if (page) {
      await capturePage(page, path.join(plan.outputDir, "failure.png"))
        .then(() => run.screenshots.push("failure.png"))
        .catch(() => {});
    }
  } finally {
    if (browserContext) {
      const tracePath = path.join(plan.outputDir, "trace.zip");
      try {
        await browserContext.tracing.stop({ path: tracePath });
        if (await traceContainsSecret(tracePath, plan.authToken)) {
          throw new Error("Playwright trace retained the review credential");
        }
        run.trace = "trace.zip";
      } catch (error) {
        await unlink(tracePath).catch(() => {});
        run.failure ??= redactSecrets(
          error instanceof Error ? error.message : error,
        );
      }
    }
    await browser?.close().catch(() => {});
  }

  return run;
}

async function writeReviewEvidence(plan, run) {
  const result = {
    schemaVersion: plan.schemaVersion,
    status: run.failure ? "failed" : "passed",
    startedAt: run.startedAt,
    completedAt: new Date().toISOString(),
    targetOrigin: plan.baseUrl.origin,
    expectedVersionTag: plan.expectedVersionTag,
    candidate: run.candidate,
    contextSha256: plan.contextSha256,
    diffSha256: plan.diffSha256,
    selectedSurfaces: plan.surfaces,
    assertions: run.assertions,
    diagnostics: run.diagnostics,
    screenshots: run.screenshots,
    trace: run.trace,
    failure: run.failure,
    proofBoundary: run.failure
      ? "No product proof was established because the browser review did not complete. Use the failure diagnostics and any captured evidence to distinguish a harness problem from an application problem."
      : "This proves the tagged Worker candidate rendered its Create and Library shells and completed read-only API smoke checks in one Cloudflare Browser Run session. It does not yet prove upload, encoding, media playback, YouTube reliability, production, or broad exploratory correctness.",
  };
  await writeFile(path.join(plan.outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  const lines = [
    `## Carpo PR browser review: ${result.status === "passed" ? "PASS" : "FAIL"}`,
    "",
    `Target: \`${result.targetOrigin}\``,
    `Expected Worker tag: \`${result.expectedVersionTag}\``,
    `Observed Worker version: \`${result.candidate?.id ?? "unavailable"}\``,
    `Context digest: \`${result.contextSha256}\``,
    `Diff digest: \`${result.diffSha256}\``,
    "",
    "Selected surfaces:",
    ...result.selectedSurfaces.map((surface) => `- \`${surface.id}\`: ${surface.reason}`),
    "",
    ...result.assertions.map((assertion) => `- ${assertion.status === "passed" ? "✅" : "❌"} ${assertion.label}`),
  ];
  if (run.failure) lines.push("", `Failure: ${run.failure}`);
  lines.push(
    "",
    `Evidence: ${[...run.screenshots, run.trace, "result.json", "test-plan.json"].filter(Boolean).join(", ")}`,
    "",
    result.proofBoundary,
    "",
  );
  const summary = lines.join("\n");
  await writeFile(path.join(plan.outputDir, "summary.md"), summary);
  process.stdout.write(summary);

  if (run.failure) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = await prepareReviewOutput(
    typeof args.output === "string" ? args.output : undefined,
  );
  const plan = await createReviewPlan(args, outputDir);
  await writeFile(
    path.join(plan.outputDir, "test-plan.json"),
    `${JSON.stringify(
      {
        schemaVersion: plan.schemaVersion,
        targetOrigin: plan.baseUrl.origin,
        expectedVersionTag: plan.expectedVersionTag,
        contextSha256: plan.contextSha256,
        diffSha256: plan.diffSha256,
        changedPaths: plan.changedPaths,
        surfaces: plan.surfaces,
      },
      null,
      2,
    )}\n`,
  );
  await writeReviewEvidence(plan, await runBrowserReview(plan));
}

main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
