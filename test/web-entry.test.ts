import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { loginDestination } from "../src/web-entry";
import { ENCODER_POOL_INSTANCE } from "../src/encoder-pool";

const accessEnv = {
  ...env,
  AUTH_MODE: "cloudflare-access",
  ACCESS_TEAM_DOMAIN: "https://launch-test.cloudflareaccess.com",
  ACCESS_AUD: "launch-test-audience",
};
async function request(
  path: string,
  signedIn: boolean | string = false,
  init?: RequestInit,
) {
  const ctx = createExecutionContext();
  const email =
    typeof signedIn === "string" ? signedIn : "new-user@example.com";
  if (signedIn)
    Object.assign(ctx, {
      access: { getIdentity: async () => ({ user_uuid: email, email }) },
    });
  const response = await worker.fetch(
    new Request(`http://example.com${path}`, init),
    accessEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("public entry and private workspace boundary", () => {
  it("serves the public landing without identity or user creation", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM app_users WHERE email = ?",
      )
        .bind("new-user@example.com")
        .first("count"),
    ).toBe(0);
  });
  it("authenticates before redirecting and provisions the first account once", async () => {
    expect((await request("/api/auth/login?returnTo=%2Flibrary")).status).toBe(401);
    const login = await request("/api/auth/login?returnTo=%2Flibrary", true);
    expect(login.status).toBe(303);
    expect(login.headers.get("Location")).toBe("/library");
    expect(login.headers.get("Cache-Control")).toBe("no-store");
    const first = await request("/api/me", true);
    const second = await request("/api/me", true);
    const user = await first.json();
    expect(user).toMatchObject({ email: "new-user@example.com" });
    expect(await second.json()).toEqual(user);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await (await request("/api/videos", true)).json()).toMatchObject({
      videos: [],
    });
  });
  it("forwards old sign-in links into the protected API destination", async () => {
    const response = await request("/auth/login?returnTo=%2Flibrary");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/api/auth/login?returnTo=%2Flibrary");
    const unsafe = await request("/auth/login?returnTo=https%3A%2F%2Fevil.example");
    expect(unsafe.headers.get("Location")).toBe("/api/auth/login?returnTo=%2Fcreate");
  });
  it.each([
    "/api/me",
    "/api/videos",
    "/api/clips",
    "/artifacts/private.mp4",
    "/agents/video-clip-agent/private",
  ])("keeps %s private", async (path) => {
    expect((await request(path)).status).toBe(401);
  });
  it("reaches the token-validation share handler without signing in", async () => {
    const response = await request("/share/invalid-token");
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toContain(
      "Ask the clip owner for a new link",
    );
  });
  it("takes a fresh account through upload, encoding, private playback, sharing and revocation", async () => {
    const owner = "launch-journey@example.com";
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const me = (await (await request("/api/me", owner)).json()) as {
      id: string;
    };
    const slotResponse = await request(
      "/api/upload-url",
      owner,
      json({ contentType: "video/mp4", sizeBytes: 8, filename: "launch.mp4" }),
    );
    expect(slotResponse.status).toBe(200);
    const slot = (await slotResponse.json()) as {
      key: string;
      uploadUrl: string;
    };
    expect(slot.key).toContain(`uploads/${me.id}/`);
    const upload = await request(new URL(slot.uploadUrl).pathname, owner, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]),
    });
    expect(upload.status).toBe(201);
    const created = await request(
      "/api/clips",
      owner,
      json({
        title: "Launch journey",
        source: { type: "upload", key: slot.key },
        trimStart: 0,
        trimEnd: 5,
        filters: [],
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const encoded = await env.ENCODER_CONTAINER.getByName(
      ENCODER_POOL_INSTANCE,
    ).fetch(`http://encoder/__carpo/wait-for-dispatch?jobId=${id}`);
    expect(encoded.status).toBe(204);
    const clip = (await (await request(`/api/clips/${id}`, owner)).json()) as {
      status: string;
      outputs: { mp4: string };
    };
    expect(clip.status).toBe("complete");
    const mediaPath = new URL(clip.outputs.mp4, "http://example.com").pathname;
    expect((await request(mediaPath, owner)).status).toBe(200);
    expect((await request(mediaPath)).status).toBe(401);
    expect(
      (await request(mediaPath, "another-account@example.com")).status,
    ).toBe(404);
    expect(
      (await request(`/api/clips/${id}`, "another-account@example.com")).status,
    ).toBe(404);
    const shared = await request(
      `/api/clips/${id}/distribution/shares`,
      owner,
      json({ expiration: "week" }),
    );
    expect(shared.status).toBe(201);
    const share = (await shared.json()) as {
      url: string;
      share: { id: string };
    };
    const publicPath = new URL(share.url).pathname;
    expect((await request(publicPath)).status).toBe(200);
    expect((await request(`${publicPath}/media`)).status).toBe(200);
    const download = await request(`${publicPath}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    expect(
      (
        await request(
          `/api/clips/${id}/distribution/shares/${share.share.id}`,
          owner,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    expect((await request(publicPath)).status).toBe(410);
    expect((await request(`${publicPath}/media`)).status).toBe(410);
  });
  it.each([
    "https://example.org",
    "//example.org",
    "/\\example.org",
    "/%2f%2fexample.org",
    "/api/clips",
    "/share/secret",
    "/auth/login",
    "/create/../../api/me",
    "/create\r\nLocation:evil",
  ])("rejects an unsafe return destination: %s", (value) => {
    expect(loginDestination(value)).toBe("/create");
  });
  it("preserves a private source or proposal return destination", () => {
    expect(loginDestination("/create?video=abc&libraryProposal=def")).toBe(
      "/create?video=abc&libraryProposal=def",
    );
    expect(loginDestination("/library/videos/abc")).toBe("/library/videos/abc");
  });
});
