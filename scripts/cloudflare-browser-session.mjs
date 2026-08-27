import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "./pr-browser-review-utils.mjs";

const execFileAsync = promisify(execFile);

export function stripDirectCdpOverride(argv) {
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

export function officialCdpEndpoint(accountId) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account ID");
  }
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=600000`;
}

async function runReviewer(reviewerPath, endpoint, args, env) {
  const child = await execFileAsync(process.execPath, [reviewerPath, ...args], {
    env: { ...env, CARPO_BROWSER_CDP_URL: endpoint },
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
}

async function createWranglerSession(env) {
  const { stdout } = await execFileAsync(
    "npx",
    ["wrangler", "browser", "create", "--json", "--open=false", "--keepAlive=600"],
    { env, maxBuffer: 2 * 1024 * 1024 },
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

export async function runWithCloudflareBrowser({ reviewerPath, args, env = process.env }) {
  const configuredEndpoint = env.CARPO_BROWSER_CDP_URL;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (configuredEndpoint) {
    await runReviewer(reviewerPath, configuredEndpoint, args, env);
    return;
  }
  if (accountId && apiToken) {
    await runReviewer(reviewerPath, officialCdpEndpoint(accountId), args, env);
    return;
  }

  let sessionId;
  try {
    const session = await createWranglerSession(env);
    sessionId = session.sessionId;
    if (env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::add-mask::${session.endpoint}\n`);
    }
    await runReviewer(reviewerPath, session.endpoint, args, env);
  } finally {
    if (sessionId) {
      await execFileAsync(
        "npx",
        ["wrangler", "browser", "close", sessionId, "--json"],
        { env, maxBuffer: 2 * 1024 * 1024 },
      ).catch((error) => {
        process.stderr.write(
          `Could not close Browser Run session: ${redactSecrets(error.message)}\n`,
        );
      });
    }
  }
}
