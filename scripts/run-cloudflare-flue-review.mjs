import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  let browserRecording;
  let reviewError;
  try {
    ({ browserRecording } = await runWithCloudflareBrowser({
      reviewerPath: fileURLToPath(
        new URL("./flue-pr-browser-review.mjs", import.meta.url),
      ),
      args: stripDirectCdpOverride(args),
      recordingOutputPath: path.join(output, "browser-recording.json"),
    }));
  } catch (error) {
    reviewError = error;
    browserRecording = error?.browserRecording;
  }

  if (browserRecording) {
    const resultPath = path.join(output, "agentic-result.json");
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      result.browserRecording = browserRecording;
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      if (!reviewError || error?.code !== "ENOENT") throw error;
    }
  }
  if (reviewError) throw reviewError;
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
