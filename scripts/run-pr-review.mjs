import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareReviewOutput, redactSecrets } from "./pr-browser-review-utils.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_REPOSITORY = "dayhaysoos/carpo";
const REVIEW_URL = "https://carpo-pr-review.ndejesus1227.workers.dev";
const EVIDENCE_BUCKET = "carpo-pr-review-evidence";
const EXECUTION_ID_PATTERN =
  /^(?:actions-[1-9][0-9]{0,19}-[1-9][0-9]{0,2}|manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/;

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

async function executeReview({
  repository,
  pr,
  baseSha,
  headSha,
  reviewUrl,
  cwd,
  outputDir,
  runtimeEnv,
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

  printStep("Deploy the exact candidate to the serialized Cloudflare review environment");
  await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);
  await run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--env", "pr-review", "--remote"], { cwd });
  await run("npx", ["wrangler", "deploy", "--env", "pr-review", "--tag", headSha], {
    cwd,
  });

  printStep("Run Cloudflare Browser Run and capture evidence");
  await run(
    "npm",
    [
      "run",
      "test:pr-browser",
      "--",
      "--url",
      reviewUrl,
      "--expected-version-tag",
      headSha,
      "--context",
      path.join(outputDir, "context.json"),
      "--diff",
      path.join(outputDir, "diff.patch"),
      "--output",
      outputDir,
    ],
    { cwd, env: runtimeEnv },
  );
  await verifyCandidateUnchanged(repository, pr, baseSha, headSha, cwd);
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
  await runWithInput(
    "gh",
    ["secret", "set", "CARPO_PR_REVIEW_AUTH_TOKEN", "--repo", repository],
    token,
    { cwd, env: runtimeEnv },
  );
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
  const repoRoot = (
    await capture("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
  ).trim();
  const currentCheckout = args["current-checkout"] === true;
  const runtimeEnv = { ...process.env, ...env };
  if (!runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN) {
    if (currentCheckout || runtimeEnv.GITHUB_ACTIONS === "true") {
      throw new Error("CARPO_PR_REVIEW_AUTH_TOKEN is required for unattended review");
    }
    runtimeEnv.CARPO_PR_REVIEW_AUTH_TOKEN = await provisionManualReviewToken(
      repository,
      repoRoot,
      runtimeEnv,
    );
  }
  const initialPr = await getPullRequest(repository, pr, repoRoot);
  const { baseSha, headSha } = assertPullRequest(initialPr, repository, {
    baseSha: args["expected-base-sha"],
    headSha: args["expected-head-sha"],
  });

  const candidate = currentCheckout
    ? { checkout: repoRoot, cleanup: async () => {} }
    : await createCandidateCheckout({
        repository,
        pr,
        headSha,
        baseRef: initialPr.base.ref,
        repoRoot,
      });
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
      runtimeEnv,
    });
  } catch (error) {
    reviewError = error;
    await writeFailureEvidence(outputDir, error);
  }

  let publishError;
  try {
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
  } finally {
    await candidate.cleanup();
  }

  if (reviewError || publishError) {
    const messages = [reviewError, publishError]
      .filter(Boolean)
      .map((error) => redactSecrets(error instanceof Error ? error.message : error));
    throw new Error(messages.join("\n"));
  }
  return { repository, pr, baseSha, headSha, outputDir, ...metadata };
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
