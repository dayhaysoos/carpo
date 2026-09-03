import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WEBMCP_REVIEW_FIXTURE = Object.freeze({
  videoId: "7e57a4c2-20a6-4d83-8f08-57b807338ead",
  sourceKey: "review-fixtures/webmcp/source.mp4",
  transcriptKey:
    "transcripts/7e57a4c2-20a6-4d83-8f08-57b807338ead.json",
  title: "Carpo WebMCP live review fixture",
  durationSeconds: 10,
});

const REVIEW_BUCKET = "carpo-clips-pr-review";
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 1_000;

async function retryCleanup(operation, wait) {
  let lastError;
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < CLEANUP_ATTEMPTS) {
        await wait(CLEANUP_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

export function webMcpReviewTranscript() {
  return {
    version: 1,
    fetchedAt: "2026-08-28T00:00:00.000Z",
    language: "en",
    automatic: false,
    cues: [
      {
        startSeconds: 0,
        endSeconds: 2,
        text: "A strong opening gives the audience a concrete promise.",
      },
      {
        startSeconds: 2.5,
        endSeconds: 4.5,
        text: "The clearest moment explains why human review still matters.",
      },
      {
        startSeconds: 5,
        endSeconds: 7,
        text: "Good automation keeps every suggestion editable before anything is created.",
      },
      {
        startSeconds: 7.5,
        endSeconds: 9.5,
        text: "The closing idea is to make evidence easy to inspect.",
      },
    ],
  };
}

function fixtureSql() {
  const fixture = WEBMCP_REVIEW_FIXTURE;
  return `
DELETE FROM clips WHERE video_id = '${fixture.videoId}';
DELETE FROM source_videos
WHERE id = '${fixture.videoId}'
   OR (source_type = 'upload' AND source_ref = '${fixture.sourceKey}');
INSERT INTO source_videos (
  id,
  source_type,
  source_ref,
  title,
  duration_seconds,
  transcript_status,
  transcript_checked_at,
  transcript_check_error,
  transcript_retry_at,
  created_at,
  updated_at
) VALUES (
  '${fixture.videoId}',
  'upload',
  '${fixture.sourceKey}',
  '${fixture.title}',
  ${fixture.durationSeconds},
  'available',
  datetime('now'),
  NULL,
  NULL,
  datetime('now'),
  datetime('now')
);`.trim();
}

function cleanupSql() {
  return `
DELETE FROM clips WHERE video_id = '${WEBMCP_REVIEW_FIXTURE.videoId}';
DELETE FROM source_videos WHERE id = '${WEBMCP_REVIEW_FIXTURE.videoId}';`.trim();
}

export async function cleanupWebMcpReviewFixture({
  cwd,
  env,
  runCommand,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (typeof runCommand !== "function") {
    throw new Error("A command runner is required to clean the WebMCP fixture");
  }
  const errors = [];
  await retryCleanup(
    () =>
      runCommand(
        "npx",
        [
          "wrangler",
          "d1",
          "execute",
          "DB",
          "--env",
          "pr-review",
          "--remote",
          "--command",
          cleanupSql(),
        ],
        { cwd, env },
      ),
    wait,
  ).catch((error) => errors.push(error));
  await retryCleanup(
    () =>
      runCommand(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "delete",
          `${REVIEW_BUCKET}/${WEBMCP_REVIEW_FIXTURE.transcriptKey}`,
          "--remote",
        ],
        { cwd, env },
      ),
    wait,
  ).catch((error) => errors.push(error));
  if (errors.length > 0) {
    throw new Error(
      `WebMCP review fixture cleanup failed: ${errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; ")}`,
    );
  }
}

export async function installWebMcpReviewFixture({
  cwd,
  env,
  outputDir,
  runCommand,
  writeFileImpl = writeFile,
  unlinkImpl = unlink,
}) {
  if (typeof runCommand !== "function") {
    throw new Error("A command runner is required to install the WebMCP fixture");
  }
  const transcriptPath = path.join(outputDir, "webmcp-live-transcript.json");
  await writeFileImpl(
    transcriptPath,
    `${JSON.stringify(webMcpReviewTranscript())}\n`,
  );
  let transcriptUploaded = false;
  try {
    await runCommand(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `${REVIEW_BUCKET}/${WEBMCP_REVIEW_FIXTURE.transcriptKey}`,
        "--remote",
        "--file",
        transcriptPath,
        "--content-type",
        "application/json",
      ],
      { cwd, env },
    );
    transcriptUploaded = true;
    await runCommand(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--env",
        "pr-review",
        "--remote",
        "--command",
        fixtureSql(),
      ],
      { cwd, env },
    );
  } catch (error) {
    if (transcriptUploaded) {
      await runCommand(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "delete",
          `${REVIEW_BUCKET}/${WEBMCP_REVIEW_FIXTURE.transcriptKey}`,
          "--remote",
        ],
        { cwd, env },
      ).catch(() => {});
    }
    throw error;
  } finally {
    await unlinkImpl(transcriptPath).catch(() => {});
  }

  let cleaned = false;
  return Object.freeze({
    ...WEBMCP_REVIEW_FIXTURE,
    path: `/create?video=${WEBMCP_REVIEW_FIXTURE.videoId}`,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await cleanupWebMcpReviewFixture({ cwd, env, runCommand });
    },
  });
}

async function runFixtureCommand(file, args, options) {
  const child = await execFileAsync(file, args, {
    ...options,
    maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
}

async function main(argv) {
  const action = argv[0];
  const outputIndex = argv.indexOf("--output");
  const outputDir = path.resolve(
    outputIndex === -1
      ? "test-output/pr-review/webmcp-fixture"
      : argv[outputIndex + 1],
  );
  if (!new Set(["install", "cleanup"]).has(action)) {
    throw new Error(
      "Usage: pr-review-webmcp-fixture.mjs <install|cleanup> [--output <directory>]",
    );
  }
  if (action === "install") {
    await mkdir(outputDir, { recursive: true });
    await installWebMcpReviewFixture({
      cwd: process.cwd(),
      env: process.env,
      outputDir,
      runCommand: runFixtureCommand,
    });
    process.stdout.write(
      `Installed live WebMCP fixture ${WEBMCP_REVIEW_FIXTURE.videoId}\n`,
    );
    return;
  }
  await cleanupWebMcpReviewFixture({
    cwd: process.cwd(),
    env: process.env,
    runCommand: runFixtureCommand,
  });
  process.stdout.write(
    `Cleaned live WebMCP fixture ${WEBMCP_REVIEW_FIXTURE.videoId}\n`,
  );
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
