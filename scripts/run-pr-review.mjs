import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  agenticFailureDiagnosticLines,
  inlineMarkdownText,
  prepareReviewOutput,
  redactSecrets,
} from "./pr-browser-review-utils.mjs";
import { createCloudflareReviewLease } from "./pr-review-lease.mjs";
import { selectProofChallenge } from "./pr-review-proof-challenges.mjs";
import { agenticExecution } from "./pr-review-agentic-execution.mjs";
import {
  installWebMcpReviewFixture,
  WEBMCP_REVIEW_FIXTURE,
} from "./pr-review-webmcp-fixture.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_REPOSITORY = "dayhaysoos/carpo";
const REVIEW_URL = "https://carpo-pr-review.ndejesus1227.workers.dev";
const EVIDENCE_BUCKET = "carpo-pr-review-evidence";
const EXECUTION_ID_PATTERN =
  /^(?:actions-[1-9][0-9]{0,19}-[1-9][0-9]{0,2}|manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/;
const COMPARISON_SURFACES = [
  { file: "create.png", id: "create", label: "Create" },
  { file: "library.png", id: "library", label: "Library" },
  { file: "archived.png", id: "archived", label: "Archived" },
];
const MAX_LEASE_WAIT_MS = 15 * 60 * 1_000;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

export function createManualExecutionId(now = new Date(), random = randomBytes(4)) {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `manual-${timestamp}-${Buffer.from(random).toString("hex")}`;
}

export function resolveExecutionMetadata(args, env = process.env) {
  const actionRunId = env.GITHUB_RUN_ID;
  const actionRunAttempt = env.GITHUB_RUN_ATTEMPT;
  const defaultExecutionId =
    env.GITHUB_ACTIONS === "true" && actionRunId && actionRunAttempt
      ? `actions-${actionRunId}-${actionRunAttempt}`
      : createManualExecutionId();
  const executionId = requireMatch(
    args["execution-id"] ?? defaultExecutionId,
    EXECUTION_ID_PATTERN,
    "execution ID",
  );
  const sourceUrl = new URL(
    args["source-url"] ??
      (executionId.startsWith("actions-")
        ? `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${actionRunId}`
        : `https://github.com/${EXPECTED_REPOSITORY}/pull/${args.pr}`),
  );
  if (
    sourceUrl.origin !== "https://github.com" ||
    !sourceUrl.pathname.startsWith(`/${EXPECTED_REPOSITORY}/`) ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    throw new Error("execution source URL must be an exact URL in the Carpo repository");
  }
  return { executionId, sourceUrl: sourceUrl.href };
}

export function resolveLeaseWaitMs(value) {
  if (value === undefined) return 0;
  const text = String(value);
  if (!/^[0-9]{1,7}$/.test(text)) {
    throw new Error("lease wait must be milliseconds as a non-negative integer");
  }
  const waitMs = Number(text);
  if (waitMs > MAX_LEASE_WAIT_MS) {
    throw new Error(`lease wait cannot exceed ${MAX_LEASE_WAIT_MS} milliseconds`);
  }
  return waitMs;
}

export function shouldCaptureVisualComparison(files) {
  return files.some((file) => {
    const filePath = typeof file === "string" ? file : file?.path;
    return typeof filePath === "string" && filePath.startsWith("web/");
  });
}

function printStep(label) {
  process.stdout.write(`\n==> ${label}\n`);
}

async function capture(file, args, options = {}) {
  const encoding = Object.prototype.hasOwnProperty.call(options, "encoding")
    ? options.encoding
    : "utf8";
  const { stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  return stdout;
}

async function run(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${file} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

async function runWithInput(file, args, input, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${file} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

async function githubJson(args, cwd) {
  return JSON.parse(await capture("gh", args, { cwd }));
}

async function getPullRequest(repository, pr, cwd) {
  return githubJson(["api", `repos/${repository}/pulls/${pr}`], cwd);
}

function assertPullRequest(pr, repository, expected) {
  if (pr.state !== "open" || pr.draft) {
    throw new Error("PR review only runs for an open, non-draft pull request");
  }
  if (pr.head?.repo?.full_name !== repository) {
    throw new Error("PR review only runs for branches inside this repository");
  }
  if (pr.user?.login !== repository.split("/")[0]) {
    throw new Error("PR review only runs for owner-authored pull requests");
  }
  if (expected.baseSha && pr.base?.sha !== expected.baseSha) {
    throw new Error(`PR base moved from ${expected.baseSha} to ${pr.base?.sha ?? "unknown"}`);
  }
  if (expected.headSha && pr.head?.sha !== expected.headSha) {
    throw new Error(`PR head moved from ${expected.headSha} to ${pr.head?.sha ?? "unknown"}`);
  }
  return { baseSha: pr.base.sha, headSha: pr.head.sha };
}

async function freezeContext({ repository, pr, baseSha, headSha, cwd, outputDir }) {
  printStep("Freeze exact PR, issue, and diff context");
  await capture("git", ["cat-file", "-e", `${baseSha}^{commit}`], { cwd });
  await capture("git", ["cat-file", "-e", `${headSha}^{commit}`], { cwd });
  const currentHead = (await capture("git", ["rev-parse", "HEAD"], { cwd })).trim();
  if (currentHead !== headSha) {
    throw new Error(`Candidate checkout is ${currentHead}, expected ${headSha}`);
  }

  const prContext = await githubJson(
    [
      "pr",
      "view",
      pr,
      "--repo",
      repository,
      "--json",
      "number,title,body,url,baseRefOid,headRefOid,closingIssuesReferences,comments,commits",
    ],
    cwd,
  );
  if (prContext.baseRefOid !== baseSha || prContext.headRefOid !== headSha) {
    throw new Error("Frozen PR context does not match the expected base and head");
  }

  const [owner, name] = repository.split("/");
  const issueContext = await githubJson(
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${pr}`,
      "-f",
      `query=query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 20) {
              nodes {
                number title body url updatedAt
                comments(first: 50) { nodes { author { login } body updatedAt url } }
              }
            }
          }
        }
      }`,
    ],
    cwd,
  );

  const diffBaseSha = (
    await capture("git", ["merge-base", baseSha, headSha], { cwd })
  ).trim();
  await capture("git", ["cat-file", "-e", `${diffBaseSha}^{commit}`], { cwd });
  const diff = await capture(
    "git",
    ["diff", "--no-ext-diff", "--binary", `${baseSha}...${headSha}`, "--"],
    { cwd, encoding: null },
  );
  await writeFile(path.join(outputDir, "diff.patch"), diff);

  const changedFilesBuffer = await capture(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${baseSha}...${headSha}`,
      "--",
    ],
    { cwd, encoding: null },
  );
  const files = changedFilesBuffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((filePath) => ({ path: filePath }));

  const context = {
    ...prContext,
    eventBaseRefOid: baseSha,
    eventHeadRefOid: headSha,
    diffBaseRefOid: diffBaseSha,
    files,
    linkedIssueContext:
      issueContext?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [],
  };
  await writeFile(
    path.join(outputDir, "pr-context.json"),
    `${JSON.stringify(prContext, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "issue-context.json"),
    `${JSON.stringify(issueContext, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "changed-files.json"),
    `${JSON.stringify(files, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "context.json"),
    `${JSON.stringify(context, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "base-wrangler.jsonc"),
    await capture("git", ["show", `${baseSha}:wrangler.jsonc`], { cwd }),
  );
  return { files };
}

async function writeFailureEvidence(outputDir, error) {
  let failure = redactSecrets(error instanceof Error ? error.message : error);
  const resultPath = path.join(outputDir, "result.json");
  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (readError) {
    if (readError?.code !== "ENOENT") throw readError;
    result = {
      schemaVersion: "carpo.pr-browser-review.v0",
      assertions: [],
      diagnostics: {},
    };
  }
  if (result.status === "failed" && typeof result.failure === "string") {
    failure = redactSecrets(result.failure);
  }
  result.status = "failed";
  result.completedAt = new Date().toISOString();
  result.failure = failure;
  result.proofBoundary =
    "No product proof was established because the exact-candidate review did not complete.";
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(
    path.join(outputDir, "summary.md"),
    `## Carpo PR browser review: FAIL\n\nFailure: ${failure}\n\n${result.proofBoundary}\n`,
  );
}

async function verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd) {
  assertPullRequest(await getPullRequest(repository, pr, cwd), repository, {
    baseSha,
    headSha,
  });
}

