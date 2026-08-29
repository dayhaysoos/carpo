import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { redactSecrets } from "./pr-browser-review-utils.mjs";

const execFileAsync = promisify(execFile);
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const RECORDING_RETRY_ATTEMPTS = 12;
const RECORDING_RETRY_DELAY_MS = 1_000;

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

export function officialCdpEndpoint(accountId, { lab = false } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account ID");
  }
  const url = new URL(
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser`,
  );
  url.searchParams.set("keep_alive", "600000");
  url.searchParams.set("recording", "true");
  if (lab) url.searchParams.set("lab", "true");
  return url.href;
}

async function runReviewer(reviewerPath, endpoint, args, env) {
  const child = await execFileAsync(process.execPath, [reviewerPath, ...args], {
    env: { ...env, CARPO_BROWSER_CDP_URL: endpoint },
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
}

async function createWranglerSession(env, { lab = false } = {}) {
  const args = [
    "wrangler",
    "browser",
    "create",
    "--json",
    "--open=false",
    "--keepAlive=600",
  ];
  if (lab) args.push("--lab");
  const { stdout } = await execFileAsync(
    "npx",
    args,
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

async function resolveWranglerApiCredentials(env) {
  const [{ stdout: authOutput }, { stdout: whoamiOutput }] = await Promise.all([
    execFileAsync("npx", ["wrangler", "auth", "token", "--json"], {
      env,
      maxBuffer: 256 * 1024,
    }),
    execFileAsync("npx", ["wrangler", "whoami", "--json"], {
      env,
      maxBuffer: 512 * 1024,
    }),
  ]);
  const auth = JSON.parse(authOutput);
  const whoami = JSON.parse(whoamiOutput);
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];
  const accountId = accounts.length === 1 ? accounts[0]?.id : undefined;
  return auth?.token && accountId
    ? { accountId, apiToken: auth.token }
    : undefined;
}

function cloudflareApiUrl(accountId, pathname) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account ID");
  }
  return new URL(
    `/client/v4/accounts/${accountId}/browser-rendering/${pathname}`,
    CLOUDFLARE_API_ORIGIN,
  );
}

function unwrapCloudflareResponse(payload) {
  if (payload?.success === false) {
    const message = Array.isArray(payload.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : undefined;
    throw new Error(message || "Cloudflare Browser Run API request failed");
  }
  return payload?.result ?? payload;
}

async function readCloudflareResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const message = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : undefined;
    const error = new Error(
      `${label} failed (${response.status})${message ? `: ${message}` : ""}`,
    );
    error.status = response.status;
    throw error;
  }
  return unwrapCloudflareResponse(payload);
}

function browserSessionFromPayload(payload) {
  const sessionId = findString(payload, ["sessionId", "session_id", "id"]);
  const targetEndpoint = payload?.targets
    ?.map((target) => target?.webSocketDebuggerUrl)
    .find((endpoint) => typeof endpoint === "string" && endpoint.includes("jwt="));
  if (!sessionId || !targetEndpoint) {
    throw new Error("Cloudflare returned an incomplete Browser Run session");
  }
  const endpointUrl = new URL(targetEndpoint);
  endpointUrl.pathname = endpointUrl.pathname.replace(/\/page\/[^/]+$/, "");
  return { sessionId, endpoint: endpointUrl.href };
}

export async function createRecordedApiSession({
  accountId,
  apiToken,
  lab = false,
  fetchImpl = fetch,
}) {
  const url = cloudflareApiUrl(accountId, "devtools/browser");
  url.searchParams.set("targets", "true");
  url.searchParams.set("keep_alive", "600000");
  url.searchParams.set("recording", "true");
  if (lab) url.searchParams.set("lab", "true");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  return browserSessionFromPayload(
    await readCloudflareResponse(response, "Create recorded Browser Run session"),
  );
}

async function closeApiSession({ accountId, apiToken, sessionId, fetchImpl }) {
  const response = await fetchImpl(
    cloudflareApiUrl(accountId, `devtools/browser/${sessionId}`),
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  );
  if (response.status !== 404) {
    await readCloudflareResponse(response, "Close Browser Run session");
  }
}

async function fetchRecording({ accountId, apiToken, sessionId, fetchImpl }) {
  const response = await fetchImpl(
    cloudflareApiUrl(accountId, `recording/${sessionId}`),
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  return readCloudflareResponse(response, "Fetch Browser Run recording");
}

async function finalizeRecording({
  accountId,
  apiToken,
  sessionId,
  fetchImpl,
  wait,
  outputPath,
  writeFileImpl,
}) {
  let lastError;
  for (let attempt = 1; attempt <= RECORDING_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const recording = await fetchRecording({
        accountId,
        apiToken,
        sessionId,
        fetchImpl,
      });
      const artifact = {
        schemaVersion: "carpo.browser-run-recording.v1",
        status: "captured",
        provider: "cloudflare-browser-run",
        format: "rrweb",
        sessionId,
        capturedAt: new Date().toISOString(),
        inputFieldsMasked: true,
        mediaPlaybackCaptured: false,
        recording,
      };
      if (outputPath) {
        await writeFileImpl(outputPath, `${JSON.stringify(artifact)}\n`);
      }
      return {
        status: "captured",
        provider: artifact.provider,
        format: artifact.format,
        sessionId,
        artifact: outputPath ? "browser-recording.json" : undefined,
        inputFieldsMasked: true,
        mediaPlaybackCaptured: false,
      };
    } catch (error) {
      lastError = error;
      if (![404, 409].includes(error?.status) || attempt === RECORDING_RETRY_ATTEMPTS) {
        break;
      }
      await wait(RECORDING_RETRY_DELAY_MS);
    }
  }

  const failure = redactSecrets(
    lastError instanceof Error ? lastError.message : lastError,
  );
  const artifact = {
    schemaVersion: "carpo.browser-run-recording.v1",
    status: "failed",
    provider: "cloudflare-browser-run",
    format: "rrweb",
    sessionId,
    capturedAt: new Date().toISOString(),
    failure,
  };
  if (outputPath) {
    await writeFileImpl(outputPath, `${JSON.stringify(artifact)}\n`);
  }
  return {
    status: "failed",
    provider: artifact.provider,
    format: artifact.format,
    sessionId,
    artifact: outputPath ? "browser-recording.json" : undefined,
    failure,
  };
}

export async function runWithCloudflareBrowser({
  reviewerPath,
  args,
  env = process.env,
  recordingOutputPath,
  fetchImpl = fetch,
  runReviewerImpl = runReviewer,
  resolveCredentialsImpl = resolveWranglerApiCredentials,
  writeFileImpl = writeFile,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  lab = false,
}) {
  const configuredEndpoint = env.CARPO_BROWSER_CDP_URL;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (configuredEndpoint) {
    await runReviewerImpl(reviewerPath, configuredEndpoint, args, env);
    return { browserRecording: undefined };
  }
  const environmentCredentials =
    accountId && apiToken ? { accountId, apiToken } : undefined;
  const credentials =
    environmentCredentials ??
    (await resolveCredentialsImpl(env).catch(() => undefined));
  let recordedSession;
  if (credentials) {
    try {
      recordedSession = await createRecordedApiSession({
        accountId: credentials.accountId,
        apiToken: credentials.apiToken,
        lab,
        fetchImpl,
      });
    } catch (error) {
      if (environmentCredentials) throw error;
      process.stderr.write(
        `Could not create a recorded Browser Run session with Wrangler OAuth; using the compatible unrecorded Wrangler session: ${redactSecrets(error.message)}\n`,
      );
    }
  }
  if (credentials && recordedSession) {
    const session = recordedSession;
    if (env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::add-mask::${session.endpoint}\n`);
    }
    let reviewerError;
    let browserRecording;
    try {
      await runReviewerImpl(reviewerPath, session.endpoint, args, env);
    } catch (error) {
      reviewerError = error;
    } finally {
      let finalCredentials = credentials;
      if (!environmentCredentials) {
        const refreshedCredentials = await resolveCredentialsImpl(env).catch(
          () => undefined,
        );
        if (refreshedCredentials?.accountId === credentials.accountId) {
          finalCredentials = refreshedCredentials;
        }
      }
      await closeApiSession({
        accountId: finalCredentials.accountId,
        apiToken: finalCredentials.apiToken,
        sessionId: session.sessionId,
        fetchImpl,
      }).catch((error) => {
        process.stderr.write(
          `Could not close Browser Run session: ${redactSecrets(error.message)}\n`,
        );
      });
      browserRecording = await finalizeRecording({
        accountId: finalCredentials.accountId,
        apiToken: finalCredentials.apiToken,
        sessionId: session.sessionId,
        fetchImpl,
        wait,
        outputPath: recordingOutputPath,
        writeFileImpl,
      });
      process.stdout.write(
        browserRecording.status === "captured"
          ? `Browser Run replay captured: ${session.sessionId} (rrweb)\n`
          : `Browser Run replay unavailable: ${browserRecording.failure}\n`,
      );
    }
    if (reviewerError) {
      reviewerError.browserRecording = browserRecording;
      throw reviewerError;
    }
    return { browserRecording };
  }

  let sessionId;
  try {
    const session = await createWranglerSession(env, { lab });
    sessionId = session.sessionId;
    if (env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::add-mask::${session.endpoint}\n`);
    }
    await runReviewerImpl(reviewerPath, session.endpoint, args, env);
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
  return { browserRecording: undefined };
}
