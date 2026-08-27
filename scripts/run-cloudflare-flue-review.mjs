import { fileURLToPath } from "node:url";
import {
  runWithCloudflareBrowser,
  stripDirectCdpOverride,
} from "./cloudflare-browser-session.mjs";
import {
  prepareAgenticReviewOutput,
  redactSecrets,
} from "./pr-browser-review-utils.mjs";

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? "test-output/pr-review" : args[outputIndex + 1];
  await prepareAgenticReviewOutput(output);
  await runWithCloudflareBrowser({
    reviewerPath: fileURLToPath(
      new URL("./flue-pr-browser-review.mjs", import.meta.url),
    ),
    args: stripDirectCdpOverride(args),
  });
}

main().catch((error) => {
  if (error?.stdout) process.stdout.write(redactSecrets(error.stdout));
  if (error?.stderr) process.stderr.write(redactSecrets(error.stderr));
  if (!error?.stdout && !error?.stderr) {
    process.stderr.write(
      `${redactSecrets(error instanceof Error ? error.message : error)}\n`,
    );
  }
  process.exitCode = 1;
});