async function baseSupportsVisualComparison(repoRoot, baseSha) {
  const requiredFiles = [
    "package.json",
    "package-lock.json",
    "wrangler.jsonc",
    "scripts/pr-browser-review.mjs",
    "scripts/run-cloudflare-browser-review.mjs",
    "scripts/validate-pr-review-config.mjs",
  ];
  try {
    for (const file of requiredFiles) {
      await capture("git", ["cat-file", "-e", `${baseSha}:${file}`], {
        cwd: repoRoot,
      });
    }
    const packageJson = JSON.parse(
      await capture("git", ["show", `${baseSha}:package.json`], {
        cwd: repoRoot,
      }),
    );
    return typeof packageJson?.scripts?.["test:pr-browser"] === "string";
  } catch {
    return false;
  }
}

async function createDetachedCheckout(repoRoot, sha, label) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), `carpo-pr-review-${label}-`),
  );
  const checkout = path.join(temporaryRoot, label);
  await run("git", ["worktree", "add", "--detach", checkout, sha], {
    cwd: repoRoot,
  });
  return {
    checkout,
    async cleanup() {
      await run("git", ["worktree", "remove", "--force", checkout], {
        cwd: repoRoot,
      }).catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function runBrowserEvidence({
  reviewUrl,
  expectedVersionTag,
  contextPath,
  diffPath,
  outputDir,
  cwd,
  runtimeEnv,
}) {
  await run(
    "npm",
    [
      "run",
      "test:pr-browser",
      "--",
      "--url",
      reviewUrl,
      "--expected-version-tag",
      expectedVersionTag,
      "--context",
      contextPath,
      "--diff",
      diffPath,
      "--output",
      outputDir,
    ],
    { cwd, env: runtimeEnv },
  );
}

export async function attachAgenticReview({ outputDir, agenticReview }) {
  const resultPath = path.join(outputDir, "result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  result.agenticReview = agenticReview;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  const summaryPath = path.join(outputDir, "summary.md");
  const summary = await readFile(summaryPath, "utf8");
  const findings = Array.isArray(agenticReview.findings)
    ? agenticReview.findings.map(
        (finding) =>
          `- ${finding.severity === "error" ? "❌" : finding.severity === "warning" ? "⚠️" : "ℹ️"} ${inlineMarkdownText(finding.title)} · ${inlineMarkdownText(finding.category ?? "uncategorized")} · \`${inlineMarkdownText(finding.path ?? "unknown path")}\`: ${inlineMarkdownText(finding.evidence)}`,
      )
    : [];
  const providerDiagnosticLines = agenticFailureDiagnosticLines(
    agenticReview.providerDiagnostics,
  );
  const agenticSummary = [
    "",
    "### Flue exploratory review (advisory)",
    "",
    `Status: \`${agenticReview.status}\``,
    `Verdict: \`${agenticReview.verdict}\``,
    inlineMarkdownText(agenticReview.summary),
    ...(typeof agenticReview.reportUrl === "string"
      ? [`Private durable report: ${inlineMarkdownText(agenticReview.reportUrl)}`]
      : []),
    ...findings,
    ...(agenticReview.failure
      ? [`Failure: ${inlineMarkdownText(agenticReview.failure)}`]
      : []),
    ...(providerDiagnosticLines.length > 0
      ? ["", "#### Failure diagnostics", "", ...providerDiagnosticLines]
      : []),
    "",
    inlineMarkdownText(agenticReview.proofBoundary),
    "",
  ].join("\n");
  await writeFile(summaryPath, `${summary.trimEnd()}\n${agenticSummary}`);
  return agenticReview;
}

export async function assembleVisualComparison({
  outputDir,
  beforeDir,
  afterDir,
  baseSha,
  headSha,
  baselineStatus,
  baselineReason,
}) {
  const afterResult = JSON.parse(
    await readFile(path.join(afterDir, "result.json"), "utf8"),
  );
  const beforeResult =
    baselineStatus === "captured"
      ? JSON.parse(await readFile(path.join(beforeDir, "result.json"), "utf8"))
      : undefined;
  const comparisons = [];
  const screenshots = [];

  for (const surface of COMPARISON_SURFACES) {
    if (!afterResult.screenshots?.includes(surface.file)) continue;
    const afterFile = `after-${surface.file}`;
    await cp(path.join(afterDir, surface.file), path.join(outputDir, afterFile));
    screenshots.push(afterFile);

    if (
      beforeResult?.status === "passed" &&
      beforeResult.screenshots?.includes(surface.file)
    ) {
      const beforeFile = `before-${surface.file}`;
      await cp(path.join(beforeDir, surface.file), path.join(outputDir, beforeFile));
      screenshots.push(beforeFile);
      comparisons.push({
        id: surface.id,
        label: surface.label,
        before: beforeFile,
        after: afterFile,
      });
    }
  }

  for (const artifact of ["failure.png", "trace.zip", "test-plan.json"]) {
    await cp(path.join(afterDir, artifact), path.join(outputDir, artifact)).catch(
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      },
    );
  }

  const visualEvidence = {
    requested: true,
    status: comparisons.length > 0 ? "paired" : "after-only",
    baseSha,
    headSha,
    baselineStatus,
    reason:
      comparisons.length > 0
        ? "UI-relevant paths selected exact base/head comparison evidence."
        : baselineReason,
    comparisons,
  };
  const result = {
    ...afterResult,
    screenshots,
    visualEvidence,
    proofBoundary:
      comparisons.length > 0
        ? `${afterResult.proofBoundary} The paired screenshots compare exact base ${baseSha.slice(0, 7)} with exact head ${headSha.slice(0, 7)} using the same review steps and viewport; they are advisory visual evidence, not a pixel-perfect regression gate.`
        : afterResult.proofBoundary,
  };
  await writeFile(
    path.join(outputDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );

  const afterSummary = await readFile(path.join(afterDir, "summary.md"), "utf8");
  const visualSummary = [
    "",
    "### Visual evidence",
    "",
    `Base: \`${baseSha}\``,
    `Head: \`${headSha}\``,
    comparisons.length > 0
      ? `Paired surfaces: ${comparisons.map((comparison) => comparison.label).join(", ")}`
      : `After-only: ${baselineReason}`,
    "",
  ].join("\n");
  await writeFile(
    path.join(outputDir, "summary.md"),
    `${afterSummary.trimEnd()}\n${visualSummary}`,
  );
}

async function executeReview({
  repository,
  pr,
  baseSha,
  headSha,
  reviewUrl,
  cwd,
  outputDir,
  repoRoot,
  runtimeEnv,
  executionId,
  sourceUrl,
  agenticArgs,
  reviewAuthOrigin,
  lease,
}) {
  const frozen = await freezeContext({
    repository,
    pr,
    baseSha,
    headSha,
    cwd,
    outputDir,
  });
  if (
    frozen.files.some(
      (file) => file.path === "migrations" || file.path.startsWith("migrations/"),
    )
  ) {
    throw new Error(
      "V0 refuses migration-changing PRs against its persistent shared D1 database",
    );
  }
  const proofChallenge = selectProofChallenge(frozen.files);
  const agenticPlan = agenticExecution.prepare({
    args: agenticArgs,
    env: runtimeEnv,
    reviewAuthOrigin,
    request: {
      executionId,
      sourceUrl,
      repository,
      baseSha,
      headSha,
      reviewUrl,
      expectedVersionTag: headSha,
      contextPath: path.join(outputDir, "context.json"),
      diffPath: path.join(outputDir, "diff.patch"),
      outputDir,
      cwd,
      proofChallenge: proofChallenge?.id,
      webMcpFixtureVideoId: WEBMCP_REVIEW_FIXTURE.videoId,
    },
  });

  printStep("Install and validate the exact candidate");
  await run("npm", ["ci"], { cwd });
  await run(
    "npm",
    [
      "run",
      "validate:pr-review-config",
      "--",
      "wrangler.jsonc",
      path.join(outputDir, "base-wrangler.jsonc"),
    ],
    { cwd, env: runtimeEnv },
  );
  const protectedStatus = await capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "wrangler.jsonc", "migrations"],
    { cwd, env: runtimeEnv },
  );
  if (protectedStatus.trim()) {
    throw new Error("Review configuration or migrations changed during validation");
  }
  await run("npm", ["test"], { cwd });
  await run("npm", ["run", "build"], { cwd });

  const comparisonRequested = shouldCaptureVisualComparison(frozen.files);
  const comparisonSupported =
    comparisonRequested &&
    (await baseSupportsVisualComparison(repoRoot, baseSha));
  const beforeDir = path.join(outputDir, "before");
  const afterDir = path.join(outputDir, "after");
  let baselineStatus = comparisonRequested ? "unavailable" : "not-requested";
  let baselineReason = comparisonRequested
    ? "The frozen base does not yet contain the review harness required for an exact comparison."
    : "The exact changed-path map contains no user-interface files.";

  if (comparisonSupported) {
    printStep("Capture exact-base visual evidence");
    const baseline = await createDetachedCheckout(repoRoot, baseSha, "baseline");
    try {
      await run("npm", ["ci"], { cwd: baseline.checkout });
      await run("npm", ["run", "build"], { cwd: baseline.checkout });
      await run(
        "npm",
        [
          "run",
          "validate:pr-review-config",
          "--",
          "wrangler.jsonc",
          "wrangler.jsonc",
        ],
        { cwd: baseline.checkout, env: runtimeEnv },
      );
      await lease.renew();
      await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);
      await run(
        "npx",
        ["wrangler", "deploy", "--env", "pr-review", "--tag", baseSha],
        { cwd: baseline.checkout, env: runtimeEnv },
      );
      await runBrowserEvidence({
        reviewUrl,
        expectedVersionTag: baseSha,
        contextPath: path.join(outputDir, "context.json"),
        diffPath: path.join(outputDir, "diff.patch"),
        outputDir: beforeDir,
        cwd,
        runtimeEnv,
      });
      baselineStatus = "captured";
      baselineReason = undefined;
    } catch (error) {
      baselineStatus = "failed";
      baselineReason = redactSecrets(
        error instanceof Error ? error.message : error,
      );
      process.stderr.write(
        `Exact-base visual capture was unavailable: ${baselineReason}\n`,
      );
    } finally {
      await baseline.cleanup();
    }
  }

  printStep("Deploy the exact candidate to the serialized Cloudflare review environment");
  await lease.renew();
  await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);
  await run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--env", "pr-review", "--remote"], { cwd });
  await run("npx", ["wrangler", "deploy", "--env", "pr-review", "--tag", headSha], {
    cwd,
  });

  printStep("Run Cloudflare Browser Run and capture exact-head evidence");
  const headOutputDir = comparisonRequested ? afterDir : outputDir;
  let headReviewError;
  try {
    await runBrowserEvidence({
      reviewUrl,
      expectedVersionTag: headSha,
      contextPath: path.join(outputDir, "context.json"),
      diffPath: path.join(outputDir, "diff.patch"),
      outputDir: headOutputDir,
      cwd,
      runtimeEnv,
    });
  } catch (error) {
    headReviewError = error;
  }

  if (comparisonRequested) {
    try {
      await assembleVisualComparison({
        outputDir,
        beforeDir,
        afterDir,
        baseSha,
        headSha,
        baselineStatus,
        baselineReason,
      });
    } catch (error) {
      if (headReviewError) throw headReviewError;
      throw error;
    }
  }
  if (headReviewError) throw headReviewError;
  await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);

  if (agenticPlan.status === "ready") {
    printStep("Install the disposable live WebMCP review fixture");
    const webMcpFixture = await installWebMcpReviewFixture({
      cwd,
      env: runtimeEnv,
      outputDir,
      runCommand: run,
    });
    let agenticError;
    try {
      printStep("Run bounded Flue and live WebMCP exploration");
      const agenticReview = await agenticExecution.execute(agenticPlan);
      await attachAgenticReview({ outputDir, agenticReview });
      await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);
    } catch (error) {
      agenticError = error;
    } finally {
      try {
        await webMcpFixture.cleanup();
      } catch (cleanupError) {
        agenticError = agenticError
          ? new Error(
              `${redactSecrets(agenticError instanceof Error ? agenticError.message : agenticError)}\n${redactSecrets(cleanupError instanceof Error ? cleanupError.message : cleanupError)}`,
            )
          : cleanupError;
      }
    }
    if (agenticError) throw agenticError;
  }
}

