import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeOwnedVideoAgentRequest } from "../src/agent-routing";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { AuthenticatedUser } from "../src/identity";

const ALICE: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice-routing@example.com",
};
const BOB: AuthenticatedUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "bob-routing@example.com",
};
const ALICE_VIDEO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB_VIDEO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE_MESSAGES = [{ role: "user", content: "Alice private conversation" }];

// Replace only the platform fetch boundary. The installed Agents/PartyServer
// router still resolves every path and runs its real HTTP/WebSocket hooks.
function namespaceWithFetch(
  namespace: DurableObjectNamespace,
  fetch: (request: Request) => Promise<Response>,
): DurableObjectNamespace {
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "get") {
        return (...args: Parameters<DurableObjectNamespace["get"]>) => {
          const stub = target.get(...args);
          return new Proxy(stub, {
            get(targetStub, stubProperty) {
              if (stubProperty === "fetch") return fetch;
              const value = Reflect.get(targetStub, stubProperty, targetStub);
              return typeof value === "function" ? value.bind(targetStub) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function routingFixture(
  serveVideo: (request: Request) => Promise<Response> = async () =>
    Response.json(PRIVATE_MESSAGES),
) {
  const videoFetch = vi.fn(serveVideo);
  const transcriptFetch = vi.fn(async (_request: Request) =>
    Response.json({ transcriptStatus: "checking" }, { status: 202 }),
  );
  const encoderFetch = vi.fn(async (_request: Request) =>
    new Response("encoder reached"),
  );
  const runtimeEnv: Env = {
    ...env,
    VideoClipAgent: namespaceWithFetch(env.VideoClipAgent, videoFetch),
    TRANSCRIPT_PREPARATION: namespaceWithFetch(
      env.TRANSCRIPT_PREPARATION,
      transcriptFetch,
    ),
    ENCODER_CONTAINER: namespaceWithFetch(env.ENCODER_CONTAINER, encoderFetch),
  };
  return { runtimeEnv, videoFetch, transcriptFetch, encoderFetch };
}

beforeEach(async () => {
  await env.DB.batch([
    ...[ALICE, BOB].map((user) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO app_users (id, access_user_id, email) VALUES (?, ?, ?)",
      ).bind(user.id, user.id, user.email),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO source_videos
         (id, owner_id, source_type, source_ref, title)
       VALUES (?, ?, 'upload', ?, 'Alice private video')`,
    ).bind(ALICE_VIDEO_ID, ALICE.id, `uploads/${ALICE.id}/private.mp4`),
    env.DB.prepare(
      `INSERT OR IGNORE INTO source_videos
         (id, owner_id, source_type, source_ref, title)
       VALUES (?, ?, 'upload', ?, 'Bob private video')`,
    ).bind(BOB_VIDEO_ID, BOB.id, `uploads/${BOB.id}/private.mp4`),
  ]);
});

describe("owner-authorized video agent routing", () => {
  it("does not expose saved messages through an extra slash before the agent name", async () => {
    const fixture = routingFixture();
    const response = await routeOwnedVideoAgentRequest(
      new Request(
        `http://example.com/agents//video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
      ),
      fixture.runtimeEnv,
      BOB,
    );

    expect(response?.status).toBe(404);
    expect(fixture.videoFetch).not.toHaveBeenCalled();
  });

  it.each(["transcript-preparation", "encoder-container"])(
    "never forwards authenticated requests to internal %s bindings",
    async (bindingPath) => {
      const fixture = routingFixture();
      const response = await routeOwnedVideoAgentRequest(
        new Request(`http://example.com/agents/${bindingPath}/arbitrary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: ALICE_VIDEO_ID }),
        }),
        fixture.runtimeEnv,
        BOB,
      );

      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(fixture.transcriptFetch).not.toHaveBeenCalled();
      expect(fixture.encoderFetch).not.toHaveBeenCalled();
      expect(fixture.videoFetch).not.toHaveBeenCalled();
    },
  );

  describe.each(["HTTP", "WebSocket"])("%s authorization", (transport) => {
    it("does not forward an owned parent request to another Video through a nested agent path", async () => {
      const fixture = routingFixture();
      const response = await routeOwnedVideoAgentRequest(
        new Request(
          `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/sub/video-clip-agent/${BOB_VIDEO_ID}/get-messages`,
          {
            headers: transport === "WebSocket" ? { Upgrade: "websocket" } : {},
          },
        ),
        fixture.runtimeEnv,
        ALICE,
      );

      expect(response?.status).toBe(404);
      expect(fixture.videoFetch).not.toHaveBeenCalled();
    });

    it("does not let a client routing header select a nested Video behind an owned URL", async () => {
      const fixture = routingFixture();
      const headers = new Headers({
        "x-cf-agents-subagent-url":
          `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/sub/video-clip-agent/${BOB_VIDEO_ID}/get-messages`,
      });
      if (transport === "WebSocket") headers.set("Upgrade", "websocket");
      const response = await routeOwnedVideoAgentRequest(
        new Request(
          `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
          { headers },
        ),
        fixture.runtimeEnv,
        ALICE,
      );

      expect(response?.status).toBe(404);
      expect(fixture.videoFetch).not.toHaveBeenCalled();
    });

    it.each([
      `/agents/video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
      `/agents//video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
      `/agents/video-clip-agent//${ALICE_VIDEO_ID}/get-messages`,
      `//agents///video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
    ])("denies another owner's resolved Video at %s before dispatch", async (path) => {
      const fixture = routingFixture();
      const response = await routeOwnedVideoAgentRequest(
        new Request(`http://example.com${path}`, {
          headers: transport === "WebSocket" ? { Upgrade: "websocket" } : {},
        }),
        fixture.runtimeEnv,
        BOB,
      );

      expect(response?.status).toBe(404);
      expect(fixture.videoFetch).not.toHaveBeenCalled();
    });

    it.each([
      `%61${ALICE_VIDEO_ID.slice(1)}`,
      `%2F${ALICE_VIDEO_ID}`,
      "%ZZ",
      "missing-video",
    ])("does not reinterpret an encoded or missing instance %s as an owned Video", async (instance) => {
      const fixture = routingFixture();
      const response = await routeOwnedVideoAgentRequest(
        new Request(`http://example.com/agents/video-clip-agent/${instance}/get-messages`, {
          headers: transport === "WebSocket" ? { Upgrade: "websocket" } : {},
        }),
        fixture.runtimeEnv,
        ALICE,
      );

      expect(response?.status).toBe(404);
      expect(fixture.videoFetch).not.toHaveBeenCalled();
    });

    it.each(["transcript-preparation", "encoder-container"])(
      "keeps the internal %s namespace unreachable",
      async (bindingPath) => {
        const fixture = routingFixture();
        const response = await routeOwnedVideoAgentRequest(
          new Request(`http://example.com/agents/${bindingPath}/arbitrary`, {
            headers: transport === "WebSocket" ? { Upgrade: "websocket" } : {},
          }),
          fixture.runtimeEnv,
          ALICE,
        );

        expect(response?.status).toBeGreaterThanOrEqual(400);
        expect(fixture.transcriptFetch).not.toHaveBeenCalled();
        expect(fixture.encoderFetch).not.toHaveBeenCalled();
        expect(fixture.videoFetch).not.toHaveBeenCalled();
      },
    );
  });

  it("delivers an owner's saved-message response while preserving URL and headers", async () => {
    const fixture = routingFixture();
    const url = `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/get-messages?session=private%2Fnotes`;
    const response = await routeOwnedVideoAgentRequest(
      new Request(url, { headers: { "X-Client-Request": "owner-read" } }),
      fixture.runtimeEnv,
      ALICE,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(PRIVATE_MESSAGES);
    const delivered = fixture.videoFetch.mock.calls[0]?.[0];
    expect(delivered?.url).toBe(url);
    expect(delivered?.method).toBe("GET");
    expect(delivered?.headers.get("X-Client-Request")).toBe("owner-read");
  });

  it("preserves an authorized HTTP subpath, query and body", async () => {
    const fixture = routingFixture();
    const url = `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/custom/action?mode=inspect`;
    const body = JSON.stringify({ message: "keep this payload intact" });
    const response = await routeOwnedVideoAgentRequest(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      fixture.runtimeEnv,
      ALICE,
    );

    expect(response?.status).toBe(200);
    const delivered = fixture.videoFetch.mock.calls[0]?.[0];
    expect(delivered?.url).toBe(url);
    expect(delivered?.method).toBe("POST");
    expect(delivered?.headers.get("Content-Type")).toBe("application/json");
    expect(await delivered?.text()).toBe(body);
  });

  it("preserves an owner's WebSocket upgrade, path and query", async () => {
    let server: WebSocket | undefined;
    const fixture = routingFixture(async () => {
      const pair = new WebSocketPair();
      server = pair[1];
      server.accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    const url = `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}?_pk=owner-connection&session=notes`;
    const response = await routeOwnedVideoAgentRequest(
      new Request(url, { headers: { Upgrade: "websocket" } }),
      fixture.runtimeEnv,
      ALICE,
    );

    try {
      expect(response?.status).toBe(101);
      expect(response?.webSocket).not.toBeNull();
      response?.webSocket?.accept();
      const delivered = fixture.videoFetch.mock.calls[0]?.[0];
      expect(delivered?.url).toBe(url);
      expect(delivered?.headers.get("Upgrade")).toBe("websocket");
    } finally {
      response?.webSocket?.close();
      server?.close();
    }
  });

  it("reads saved messages from the real local VideoClipAgent for its owner", async () => {
    // Use the actual local DO binding, not namespaceWithFetch. Reading the idle
    // Think session does not submit a chat turn or invoke a model/provider.
    const response = await routeOwnedVideoAgentRequest(
      new Request(
        `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
      ),
      env,
      ALICE,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual([]);
  });

  it("opens an owner's real local VideoClipAgent WebSocket without submitting a turn", async () => {
    const response = await routeOwnedVideoAgentRequest(
      new Request(
        `http://example.com/agents/video-clip-agent/${ALICE_VIDEO_ID}?_pk=local-owner`,
        { headers: { Upgrade: "websocket" } },
      ),
      env,
      ALICE,
    );

    try {
      expect(response?.status).toBe(101);
      expect(response?.webSocket).not.toBeNull();
      response?.webSocket?.accept();
    } finally {
      response?.webSocket?.close(1000, "Local routing test complete");
    }
  });

  it.each(["/api/videos", "/library", "/agents", "/agents/video-clip-agent/"])(
    "lets non-agent or incomplete routes fall through without dispatch: %s",
    async (path) => {
      const fixture = routingFixture();
      const response = await routeOwnedVideoAgentRequest(
        new Request(`http://example.com${path}`),
        fixture.runtimeEnv,
        ALICE,
      );

      expect(response).toBeNull();
      expect(fixture.videoFetch).not.toHaveBeenCalled();
      expect(fixture.transcriptFetch).not.toHaveBeenCalled();
      expect(fixture.encoderFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    `/agents//video-clip-agent/${ALICE_VIDEO_ID}/get-messages`,
    "/agents/transcript-preparation/arbitrary",
    "/agents/encoder-container/arbitrary",
  ])("enforces the same boundary through the signed-in Worker adapter: %s", async (path) => {
    const fixture = routingFixture();
    const ctx = createExecutionContext();
    Object.assign(ctx, {
      access: {
        getIdentity: async () => ({ user_uuid: BOB.id, email: BOB.email }),
      },
    });
    const response = await worker.fetch(
      new Request(`http://example.com${path}`),
      {
        ...fixture.runtimeEnv,
        AUTH_MODE: "cloudflare-access",
        ACCESS_TEAM_DOMAIN: "https://routing-test.cloudflareaccess.com",
        ACCESS_AUD: "routing-test",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fixture.videoFetch).not.toHaveBeenCalled();
    expect(fixture.transcriptFetch).not.toHaveBeenCalled();
    expect(fixture.encoderFetch).not.toHaveBeenCalled();
  });
});
