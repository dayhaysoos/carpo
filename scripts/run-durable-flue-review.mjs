import { createFlueClient } from "@flue/sdk";
import { AGENTIC_REVIEW_SCHEMA_VERSION } from "@carpo/review-contract";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareAgenticReviewOutput, redactSecrets } from "./pr-browser-review-utils.mjs";

export const DEFAULT_REVIEW_SERVICE_URL =
  "https://carpo-pr-review-agent.ndejesus1227.workers.dev";

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

export function resolveReviewServiceUrl(value = DEFAULT_REVIEW_SERVICE_URL) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("The durable review service must be an exact HTTPS origin");
  }
  return url.origin;
}

export function extractDurableReview(reply) {
  const reports = reply?.data?.reviewReport;
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("The durable Flue reviewer settled without a structured report");
  }
  const report = reports.at(-1);
  if (
    !report ||
    report.schemaVersion !== AGENTIC_REVIEW_SCHEMA_VERSION ||
    report.status !== "completed"
  ) {
    throw new Error("The durable Flue reviewer returned an invalid report");
  }
  return report;
}

async function downloadEvidence({ report, serviceUrl, token, outputDir }) {
  for (const screenshot of report.screenshots ?? []) {
    if (!/^agentic-[0-9]{2}\.png$/.test(screenshot.file)) {
      throw new Error("The durable reviewer returned an invalid screenshot name");
    }
    const url = new URL(screenshot.downloadUrl);
    if (url.origin !== serviceUrl) {
      throw new Error("The durable reviewer returned evidence from an untrusted origin");
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Could not download ${screenshot.file} (HTTP ${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path.join(outputDir, screenshot.file), bytes);
  }
}

export async function runDurableFlueReview(args, env = process.env) {
  const serviceUrl = resolveReviewServiceUrl(
    args["service-url"] ?? env.CARPO_REVIEW_SERVICE_URL,
  );
  const token = env.CARPO_REVIEW_SERVICE_TOKEN;
  if (!token) throw new Error("CARPO_REVIEW_SERVICE_TOKEN is required");
  const executionId = args["execution-id"];
  const repository = args.repository;
  const baseSha = args["base-sha"];
  const headSha = args["head-sha"];
  const sourceUrl = args["source-url"];
  const reviewOrigin = args.url;
  const expectedVersionTag = args["expected-version-tag"];
  if (
    !executionId ||
    !repository ||
    !/^[0-9a-f]{40}$/i.test(baseSha ?? "") ||
    !/^[0-9a-f]{40}$/i.test(headSha ?? "") ||
    !sourceUrl ||
    !reviewOrigin ||
    !expectedVersionTag ||
    !args.context ||
    !args.diff
  ) {
    throw new Error("The durable reviewer requires frozen execution, candidate, context, and diff inputs");
  }
  const outputDir = path.resolve(args.output ?? "test-output/pr-review");
  await mkdir(outputDir, { recursive: true });
  await prepareAgenticReviewOutput(outputDir);
  const [contextText, diffText] = await Promise.all([
    readFile(args.context, "utf8"),
    readFile(args.diff, "utf8"),
  ]);
  const initialData = {
    executionId,
    source: {
      provider: args["source-provider"] ?? "manual",
      sourceUrl,
    },
    candidate: {
      repository,
      baseSha,
      headSha,
      reviewOrigin,
      expectedVersionTag,
    },
    contextText,
    diffText,
    ...(args["proof-challenge"]
      ? { proofChallenge: args["proof-challenge"] }
      : {}),
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("The durable Flue review timed out")),
    16 * 60 * 1000,
  );
  try {
    const client = createFlueClient({
      url: `${serviceUrl}/agents/carpo-durable-reviewer/${encodeURIComponent(executionId)}`,
      token,
    });
    const admission = await client.send({
      uid: null,
      initialData,
      signal: controller.signal,
      message: {
        kind: "signal",
        type: "review_candidate",
        body: `Inspect exact Carpo candidate ${headSha}.`,
      },
    });
    process.stdout.write(
      `Durable Flue review admitted as ${admission.submissionId}; waiting for settlement…\n`,
    );
    const reply = await client.read(admission, {
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "tool-call-started") {
          process.stdout.write(`  tool: ${event.toolName}\n`);
        }
      },
    });
    const report = extractDurableReview(reply);
    await downloadEvidence({ report, serviceUrl, token, outputDir });
    await writeFile(
      path.join(outputDir, "agentic-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.stdout.write(
      `Durable Flue exploratory review: ${report.status.toUpperCase()} · ${report.verdict}\n${report.reportUrl}\n`,
    );
    return report;
  } finally {
    clearTimeout(timeout);
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  runDurableFlueReview(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${redactSecrets(error instanceof Error ? error.stack ?? error.message : error)}\n`,
    );
    process.exitCode = 1;
  });
}
