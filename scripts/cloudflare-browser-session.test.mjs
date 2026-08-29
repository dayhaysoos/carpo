import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRecordedApiSession,
  officialCdpEndpoint,
  runWithCloudflareBrowser,
  stripDirectCdpOverride,
} from "./cloudflare-browser-session.mjs";

const ACCOUNT_ID = "a".repeat(32);
const SESSION_ID = "12345678-1234-1234-1234-123456789abc";
const PAGE_ENDPOINT =
  `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering/devtools/page/page-1?jwt=secret`;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Cloudflare Browser Run session", () => {
  it("opts direct CDP sessions into recording and strips untrusted overrides", () => {
    assert.match(officialCdpEndpoint(ACCOUNT_ID), /recording=true/);
    assert.equal(new URL(officialCdpEndpoint(ACCOUNT_ID)).searchParams.has("lab"), false);
    assert.equal(
      new URL(officialCdpEndpoint(ACCOUNT_ID, { lab: true })).searchParams.get("lab"),
      "true",
    );
    assert.deepEqual(
      stripDirectCdpOverride(["--url", "https://example.test", "--ws", "wss://bad"]),
      ["--url", "https://example.test"],
    );
  });

  it("creates a recorded API session and converts its page target to a browser endpoint", async () => {
    const requests = [];
    const session = await createRecordedApiSession({
      accountId: ACCOUNT_ID,
      apiToken: "browser-token",
      lab: true,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: {
            sessionId: SESSION_ID,
            targets: [{ webSocketDebuggerUrl: PAGE_ENDPOINT }],
          },
        });
      },
    });

    assert.equal(session.sessionId, SESSION_ID);
    assert.equal(
      session.endpoint,
      `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering/devtools?jwt=secret`,
    );
    const createdUrl = new URL(requests[0].url);
    assert.equal(createdUrl.searchParams.get("recording"), "true");
    assert.equal(createdUrl.searchParams.get("keep_alive"), "600000");
    assert.equal(createdUrl.searchParams.get("lab"), "true");
    assert.equal(requests[0].init.headers.Authorization, "Bearer browser-token");
  });

  it("closes the exact session, retries finalization, and writes rrweb evidence", async () => {
    const requests = [];
    const writes = [];
    let recordingAttempts = 0;
    let reviewerEndpoint;
    const result = await runWithCloudflareBrowser({
      reviewerPath: "/reviewer.mjs",
      args: ["--output", "/evidence"],
      env: {
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: "browser-token",
      },
      recordingOutputPath: "/evidence/browser-recording.json",
      runReviewerImpl: async (_reviewerPath, endpoint) => {
        reviewerEndpoint = endpoint;
      },
      wait: async () => {},
      writeFileImpl: async (file, content) => writes.push({ file, content }),
      fetchImpl: async (url, init = {}) => {
        const request = { url: String(url), method: init.method ?? "GET" };
        requests.push(request);
        if (request.method === "POST") {
          return jsonResponse({
            result: {
              sessionId: SESSION_ID,
              targets: [{ webSocketDebuggerUrl: PAGE_ENDPOINT }],
            },
          });
        }
        if (request.method === "DELETE") {
          return jsonResponse({ result: { status: "closed" } });
        }
        recordingAttempts += 1;
        if (recordingAttempts === 1) {
          return jsonResponse({ errors: [{ message: "not finalized" }] }, 404);
        }
        return jsonResponse({
          result: { duration: 1234, events: { "page-1": [{ timestamp: 1 }] } },
        });
      },
    });

    assert.equal(reviewerEndpoint.includes("/devtools?jwt=secret"), true);
    assert.equal(result.browserRecording.status, "captured");
    assert.equal(result.browserRecording.sessionId, SESSION_ID);
    assert.equal(recordingAttempts, 2);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "DELETE" && request.url.endsWith(`/devtools/browser/${SESSION_ID}`),
      ),
      true,
    );
    assert.equal(writes[0].file, "/evidence/browser-recording.json");
    const artifact = JSON.parse(writes[0].content);
    assert.equal(artifact.format, "rrweb");
    assert.deepEqual(artifact.recording.events["page-1"], [{ timestamp: 1 }]);
    assert.equal(artifact.mediaPlaybackCaptured, false);
  });

  it("refreshes Wrangler OAuth credentials before closing and reading a recording", async () => {
    let credentialReads = 0;
    const authorizations = [];
    const result = await runWithCloudflareBrowser({
      reviewerPath: "/reviewer.mjs",
      args: [],
      env: {},
      runReviewerImpl: async () => {},
      resolveCredentialsImpl: async () => {
        credentialReads += 1;
        return {
          accountId: ACCOUNT_ID,
          apiToken: credentialReads === 1 ? "initial-token" : "fresh-token",
        };
      },
      wait: async () => {},
      writeFileImpl: async () => {},
      fetchImpl: async (_url, init = {}) => {
        authorizations.push(init.headers?.Authorization);
        if (init.method === "POST") {
          return jsonResponse({
            result: {
              sessionId: SESSION_ID,
              targets: [{ webSocketDebuggerUrl: PAGE_ENDPOINT }],
            },
          });
        }
        if (init.headers?.Authorization === "Bearer initial-token") {
          return jsonResponse({ errors: [{ message: "Authentication error" }] }, 401);
        }
        if (init.method === "DELETE") {
          return jsonResponse({ result: { status: "closed" } });
        }
        return jsonResponse({ result: { events: {} } });
      },
    });

    assert.equal(result.browserRecording.status, "captured");
    assert.equal(credentialReads, 2);
    assert.deepEqual(authorizations, [
      "Bearer initial-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);
  });
});
