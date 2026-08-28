import { createRemoteJWKSet, jwtVerify } from "jose";
import { HELPER_TOKEN_HEADER } from "./auth";
import type { Env } from "./env";

export const LEGACY_USER_ID = "legacy";

const accessJwksByIssuer = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export type AuthenticationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: Response };

export interface AccessIdentity {
  accessUserId: string;
  email: string;
}

interface AppUserIdentity extends AuthenticatedUser {
  access_user_id: string;
}

async function findMatchingAppUsers(
  db: D1Database,
  identity: AccessIdentity,
): Promise<AppUserIdentity[]> {
  const matches = await db
    .prepare(
      `SELECT id, access_user_id, email
       FROM app_users
       WHERE access_user_id = ? OR email = ? COLLATE NOCASE
       ORDER BY id`,
    )
    .bind(identity.accessUserId, identity.email)
    .all<AppUserIdentity>();
  return matches.results;
}

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

function normalizedAccessUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id || null;
}

async function identityFromContext(
  ctx: ExecutionContext,
): Promise<AccessIdentity | null> {
  try {
    const identity = await ctx.access?.getIdentity();
    const accessUserId = normalizedAccessUserId(identity?.user_uuid);
    const email = normalizedEmail(identity?.email);
    return accessUserId && email ? { accessUserId, email } : null;
  } catch {
    // Workers whose routing mode does not expose ctx.access can still verify
    // the signed Access assertion below.
    return null;
  }
}

function configuredIssuer(env: Env): string | null {
  const raw = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function identityFromJwt(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  const issuer = configuredIssuer(env);
  const audience = env.ACCESS_AUD?.trim();
  if (!token || !issuer || !audience) return null;

  let jwks = accessJwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", `${issuer}/`),
    );
    accessJwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  const accessUserId = normalizedAccessUserId(payload.sub);
  const email = normalizedEmail(payload.email);
  return accessUserId && email ? { accessUserId, email } : null;
}

export async function ensureAppUser(
  db: D1Database,
  identity: AccessIdentity,
): Promise<AuthenticatedUser> {
  let matches = await findMatchingAppUsers(db, identity);

  if (matches.length > 1) {
    throw new Error("Cloudflare Access identity conflicts with another Carpo user");
  }

  const existing = matches[0];
  if (existing) {
    await db
      .prepare(
        `UPDATE app_users
         SET access_user_id = ?, email = ?, last_seen_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(identity.accessUserId, identity.email, existing.id)
      .run();
    return { id: existing.id, email: identity.email };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT OR IGNORE INTO app_users (id, access_user_id, email)
       VALUES (?, ?, ?)`,
    )
    .bind(id, identity.accessUserId, identity.email)
    .run();

  matches = await findMatchingAppUsers(db, identity);
  if (matches.length !== 1) {
    throw new Error("Failed to resolve authenticated Carpo user");
  }
  return { id: matches[0].id, email: matches[0].email };
}

export async function authenticateUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<AuthenticationResult> {
  if (env.AUTH_MODE !== "cloudflare-access") {
    return {
      ok: true,
      user: { id: LEGACY_USER_ID, email: "legacy@carpo.invalid" },
    };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return {
      ok: false,
      response: jsonError("Authentication is not configured", 503),
    };
  }

  try {
    const identity =
      (await identityFromContext(ctx)) ?? (await identityFromJwt(request, env));
    if (!identity) {
      return { ok: false, response: jsonError("Authentication required", 401) };
    }
    return { ok: true, user: await ensureAppUser(env.DB, identity) };
  } catch (error) {
    console.warn("Cloudflare Access identity verification failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      ok: false,
      response: jsonError("Invalid authentication", 401),
    };
  }
}

export function isMachineRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname.startsWith("/api/internal/jobs/") ||
    pathname.startsWith("/api/helper/") ||
    (Boolean(request.headers.get(HELPER_TOKEN_HEADER)) &&
      (pathname === "/api/upload-url" ||
        pathname.startsWith("/api/uploads/")))
  );
}
