import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  authenticateUser,
  CLOUDFLARE_ACCESS_AUTH_MODE,
  ensureAppUser,
  LEGACY_AUTH_MODE,
  LEGACY_USER_ID,
} from "../src/identity";

describe("Carpo identity", () => {
  it("keeps local and review environments on the legacy account", async () => {
    const result = await authenticateUser(
      new Request("http://example.com/api/me"),
      { ...env, AUTH_MODE: LEGACY_AUTH_MODE },
      createExecutionContext(),
    );

    expect(result).toEqual({
      ok: true,
      user: { id: LEGACY_USER_ID, email: "legacy@carpo.invalid" },
    });
  });

  it.each([
    ["missing", undefined],
    ["unrecognized", "cloudflare-acess"],
  ])("fails closed when the auth mode is %s", async (_label, authMode) => {
    const result = await authenticateUser(
      new Request("http://example.com/api/me"),
      { ...env, AUTH_MODE: authMode },
      createExecutionContext(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("keeps a stable internal user id when Access reissues its subject", async () => {
    const first = await ensureAppUser(env.DB, {
      accessUserId: `access-${crypto.randomUUID()}`,
      email: `owner-${crypto.randomUUID()}@example.com`,
    });
    const rebound = await ensureAppUser(env.DB, {
      accessUserId: `access-${crypto.randomUUID()}`,
      email: first.email,
    });

    expect(rebound).toEqual(first);
  });

  it("converges concurrent first requests on one internal user", async () => {
    const identity = {
      accessUserId: `concurrent-${crypto.randomUUID()}`,
      email: `concurrent-${crypto.randomUUID()}@example.com`,
    };
    const users = await Promise.all(
      Array.from({ length: 4 }, () => ensureAppUser(env.DB, identity)),
    );

    expect(new Set(users.map((user) => user.id)).size).toBe(1);
  });

  it("resolves a verified Cloudflare Access context to an app user", async () => {
    const email = `context-${crypto.randomUUID()}@example.com`;
    const result = await authenticateUser(
      new Request("http://example.com/api/me"),
      {
        ...env,
        AUTH_MODE: CLOUDFLARE_ACCESS_AUTH_MODE,
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        ACCESS_AUD: "test-audience",
      },
      {
        access: {
          getIdentity: async () => ({
            user_uuid: `access-${crypto.randomUUID()}`,
            email,
          }),
        },
      } as ExecutionContext,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.email).toBe(email);
  });

  it("refuses an identity that would join two existing accounts", async () => {
    const suffix = crypto.randomUUID();
    const first = await ensureAppUser(env.DB, {
      accessUserId: `first-${suffix}`,
      email: `first-${suffix}@example.com`,
    });
    const second = await ensureAppUser(env.DB, {
      accessUserId: `second-${suffix}`,
      email: `second-${suffix}@example.com`,
    });

    await expect(
      ensureAppUser(env.DB, {
        accessUserId: `first-${suffix}`,
        email: second.email,
      }),
    ).rejects.toThrow("conflicts with another Carpo user");
    expect(first.id).not.toBe(second.id);
  });

  it("fails closed when Access mode is incomplete", async () => {
    const result = await authenticateUser(
      new Request("http://example.com/api/me"),
      { ...env, AUTH_MODE: CLOUDFLARE_ACCESS_AUTH_MODE },
      createExecutionContext(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });
});
