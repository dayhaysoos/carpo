import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  prepareReviewOutput,
  redactSecrets,
} from "./pr-browser-review-utils.mjs";

const execFileAsync = promisify(execFile);

function withoutDirectCdpOverride(argv) {
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--ws") {
      index += 1;
      continue;
    }
    args.push(argv[index]);
  }
  return args;
}

function findString(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function parseJsonOutput(stdout) {
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace < firstBrace) {
    throw new Error("Wrangler did not return Browser Run session JSON");
  }
  return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
}

function officialCdpEndpoint(accountId) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account ID");
  }
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=600000`;
}

async function runReviewer(endpoint, args) {
  const child = await execFileAsync(
    process.execPath,
    [
      fileURLToPath(new URL("./pr-browser-review.mjs", import.meta.url)),
      ...withoutDirectCdpOverride(args),
    ],
    {
      env: { ...process.env, CARPO_BROWSER_CDP_URL: endpoint },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
}

async function createWranglerSession() {
  const { stdout } = await execFileAsync(
    "npx",
    ["wrangler", "browser", "create", "--json", "--open=false", "--keepAlive=600"],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  const session = parseJsonOutput(stdout);
  const sessionId = findString(session, ["sessionId", "session_id", "id"]);
  const targetEndpoint = session.targets
    ?.map((target) => target?.webSocketDebuggerUrl)
    .find((endpoint) => typeof endpoint === "string" && endpoint.includes("jwt="));
  if (!sessionId || !targetEndpoint) {
    throw new Error("Wrangler returned an incomplete Browser Run session");
  }

  const endpointUrl = new URL(targetEndpoint);
  endpointUrl.pathname = endpointUrl.pathname.replace(/\/page\/[^/]+$/, "");
  return { sessionId, endpoint: endpointUrl.href };
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  await prepareReviewOutput(output);
  const configuredEndpoint = process.env.CARPO_BROWSER_CDP_URL;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (configuredEndpoint) {
    await runReviewer(configuredEndpoint, args);
    return;
  }
  if (accountId && apiToken) {
    await runReviewer(officialCdpEndpoint(accountId), args);
    return;
  }

  let sessionId;
  try {
    const session = await createWranglerSession();
    sessionId = session.sessionId;
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::add-mask::${session.endpoint}\n`);
    }
    await runReviewer(session.endpoint, args);
  } finally {
    if (sessionId) {
      await execFileAsync("npx", ["wrangler", "browser", "close", sessionId, "--json"], {
        maxBuffer: 2 * 1024 * 1024,
      }).catch((error) => {
        process.stderr.write(`Could not close Browser Run session: ${redactSecrets(error.message)}\n`);
      });
    }
  }
}

main().catch((error) => {
  if (error?.stdout) process.stdout.write(redactSecrets(error.stdout));
  if (error?.stderr) process.stderr.write(redactSecrets(error.stderr));
  if (!error?.stdout && !error?.stderr) {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : error)}\n`);
  }
  process.exitCode = 1;
});