async function publishEvidence({
  repository,
  pr,
  headSha,
  executionId,
  sourceUrl,
  outputDir,
  cwd,
  succeeded,
  reviewUrl,
  runtimeEnv,
}) {
  printStep("Upload R2 evidence and update the PR comment");
  const ghToken =
    runtimeEnv.GH_TOKEN ||
    (await capture("gh", ["auth", "token"], { cwd, env: runtimeEnv })).trim();
  const publisherArgs = [
    "scripts/publish-pr-review-evidence.mjs",
    "--repository",
    repository,
    "--pr",
    pr,
    "--sha",
    headSha,
    "--execution-id",
    executionId,
    "--source-url",
    sourceUrl,
    "--workflow-status",
    succeeded ? "success" : "failure",
    "--review-url",
    reviewUrl,
    "--bucket",
    EVIDENCE_BUCKET,
    "--output",
    outputDir,
  ];
  if (runtimeEnv.GITHUB_ACTIONS === "true") {
    publisherArgs.push("--comment-author", "github-actions[bot]");
  }
  await run(
    process.execPath,
    publisherArgs,
    { cwd, env: { ...runtimeEnv, GH_TOKEN: ghToken } },
  );
}

async function provisionManualReviewToken(repository, cwd, runtimeEnv) {
  printStep("Rotate the isolated manual-review credential");
  const token = randomBytes(32).toString("hex");
  await runWithInput(
    "npx",
    ["wrangler", "secret", "put", "PR_REVIEW_AUTH_TOKEN", "--env", "pr-review"],
    token,
    { cwd, env: runtimeEnv },
  );
  try {
    await runWithInput(
      "gh",
      ["secret", "set", "CARPO_PR_REVIEW_AUTH_TOKEN", "--repo", repository],
      token,
      { cwd, env: runtimeEnv },
    );
  } catch {
    process.stderr.write(
      "GitHub Actions secret synchronization was unavailable; continuing with the local/manual trigger.\n",
    );
  }
  return token;
}

