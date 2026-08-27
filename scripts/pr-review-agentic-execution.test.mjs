import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createAgenticExecutionModule,
  createDurableAgenticAdapter,
  createLocalAgenticAdapter,
} from "./pr-review-agentic-execution.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function request(outputDir) {
  return {
    executionId: "test-agentic-execution",
    sourceUrl: "https://github.com/dayhaysoos/carpo/pull/9",
    repository: "dayhaysoos/carpo",
    baseSha,
    headSha,
    reviewUrl: "https://carpo-pr-review.ndejesus1227.workers.dev",
    expectedVersionTag: headSha,
    contextPath: path.join(outputDir, "context.json"),
    diffPath: path.join(outputDir, "diff.patch"),
    outputDir,
    cwd: "/candidate",
    proofChallenge: "multilingual-pants",
  };
}

function completedResult(overrides = {}) {
  return {
    schemaVersion: "carpo.pr-browser-review.agentic.v1",
    status: "completed",
    advisory: true,
    verdict: "pass",
    summary: "The bounded review completed.",
    testedAreas: ["Create"],
    findings: [],
    remainingRisks: ["Upload execution remains unverified."],
    screenshots: [],
    diagnostics: {},
    proofBoundary: "Advisory only.",
    ...overrides,
  };
}

async function withFrozenFiles(run) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "carpo-agentic-module-"));
  try {
    await Promise.all([
      writeFile(path.join(outputDir, "context.json"), '{"number":9}\n'),
      writeFile(path.join(outputDir, "diff.patch"), "diff --git a/a b/a\n"),
    ]);
    await run(outputDir);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

describe("agentic PR review execution module", () => {
  it("prepares one opaque ready plan and executes an in-memory adapter", async () => {
    await withFrozenFiles(async (outputDir) => {
      let preparedRequest;
      const module = createAgenticExecutionModule({
        adapters: {
          local: {
            prepare(input) {
              preparedRequest = input.request;
              return async () => completedResult();
            },
          },
        },
      });
      const plan = module.prepare({
        args: {},
        env: { CARPO_PR_REVIEW_AUTH_TOKEN: "review-token" },
        request: request(outputDir),
      });

      assert.deepEqual(plan, { status: "ready" });
      assert.deepEqual(Object.keys(plan), ["status"]);
      assert.equal(preparedRequest.headSha, headSha);

      const result = await module.execute(plan);
      assert.equal(result.verdict, "pass");
      assert.deepEqual(
        JSON.parse(
          await readFile(path.join(outputDir, "agentic-result.json"), "utf8"),
        ),
        result,
      );
    });
  });

  it("keeps default enablement and explicit escape hatches behind the seam", () => {
    const module = createAgenticExecutionModule({ adapters: {} });
    assert.deepEqual(
      module.prepare({
        args: { "no-agentic": true },
        env: {},
        reviewAuthOrigin: "ephemeral",
      }),
      { status: "disabled" },
    );
    assert.deepEqual(
      module.prepare({
        args: {},
        env: { CARPO_PR_REVIEW_AGENTIC: "false" },
        reviewAuthOrigin: "ephemeral",
      }),
      { status: "disabled" },
    );
    assert.throws(
      () =>
        module.prepare({
          args: { agentic: true, "no-agentic": true },
          env: {},
        }),
      /cannot be used together/,
    );
    assert.throws(
      () =>
        module.prepare({
          args: {},
          env: { CARPO_PR_REVIEW_AGENTIC: "yes" },
        }),
      /must be true or false/,
    );
    assert.throws(
      () =>
        module.prepare({
          args: { "no-agentic": true, "agent-backend": "github" },
          env: {},
        }),
      /local or durable/,
    );
  });

  it("selects local by default, supports durable explicitly, and rejects unknown backends", async () => {
    await withFrozenFiles(async (outputDir) => {
      const selected = [];
      const adapter = (name) => ({
        prepare() {
          selected.push(name);
          return async () => completedResult();
        },
      });
      const module = createAgenticExecutionModule({
        adapters: { local: adapter("local"), durable: adapter("durable") },
      });
      module.prepare({ args: {}, env: {}, request: request(outputDir) });
      module.prepare({
        args: { "agent-backend": "durable" },
        env: {},
        request: request(outputDir),
      });
      assert.deepEqual(selected, ["local", "durable"]);
      assert.throws(
        () =>
          module.prepare({
            args: { "agent-backend": "github" },
            env: {},
            request: request(outputDir),
          }),
        /local or durable/,
      );
    });
  });

  it("fails fast on missing durable credentials or an ephemeral target token", async () => {
    await withFrozenFiles(async (outputDir) => {
      const module = createAgenticExecutionModule({
        adapters: { durable: createDurableAgenticAdapter() },
      });
      assert.throws(
        () =>
          module.validateConfiguration({
            args: { "agent-backend": "durable" },
            env: { CARPO_PR_REVIEW_AUTH_TOKEN: "stable-target-token" },
          }),
        /CARPO_REVIEW_SERVICE_TOKEN/,
      );
      assert.throws(
        () =>
          module.validateConfiguration({
            args: { "agent-backend": "durable" },
            env: {
              CARPO_REVIEW_SERVICE_TOKEN: "service-token",
              CARPO_PR_REVIEW_AUTH_TOKEN: "ephemeral-target-token",
            },
            reviewAuthOrigin: "ephemeral",
          }),
        /must match TARGET_REVIEW_AUTH_TOKEN/,
      );
      assert.deepEqual(
        module.validateConfiguration({
          args: { "no-agentic": true, "agent-backend": "durable" },
          env: {},
          reviewAuthOrigin: "ephemeral",
        }),
        { status: "disabled" },
      );
    });
  });

  it("normalizes adapter failures and malformed results to advisory inconclusive", async () => {
    await withFrozenFiles(async (outputDir) => {
      for (const execute of [
        async () => {
          throw new Error("backend token secret-value was rejected");
        },
        async () => ({ status: "surprise" }),
      ]) {
        const module = createAgenticExecutionModule({
          adapters: { local: { prepare: () => execute } },
        });
        const plan = module.prepare({
          args: {},
          env: {
            CARPO_PR_REVIEW_AUTH_TOKEN: "secret-value",
          },
          request: request(outputDir),
        });
        const result = await module.execute(plan);
        assert.equal(result.status, "failed");
        assert.equal(result.verdict, "inconclusive");
        assert.equal(result.advisory, true);
        assert.doesNotMatch(result.failure, /secret-value/);
      }
    });
  });

  it("preserves a backend-authored failure report when its subprocess exits nonzero", async () => {
    await withFrozenFiles(async (outputDir) => {
      const detailedFailure = completedResult({
        status: "failed",
        verdict: "inconclusive",
        summary: "The provider rejected the request.",
        failure: "Workers AI unavailable.",
      });
      const module = createAgenticExecutionModule({
        adapters: {
          local: {
            prepare: () => async () => {
              await writeFile(
                path.join(outputDir, "agentic-result.json"),
                JSON.stringify(detailedFailure),
              );
              throw new Error("subprocess exited 1");
            },
          },
        },
      });
      const result = await module.execute(
        module.prepare({ args: {}, env: {}, request: request(outputDir) }),
      );
      assert.deepEqual(result, detailedFailure);
    });
  });

  it("does not let one module execute another module's opaque plan", async () => {
    await withFrozenFiles(async (outputDir) => {
      const adapter = {
        prepare: () => async () => completedResult(),
      };
      const first = createAgenticExecutionModule({
        adapters: { local: adapter },
      });
      const second = createAgenticExecutionModule({
        adapters: { local: adapter },
      });
      const plan = first.prepare({ args: {}, env: {}, request: request(outputDir) });
      await assert.rejects(
        () => second.execute(plan),
        /was not prepared by this module/,
      );
    });
  });

  it("treats failure to persist the trusted result artifact as a hard error", async () => {
    const outputFile = path.join(
      os.tmpdir(),
      `carpo-agentic-output-file-${process.pid}-${Date.now()}`,
    );
    await writeFile(outputFile, "not a directory");
    try {
      const module = createAgenticExecutionModule({
        adapters: {
          local: { prepare: () => async () => completedResult() },
        },
      });
      const plan = module.prepare({
        args: {},
        env: {},
        request: request(outputFile),
      });
      await assert.rejects(() => module.execute(plan), /ENOTDIR/);
    } finally {
      await rm(outputFile, { force: true });
    }
  });
});

describe("agentic subprocess adapters", () => {
  it("builds the local Flue subprocess without exposing backend details to the runner", async () => {
    await withFrozenFiles(async (outputDir) => {
      const calls = [];
      const execute = createLocalAgenticAdapter({
        runCommand: async (...args) => calls.push(args),
      }).prepare({
        request: request(outputDir),
        env: { CARPO_PR_REVIEW_AUTH_TOKEN: "review-token" },
      });
      await execute();
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "npm");
      assert.deepEqual(calls[0][1].slice(0, 4), [
        "run",
        "review:pr-agent",
        "--",
        "--url",
      ]);
      assert.ok(calls[0][1].includes("multilingual-pants"));
      assert.equal(calls[0][2].cwd, "/candidate");
    });
  });

  it("stages the frozen durable package before invoking the Durable Flue subprocess", async () => {
    await withFrozenFiles(async (outputDir) => {
      const calls = [];
      const execute = createDurableAgenticAdapter({
        runCommand: async (...args) => calls.push(args),
      }).prepare({
        request: request(outputDir),
        env: {
          CARPO_REVIEW_SERVICE_TOKEN: "service-token",
          CARPO_PR_REVIEW_AUTH_TOKEN: "target-token",
          GITHUB_ACTIONS: "true",
        },
        reviewAuthOrigin: "provided",
      });
      await execute();

      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0][1].slice(0, 5), [
        "wrangler",
        "r2",
        "object",
        "put",
        `carpo-pr-review-evidence/durable-inputs/${headSha}.json`,
      ]);
      assert.equal(calls[1][0], "node");
      assert.equal(calls[1][1][0], "scripts/run-durable-flue-review.mjs");
      assert.equal(
        calls[1][1][calls[1][1].indexOf("--source-provider") + 1],
        "github",
      );
      const payload = JSON.parse(
        await readFile(
          path.join(outputDir, "durable-review-input.json"),
          "utf8",
        ),
      );
      assert.equal(payload.candidate.headSha, headSha);
      assert.equal(payload.contextText, '{"number":9}\n');
      assert.equal(payload.proofChallenge, "multilingual-pants");
    });
  });
});
