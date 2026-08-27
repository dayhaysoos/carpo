import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_REPOSITORY = "dayhaysoos/carpo";
const EXPECTED_REVIEW_ORIGIN =
  "https://carpo-pr-review.ndejesus1227.workers.dev";
const EXPECTED_BUCKET = "carpo-pr-review-evidence";
const COMMENT_MARKER = "<!-- carpo-pr-browser-review -->";
const EVIDENCE_RETENTION_DAYS = 14;
const EXECUTION_ID_PATTERN =
  /^(?:actions-[1-9][0-9]{0,19}-[1-9][0-9]{0,2}|manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/;
const SCREENSHOTS = [
  { file: "create.png", label: "Create" },
  { file: "library.png", label: "Library" },
  { file: "archived.png", label: "Archived" },
  { file: "failure.png", label: "Failure" },
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (key && value) args[key] = value;
  }
  return args;
}

function requireMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function validateInputs(args) {
  const repository = requireMatch(
    args.repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "repository",
  );
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`repository must be ${EXPECTED_REPOSITORY}`);
  }

  const reviewUrl = new URL(args["review-url"]);
  if (
    reviewUrl.origin !== EXPECTED_REVIEW_ORIGIN ||
    reviewUrl.pathname !== "/"
  ) {
    throw new Error(`review URL must be exactly ${EXPECTED_REVIEW_ORIGIN}`);
  }
  if (args.bucket !== EXPECTED_BUCKET) {
    throw new Error(`evidence bucket must be ${EXPECTED_BUCKET}`);
  }

  const sourceUrl = new URL(args["source-url"]);
  const sourcePathPattern = new RegExp(
    `^/${EXPECTED_REPOSITORY.replace("/", "\\/")}/(?:actions/runs/[1-9][0-9]{0,19}|commit/[0-9a-f]{40}|pull/[1-9][0-9]{0,9})$`,
  );
  if (
    sourceUrl.origin !== "https://github.com" ||
    !sourcePathPattern.test(sourceUrl.pathname) ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    throw new Error("source URL must identify this repository's PR, commit, or Actions run");
  }

  return {
    repository,
    pr: requireMatch(args.pr, /^[1-9][0-9]{0,9}$/, "pull request number"),
    sha: requireMatch(
      args.sha,
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
      "head SHA",
    ),
    executionId: requireMatch(
      args["execution-id"],
      EXECUTION_ID_PATTERN,
      "execution ID",
    ),
    sourceUrl: sourceUrl.href,
    outputDir: path.resolve(args.output),
    reviewOrigin: reviewUrl.origin,
    bucket: args.bucket,
    workflowStatus: args["workflow-status"] ?? "success",
    commentAuthor:
      args["comment-author"] === undefined
        ? undefined
        : requireMatch(
            args["comment-author"],
            /^github-actions\[bot\]$/,
            "comment author",
          ),
  };
}

export function buildEvidenceKey({ pr, sha, executionId }, file) {
  const allowed = SCREENSHOTS.some((screenshot) => screenshot.file === file);
  if (!allowed) throw new Error(`Unsupported evidence filename: ${file}`);
  return `pull-requests/${pr}/${sha}/executions/${executionId}/${file}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineText(value) {
  return escapeHtml(String(value).replace(/\s+/g, " ").trim()).replace(
    /([\\`*_\[\]()!])/g,
    "\\$1",
  );
}