async function createCandidateCheckout({ repository, pr, headSha, baseRef, repoRoot }) {
  printStep("Create isolated exact-SHA worktree");
  await run("git", ["fetch", "--no-tags", "origin", baseRef, `pull/${pr}/head`], {
    cwd: repoRoot,
  });
  await capture("git", ["cat-file", "-e", `${headSha}^{commit}`], { cwd: repoRoot });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "carpo-pr-review-"));
  const checkout = path.join(temporaryRoot, "candidate");
  await run("git", ["worktree", "add", "--detach", checkout, headSha], {
    cwd: repoRoot,
  });
  return {
    checkout,
    async cleanup() {
      await run("git", ["worktree", "remove", "--force", checkout], {
        cwd: repoRoot,
      }).catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

export async function runPullRequestReview(args, env = process.env) {
  const repository = args.repository ?? EXPECTED_REPOSITORY;
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`repository must be ${EXPECTED_REPOSITORY}`);
  }
  const pr = requireMatch(String(args.pr ?? ""), /^[1-9][0-9]{0,9}$/, "PR number");
  const reviewUrl = args["review-url"] ?? REVIEW_URL;
  if (reviewUrl !== REVIEW_URL) {
    throw new Error(`review URL must be exactly ${REVIEW_URL}`);
  }
  const metadata = resolveExecutionMetadata(args, env);
  const leaseWaitMs = resolveLeaseWaitMs(args["lease-wait-ms"]);
  const repoRoot = (
    await capture("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
  ).trim();
  const currentCheckout = args["current-checkout"] === true;
  const runtimeEnv = { ...process.env, ...env };
  const reviewAuthOrigin = runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN
    ? "provided"
    : "ephemeral";
  if (!runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN) {
    if (currentCheckout || runtimeEnv.GITHUB_ACTIONS === "true") {
      throw new Error("CARPO_PR_REVIEW_AUTH_TOKEN is required for unattended review");
    }
  }
  agenticExecution.validateConfiguration({
    args,
    env: runtimeEnv,
    reviewAuthOrigin,
  });
  const initialPr = await getPullRequest(repository, pr, repoRoot);
  const { baseSha, headSha } = assertPullRequest(initialPr, repository, {
    baseSha: args["expected-base-sha"],
    headSha: args["expected-head-sha"],
  });

  const lease = createCloudflareReviewLease({
    owner: metadata.executionId,
    sourceUrl: metadata.sourceUrl,
    cwd: repoRoot,
    env: runtimeEnv,
  });
  printStep("Acquire the shared Cloudflare review lease");
  await lease.acquire({ waitMs: leaseWaitMs });

  let operationError;
  let completedResult;
  try {
    if (!runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN) {
      runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN = await provisionManualReviewToken(
        repository,
        repoRoot,
        runtimeEnv,
      );
    }

    const candidate = currentCheckout
      ? { checkout: repoRoot, cleanup: async () => {} }
      : await createCandidateCheckout({
          repository,
          pr,
          headSha,
          baseRef: initialPr.base.ref,
          repoRoot,
        });
    let candidateError;
    try {
      const outputDir = await prepareReviewOutput(
        args.output ??
          path.join(
            repoRoot,
            "test-output",
            "pr-review",
            currentCheckout ? "" : metadata.executionId,
          ),
      );

      let reviewError;
      try {
        await executeReview({
          repository,
          pr,
          baseSha,
          headSha,
          reviewUrl,
          cwd: candidate.checkout,
          outputDir,
          repoRoot,
          runtimeEnv,
          executionId: metadata.executionId,
          sourceUrl: metadata.sourceUrl,
          agenticArgs: args,
          reviewAuthOrigin,
          lease,
        });
      } catch (error) {
        reviewError = error;
        try {
          await writeFailureEvidence(outputDir, error);
        } catch (evidenceError) {
          reviewError = new Error(
            `${redactSecrets(error instanceof Error ? error.message : error)}\n${redactSecrets(evidenceError instanceof Error ? evidenceError.message : evidenceError)}`,
          );
        }
      }

      let publishError;
      try {
        await lease.renew();
        await publishEvidence({
          repository,
          pr,
          headSha,
          ...metadata,
          outputDir,
          cwd: candidate.checkout,
          succeeded: !reviewError,
          reviewUrl,
          runtimeEnv,
        });
      } catch (error) {
        publishError = error;
      }

      if (reviewError || publishError) {
        const messages = [reviewError, publishError]
          .filter(Boolean)
          .map((error) =>
            redactSecrets(error instanceof Error ? error.message : error),
          );
        throw new Error(messages.join("\n"));
      }
      completedResult = {
        repository,
        pr,
        baseSha,
        headSha,
        outputDir,
        ...metadata,
      };
    } catch (error) {
      candidateError = error;
    } finally {
      try {
        await candidate.cleanup();
      } catch (error) {
        const cleanupMessage = redactSecrets(
          error instanceof Error ? error.message : error,
        );
        candidateError = candidateError
          ? new Error(
              `${redactSecrets(candidateError instanceof Error ? candidateError.message : candidateError)}\n${cleanupMessage}`,
            )
          : new Error(cleanupMessage);
      }
    }
    if (candidateError) throw candidateError;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await lease.release();
    } catch (error) {
      const releaseMessage = redactSecrets(
        error instanceof Error ? error.message : error,
      );
      operationError = operationError
        ? new Error(
            `${redactSecrets(operationError instanceof Error ? operationError.message : operationError)}\n${releaseMessage}`,
          )
        : new Error(releaseMessage);
    }
  }

  if (operationError) throw operationError;
  return completedResult;
}

async function main() {
  const result = await runPullRequestReview(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `\nPR review completed for ${result.headSha}. Evidence: ${result.outputDir}\n`,
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error) => {
    process.stderr.write(
      `${redactSecrets(error instanceof Error ? error.stack ?? error.message : error)}\n`,
    );
    process.exitCode = 1;
  });
}
