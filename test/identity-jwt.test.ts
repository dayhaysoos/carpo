import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateUser } from "../src/identity";

const issuer = "https://jwt-launch-test.cloudflareaccess.com";
const audience = "carpo-launch-test";
const keys = await generateKeyPair("RS256");
const publicKey = {
  ...(await exportJWK(keys.publicKey)),
  kid: "launch",
  alg: "RS256",
  use: "sig",
};
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicKey] });
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});
async function verify(
  options: {
    aud?: string;
    iss?: string;
    expired?: boolean;
    wrongKey?: boolean;
  } = {},
) {
  const privateKey = options.wrongKey
    ? (await generateKeyPair("RS256")).privateKey
    : keys.privateKey;
  const token = await new SignJWT({ email: "fresh-google-user@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "launch" })
    .setSubject("google-user-launch")
    .setIssuer(options.iss ?? issuer)
    .setAudience(options.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime(
      options.expired ? Math.floor(Date.now() / 1000) - 60 : "5m",
    )
    .sign(privateKey);
  return authenticateUser(
    new Request("https://carpo.example/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    }),
    {
      ...env,
      AUTH_MODE: "cloudflare-access",
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD: audience,
    },
    createExecutionContext(),
  );
}
describe("signed Access identity at the Worker boundary", () => {
  it("creates a stable account from a valid signed identity", async () => {
    const first = await verify();
    const second = await verify();
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok)
      expect(first.user.email).toBe("fresh-google-user@example.com");
  });
  it.each([
    { aud: "another-app" },
    { iss: "https://another.cloudflareaccess.com" },
    { expired: true },
    { wrongKey: true },
  ])("rejects an invalid signed assertion: %j", async (options) => {
    const result = await verify(options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