function diagnosticCount(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return 0;
  return Object.values(diagnostics).reduce(
    (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
    0,
  );
}

function passedAssertionCount(assertions) {
  if (!Array.isArray(assertions)) return 0;
  return assertions.filter((assertion) => assertion?.status === "passed").length;
}

function renderScreenshots(evidence) {
  if (evidence.length === 0) {
    return "_No browser screenshot was produced. Open the Actions run for failure details._";
  }

  const heading = evidence
    .map((item) => `<th>${escapeHtml(item.label)}</th>`)
    .join("");
  const images = evidence
    .map(
      (item) =>
        `<td><a href="${escapeHtml(item.url)}"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.label)} browser review evidence" width="280"></a></td>`,
    )
    .join("");
  return `<table><tr>${heading}</tr><tr>${images}</tr></table>`;
}

export function renderReviewComment({
  repository,
  pr,
  sha,
  sourceUrl,
  result,
  evidence,
  workflowStatus,
}) {
  const passed = result?.status === "passed" && workflowStatus === "success";
  const statusLabel = passed ? "✅ PASS" : "❌ FAIL";
  const assertions = Array.isArray(result?.assertions) ? result.assertions : [];
  const passedAssertions = passedAssertionCount(assertions);
  const diagnostics = diagnosticCount(result?.diagnostics);
  const shortSha = sha.slice(0, 7);
  const commitUrl = `https://github.com/${repository}/commit/${sha}`;
  const sourceLabel = sourceUrl.includes("/actions/runs/")
    ? "Actions run"
    : "Execution source";
  const proofBoundary =
    result?.proofBoundary ??
    "No browser proof was established because the review did not reach the evidence phase.";

  const lines = [
    COMMENT_MARKER,
    `## Carpo PR browser review: ${statusLabel}`,
    "",
    `Reviewed commit [\`${escapeHtml(shortSha)}\`](${commitUrl}) for PR #${escapeHtml(pr)} · [${sourceLabel}](${escapeHtml(sourceUrl)})`,
    "",
    `**Assertions:** ${passedAssertions}/${assertions.length} passed · **Browser diagnostics:** ${diagnostics}`,
  ];

  if (result?.failure) {
    lines.push("", `**Failure:** ${inlineText(result.failure)}`);
  }

  lines.push(
    "",
    "### Browser evidence",
    "",
    renderScreenshots(evidence),
    "",
    `Screenshots are stored in the isolated Cloudflare R2 evidence bucket and expire after ${EVIDENCE_RETENTION_DAYS} days. The trace and machine-readable evidence remain in the execution output; the evidence manifest is also retained in R2.`,
    "",
    `> **Proof boundary:** ${inlineText(proofBoundary)}`,
    "",
  );
  return lines.join("\n");
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(fetchImpl, token, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${url} failed (${response.status}): ${detail.slice(0, 500)}`,
    );
  }
  return response;
}

export async function resolveCommentAuthor({
  authorLogin,
  token,
  fetchImpl = fetch,
}) {
  if (authorLogin) return authorLogin;

  const viewerResponse = await githubRequest(
    fetchImpl,
    token,
    "https://api.github.com/user",
  );
  const viewer = await viewerResponse.json();
  if (typeof viewer?.login !== "string" || !viewer.login) {
    throw new Error("GitHub API did not identify the reporting account");
  }
  return viewer.login;
}

function nextLink(linkHeader) {
  if (!linkHeader) return undefined;
  for (const entry of linkHeader.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

export async function upsertReviewComment({
  fetchImpl = fetch,
  token,
  repository,
  pr,
  body,
  authorLogin,
}) {
  let commentsUrl = `https://api.github.com/repos/${repository}/issues/${pr}/comments?per_page=100`;
  let existing;
  while (commentsUrl) {
    const response = await githubRequest(fetchImpl, token, commentsUrl);
    const comments = await response.json();
    if (!Array.isArray(comments)) {
      throw new Error("GitHub comments response was not an array");
    }
    for (const comment of comments) {
      if (
        comment?.user?.login === authorLogin &&
        typeof comment?.body === "string" &&
        comment.body.includes(COMMENT_MARKER)
      ) {
        existing = comment;
      }
    }
    commentsUrl = nextLink(response.headers.get("Link"));
  }

  if (existing) {
    const response = await githubRequest(
      fetchImpl,
      token,
      `https://api.github.com/repos/${repository}/issues/comments/${existing.id}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
    );
    return { action: "updated", comment: await response.json() };
  }

  const response = await githubRequest(
    fetchImpl,
    token,
    `https://api.github.com/repos/${repository}/issues/${pr}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  return { action: "created", comment: await response.json() };
}

async function readResult(outputDir) {
  try {
    return JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function uploadScreenshots(inputs, runCommand = execFileAsync) {
  const evidence = [];
  for (const screenshot of SCREENSHOTS) {
    const filePath = path.join(inputs.outputDir, screenshot.file);
    if (!(await fileExists(filePath))) continue;

    const key = buildEvidenceKey(inputs, screenshot.file);
    await runCommand(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `${inputs.bucket}/${key}`,
        "--file",
        filePath,
        "--content-type",
        "image/png",
        "--cache-control",
        "public, max-age=3600, immutable",
        "--remote",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );

    const url = `${inputs.reviewOrigin}/api/review/evidence/${key}`;
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok || response.headers.get("Content-Type") !== "image/png") {
      throw new Error(
        `Uploaded evidence was not publicly readable as image/png: ${url} (${response.status})`,
      );
    }
    evidence.push({ ...screenshot, key, url });
  }
  return evidence;
}

function buildManifestKey(inputs) {
  return `pull-requests/${inputs.pr}/${inputs.sha}/executions/${inputs.executionId}/evidence-manifest.json`;
}

async function uploadManifest(inputs, manifestPath, runCommand = execFileAsync) {
  const key = buildManifestKey(inputs);
  await runCommand(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${inputs.bucket}/${key}`,
      "--file",
      manifestPath,
      "--content-type",
      "application/json",
      "--cache-control",
      "private, no-store",
      "--remote",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return key;
}

async function main() {
  const inputs = validateInputs(parseArgs(process.argv.slice(2)));
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required to publish PR evidence");

  await mkdir(inputs.outputDir, { recursive: true });
  const result = await readResult(inputs.outputDir);
  const evidence = await uploadScreenshots(inputs);
  const manifest = {
    schemaVersion: "carpo.pr-browser-review-evidence.v0",
    executionId: inputs.executionId,
    sourceUrl: inputs.sourceUrl,
    uploadedAt: new Date().toISOString(),
    expiresAfterDays: EVIDENCE_RETENTION_DAYS,
    screenshots: evidence,
    r2Key: buildManifestKey(inputs),
  };
  const manifestPath = path.join(inputs.outputDir, "evidence-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await uploadManifest(inputs, manifestPath);

  const body = renderReviewComment({ ...inputs, result, evidence });
  const authorLogin = await resolveCommentAuthor({
    authorLogin: inputs.commentAuthor,
    token,
  });
  const published = await upsertReviewComment({
    token,
    repository: inputs.repository,
    pr: inputs.pr,
    body,
    authorLogin,
  });
  process.stdout.write(
    `PR browser review comment ${published.action}: ${published.comment.html_url ?? "URL unavailable"}\n`,
  );
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
