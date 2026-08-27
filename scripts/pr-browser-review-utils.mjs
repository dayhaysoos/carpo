import { mkdir, unlink } from "node:fs/promises";
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
];

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
    GENERATED_EVIDENCE.map((file) =>
      unlink(path.join(outputDir, file)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
  return outputDir;
}
