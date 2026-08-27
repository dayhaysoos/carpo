import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (key && value) args[key] = value;
  }
  return args;
}

async function readResult(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args.summary || !args.reason) {
    throw new Error(
      "Usage: mark-pr-review-stale.mjs --result <json> --summary <md> --reason <text>",
    );
  }

  const result = {
    ...(await readResult(args.result)),
    status: "failed",
    stale: true,
    completedAt: new Date().toISOString(),
    failure: args.reason,
    proofBoundary:
      "No product proof was established because the pull request base or head changed or could not be verified after review. Discard the in-run assertions and review the current candidate.",
  };
  await writeFile(args.result, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(
    args.summary,
    [
      "## Carpo PR browser review: FAIL",
      "",
      `Reason: ${args.reason}`,
      "",
      "The pull request refs changed or could not be verified after review. Any earlier passing assertions in this run are stale and must not be used as candidate evidence.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
