import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTIC_REVIEW_SCHEMA_VERSION,
  parseAgenticReviewResult,
} from "@carpo/review-contract";
import { resolveAgenticModel } from "./flue-pr-review-agent.mjs";
import { redactSecrets } from "./pr-browser-review-utils.mjs";
import { resolveReviewServiceUrl } from "./run-durable-flue-review.mjs";

const EVIDENCE_BUCKET = "carpo-pr-review-evidence";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("A frozen agentic review request is required");
  }
  requireString(request.executionId, "execution ID");
  requireString(request.sourceUrl, "execution source URL");
  requireString(request.repository, "candidate repository");
  requireString(request.reviewUrl, "candidate review URL");
  requireString(request.contextPath, "frozen context path");
  requireString(request.diffPath, "frozen diff path");
  requireString(request.outputDir, "review output directory");
  requireString(request.cwd, "candidate checkout");
  requireString(request.webMcpFixtureVideoId, "WebMCP fixture video ID");
  if (!SHA_PATTERN.test(request.baseSha ?? "")) {
    throw new Error("candidate base SHA has an invalid format");
  }
  if (!SHA_PATTERN.test(request.headSha ?? "")) {
    throw new Error("candidate head SHA has an invalid format");
  }
  if (request.expectedVersionTag !== request.headSha) {
    throw new Error("candidate version tag must equal the frozen head SHA");
  }
  return Object.freeze({ ...request });
}

function resolveEnabled(args, env) {
  if (args.agentic === true && args["no-agentic"] === true) {
    throw new Error("--agentic and --no-agentic cannot be used together");
  }
  if (args["no-agentic"] === true) return false;
  if (args.agentic === true) return true;
  if (env.CARPO_PR_REVIEW_AGENTIC === undefined) return true;
  if (env.CARPO_PR_REVIEW_AGENTIC === "true") return true;
  if (env.CARPO_PR_REVIEW_AGENTIC === "false") return false;
  throw new Error("CARPO_PR_REVIEW_AGENTIC must be true or false");
}

function resolveBackend(args, env) {
  const backend =
    args["agent-backend"] ?? env.CARPO_PR_REVIEW_AGENT_BACKEND ?? "local";
  if (!new Set(["local", "durable"]).has(backend)) {
    throw new Error("agent backend must be local or durable");
  }
  return backend;
}

function sensitiveValues(env) {
  return [
    env.CARPO_REVIEW_SERVICE_TOKEN,
    env.CARPO_PR_REVIEW_AUTH_TOKEN,
    env.CLOUDFLARE_API_KEY,
    env.CLOUDFLARE_API_TOKEN,
  ].filter(Boolean);
}

function validateResult(value) {
  try {
    return parseAgenticReviewResult(value);
  } catch {
    throw new Error("The agentic backend returned an invalid v1 review result");
  }
}

function inconclusiveResult(error, env) {
  return {
    schemaVersion: AGENTIC_REVIEW_SCHEMA_VERSION,
    status: "failed",
    advisory: true,
    verdict: "inconclusive",
    summary: "The Flue exploratory review did not complete.",
    testedAreas: [],
    findings: [],
    remainingRisks: [],
    screenshots: [],
    diagnostics: {},
    failure: redactSecrets(
      error instanceof Error
        ? error.message
        : error ?? "Agentic review did not produce a result",
      sensitiveValues(env),
    ),
    proofBoundary:
      "No agentic product proof was established because the bounded Flue review did not complete.",
  };
}

async function readResult(outputDir) {
  return validateResult(
    JSON.parse(await readFile(path.join(outputDir, "agentic-result.json"), "utf8")),
  );
}

async function runSubprocess(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${file} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    });
  });
}

function commonReviewArgs(request) {
  const args = [
    "--url",
    request.reviewUrl,
    "--expected-version-tag",
    request.expectedVersionTag,
    "--execution-id",
    request.executionId,
    "--context",
    request.contextPath,
    "--diff",
    request.diffPath,
    "--output",
    request.outputDir,
    "--webmcp-video-id",
    request.webMcpFixtureVideoId,
  ];
  if (request.proofChallenge) {
    args.push("--proof-challenge", request.proofChallenge);
  }
  return args;
}

function validateLocalConfiguration({ env, reviewAuthOrigin }) {
  resolveAgenticModel(env.CARPO_PR_REVIEW_MODEL);
  if (
    reviewAuthOrigin !== "ephemeral" &&
    !env.CARPO_PR_REVIEW_AUTH_TOKEN
  ) {
    throw new Error("CARPO_PR_REVIEW_AUTH_TOKEN is required for agentic review");
  }
}

function validateDurableConfiguration({ env, reviewAuthOrigin }) {
  if (!env.CARPO_REVIEW_SERVICE_TOKEN) {
    throw new Error(
      "CARPO_REVIEW_SERVICE_TOKEN is required for the durable agent backend",
    );
  }
  if (!env.CARPO_PR_REVIEW_AUTH_TOKEN || reviewAuthOrigin !== "provided") {
    throw new Error(
      "CARPO_PR_REVIEW_AUTH_TOKEN is required for the durable backend and must match TARGET_REVIEW_AUTH_TOKEN",
    );
  }
  resolveReviewServiceUrl(env.CARPO_REVIEW_SERVICE_URL);
}

