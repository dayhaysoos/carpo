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
  );
}

export function redactSecrets(value) {
  return String(value)
    .replace(/jwt=[^&\s"']+/gi, "jwt=[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(carpo_pr_review=)[^;\s"']+/gi, "$1[REDACTED]")
    .replace(/(CLOUDFLARE_API_TOKEN=)[^\s"']+/g, "$1[REDACTED]");
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
