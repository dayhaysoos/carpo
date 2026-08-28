import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";

const GENERATED_EVIDENCE = [
  "create.png",
  "library.png",
  "archived.png",
  "failure.png",
  "trace.zip",
  "test-plan.json",
  "result.json",
  "summary.md",
  "evidence-manifest.json",
  "before-create.png",
  "after-create.png",
  "before-library.png",
  "after-library.png",
  "before-archived.png",
  "after-archived.png",
  "before",
  "after",
  "agentic-result.json",
  "agentic-trace.zip",
  "agentic-failure.png",
  "browser-recording.json",
  "durable-review-input.json",
  ...Array.from({ length: 12 }, (_, index) =>
    `agentic-${String(index + 1).padStart(2, "0")}.png`,
  ),
];

const AGENTIC_EVIDENCE = GENERATED_EVIDENCE.filter(
  (file) => typeof file === "string" && file.startsWith("agentic-"),
);

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function inlineMarkdownText(value) {
  return escapeHtml(
    String(value)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/([\\`*_\[\]()!#|{}+.-])/g, "\\$1"),
  ).replaceAll("@", "&#64;");
}

export function redactSecrets(value, sensitiveValues = []) {
  let redacted = String(value)
    .replace(/jwt=[^&\s"']+/gi, "jwt=[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(carpo_pr_review=)[^;\s"']+/gi, "$1[REDACTED]")
    .replace(/(CLOUDFLARE_API_(?:KEY|TOKEN)=)[^\s"']+/g, "$1[REDACTED]");
  for (const sensitiveValue of sensitiveValues) {
    if (typeof sensitiveValue !== "string" || sensitiveValue.length < 8) continue;
    redacted = redacted.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return redacted;
}

function diagnosticErrorText(error) {
  if (!error || typeof error !== "object") return undefined;
  const identity = error.type ?? error.code ?? error.name;
  const message = error.message ?? error.details ?? error.dev;
  if (!identity && !message) return undefined;
  return [identity, message].filter(Boolean).map(inlineMarkdownText).join(" — ");
}

export function agenticFailureDiagnosticLines(providerDiagnostics) {
  if (!providerDiagnostics || typeof providerDiagnostics !== "object") return [];
  const diagnosticTurns = Array.isArray(providerDiagnostics.turns)
    ? providerDiagnostics.turns
    : [];
  const hasFailure =
    Boolean(providerDiagnostics.cause) ||
    ["failed", "aborted"].includes(providerDiagnostics.settlement?.outcome) ||
    diagnosticTurns.some(
      (turn) =>
        Boolean(turn?.error) || ["error", "aborted"].includes(turn?.finishReason),
    ) ||
    (Array.isArray(providerDiagnostics.failedOperations) &&
      providerDiagnostics.failedOperations.length > 0) ||
    (Array.isArray(providerDiagnostics.recoveries) &&
      providerDiagnostics.recoveries.length > 0);
  if (!hasFailure) return [];
  const lines = [];
  const cause = diagnosticErrorText(providerDiagnostics.cause);
  if (cause) lines.push(`- **Cause:** ${cause}`);

  const turns = diagnosticTurns.slice(-8);
  for (const [index, turn] of turns.entries()) {
    const provider = [turn?.providerId, turn?.requestedModel]
      .filter(Boolean)
      .join("/");
    const details = [
      provider || "unknown provider/model",
      turn?.finishReason ? `finish ${turn.finishReason}` : undefined,
      turn?.providerFinishReason
        ? `provider finish ${turn.providerFinishReason}`
        : undefined,
      turn?.gatewayLogId ? `gateway log ${turn.gatewayLogId}` : undefined,
      Number.isFinite(turn?.durationMs) ? `${turn.durationMs} ms` : undefined,
      Number.isFinite(turn?.usage?.totalTokens)
        ? `${turn.usage.totalTokens} tokens`
        : undefined,
    ]
      .filter(Boolean)
      .map(inlineMarkdownText)
      .join(" · ");
    const error = diagnosticErrorText(turn?.error);
    lines.push(
      `- **Model turn ${index + 1}:** ${details}${error ? ` · **Error:** ${error}` : ""}`,
    );
  }

  const settlement = providerDiagnostics.settlement;
  if (settlement && typeof settlement === "object") {
    const error = diagnosticErrorText(settlement.error);
    lines.push(
      `- **Submission:** ${inlineMarkdownText(settlement.outcome ?? "unknown")}${error ? ` · **Error:** ${error}` : ""}`,
    );
  }

  const failedOperations = Array.isArray(providerDiagnostics.failedOperations)
    ? providerDiagnostics.failedOperations.slice(-4)
    : [];
  for (const operation of failedOperations) {
    const error = diagnosticErrorText(operation?.error);
    lines.push(
      `- **Failed operation:** ${inlineMarkdownText(operation?.operationKind ?? "unknown")}${error ? ` · ${error}` : ""}`,
    );
  }

  const recoveries = Array.isArray(providerDiagnostics.recoveries)
    ? providerDiagnostics.recoveries.slice(-4)
    : [];
  for (const recovery of recoveries) {
    const error = diagnosticErrorText(recovery?.error);
    lines.push(
      `- **Recovery:** ${inlineMarkdownText(recovery?.operation ?? "unknown")} · ${inlineMarkdownText(recovery?.outcome ?? "unknown")}${error ? ` · ${error}` : ""}`,
    );
  }
  return lines;
}

export async function prepareReviewOutput(output = "test-output/pr-review") {
  const outputDir = path.resolve(output);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    GENERATED_EVIDENCE.map(async (file) => {
      const target = path.join(outputDir, file);
      if (file === "before" || file === "after") {
        await rm(target, { recursive: true, force: true });
        return;
      }
      await unlink(target).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }),
  );
  return outputDir;
}

export async function prepareAgenticReviewOutput(output = "test-output/pr-review") {
  const outputDir = path.resolve(output);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    AGENTIC_EVIDENCE.map((file) =>
      unlink(path.join(outputDir, file)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
  return outputDir;
}