export function createLocalAgenticAdapter({ runCommand = runSubprocess } = {}) {
  return {
    validate: validateLocalConfiguration,
    prepare({ request, env }) {
      if (!env.CARPO_PR_REVIEW_AUTH_TOKEN) {
        throw new Error("CARPO_PR_REVIEW_AUTH_TOKEN is required for agentic review");
      }
      validateLocalConfiguration({ env, reviewAuthOrigin: "provided" });
      const args = ["run", "review:pr-agent", "--", ...commonReviewArgs(request)];
      return async () => {
        await runCommand("npm", args, { cwd: request.cwd, env });
      };
    },
  };
}

export function createDurableAgenticAdapter({
  runCommand = runSubprocess,
  bucket = EVIDENCE_BUCKET,
} = {}) {
  return {
    validate: validateDurableConfiguration,
    prepare({ request, env, reviewAuthOrigin }) {
      validateDurableConfiguration({ env, reviewAuthOrigin });
      const durableArgs = [
        "scripts/run-durable-flue-review.mjs",
        ...commonReviewArgs(request),
        "--repository",
        request.repository,
        "--base-sha",
        request.baseSha,
        "--head-sha",
        request.headSha,
        "--source-url",
        request.sourceUrl,
        "--source-provider",
        env.GITHUB_ACTIONS === "true" ? "github" : "manual",
      ];
      return async () => {
        const [contextText, diffText] = await Promise.all([
          readFile(request.contextPath, "utf8"),
          readFile(request.diffPath, "utf8"),
        ]);
        const inputPath = path.join(
          request.outputDir,
          "durable-review-input.json",
        );
        await writeFile(
          inputPath,
          `${JSON.stringify(
            {
              executionId: request.executionId,
              source: {
                provider: "cloudflare-builds",
                sourceUrl: request.sourceUrl,
              },
              candidate: {
                repository: request.repository,
                baseSha: request.baseSha,
                headSha: request.headSha,
                reviewOrigin: request.reviewUrl,
                expectedVersionTag: request.expectedVersionTag,
              },
              contextText,
              diffText,
              ...(request.proofChallenge
                ? { proofChallenge: request.proofChallenge }
                : {}),
              webMcpFixtureVideoId: request.webMcpFixtureVideoId,
            },
            null,
            2,
          )}\n`,
        );
        await runCommand(
          "npx",
          [
            "wrangler",
            "r2",
            "object",
            "put",
            `${bucket}/durable-inputs/${request.headSha.toLowerCase()}.json`,
            "--remote",
            "--file",
            inputPath,
          ],
          { cwd: request.cwd, env },
        );
        await runCommand("node", durableArgs, { cwd: request.cwd, env });
      };
    },
  };
}

export function createAgenticExecutionModule({ adapters } = {}) {
  const preparedPlans = new WeakMap();
  const availableAdapters =
    adapters ??
    Object.freeze({
      local: createLocalAgenticAdapter(),
      durable: createDurableAgenticAdapter(),
    });

  function validateConfiguration({
    args = {},
    env = process.env,
    reviewAuthOrigin = "provided",
  }) {
    const enabled = resolveEnabled(args, env);
    const backend = resolveBackend(args, env);
    if (!enabled) return Object.freeze({ status: "disabled" });
    const adapter = availableAdapters[backend];
    if (!adapter || typeof adapter.prepare !== "function") {
      throw new Error(`No agentic adapter is registered for ${backend}`);
    }
    adapter.validate?.({ env, reviewAuthOrigin });
    return Object.freeze({ status: "ready" });
  }

  return Object.freeze({
    validateConfiguration,

    prepare({ args = {}, env = process.env, request, reviewAuthOrigin = "provided" }) {
      const configuration = validateConfiguration({
        args,
        env,
        reviewAuthOrigin,
      });
      if (configuration.status === "disabled") {
        const plan = Object.freeze({ status: "disabled" });
        preparedPlans.set(plan, async () => undefined);
        return plan;
      }
      const backend = resolveBackend(args, env);
      const frozenRequest = validateRequest(request);
      const adapter = availableAdapters[backend];
      if (!adapter || typeof adapter.prepare !== "function") {
        throw new Error(`No agentic adapter is registered for ${backend}`);
      }
      const privateEnv = { ...env };
      const executeAdapter = adapter.prepare({
        request: frozenRequest,
        env: privateEnv,
        reviewAuthOrigin,
      });
      if (typeof executeAdapter !== "function") {
        throw new Error("The agentic adapter did not prepare an executable plan");
      }
      const plan = Object.freeze({ status: "ready" });
      preparedPlans.set(plan, async () => {
        const resultPath = path.join(frozenRequest.outputDir, "agentic-result.json");
        await unlink(resultPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        let adapterError;
        let result;
        try {
          result = await executeAdapter();
        } catch (error) {
          adapterError = error;
        }
        if (result === undefined) {
          try {
            result = await readResult(frozenRequest.outputDir);
          } catch (error) {
            adapterError ??= error;
          }
        }
        try {
          result = validateResult(result);
        } catch (error) {
          adapterError ??= error;
          result = undefined;
        }
        if (
          adapterError &&
          (result?.status !== "failed" || result?.verdict !== "inconclusive")
        ) {
          result = undefined;
        }
        if (adapterError) {
          process.stderr.write(
            `Flue exploratory review was inconclusive: ${redactSecrets(
              adapterError instanceof Error ? adapterError.message : adapterError,
              sensitiveValues(privateEnv),
            )}\n`,
          );
        }
        result ??= inconclusiveResult(adapterError, privateEnv);
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        return result;
      });
      return plan;
    },

    async execute(plan) {
      const executePlan = preparedPlans.get(plan);
      if (!executePlan) {
        throw new Error("The agentic execution plan was not prepared by this module");
      }
      return executePlan();
    },
  });
}

export const agenticExecution = createAgenticExecutionModule();
