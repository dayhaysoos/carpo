import type { Env } from "./env";

export const PR_REVIEW_COOKIE = "carpo_pr_review";

type ReviewAccessEnv = Pick<
  Env,
  "PR_REVIEW_AUTH_TOKEN" | "PR_REVIEW_MODE" | "CF_VERSION_METADATA"
>;

function cookieValue(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return undefined;
}

async function tokensMatch(
  provided: string | undefined,
  expected: string,
): Promise<boolean> {
  if (!provided) return false;

  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
}

function json(data: unknown, status: number): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function isContainerCallback(request: Request, url: URL): boolean {
  const statusPath = /^\/api\/internal\/jobs\/[^/]+\/status$/;
  const artifactPath =
    /^\/api\/internal\/jobs\/[^/]+\/artifacts\/(?:mp4|thumbnail)$/;
  const sourcePath = /^\/api\/internal\/jobs\/[^/]+\/source$/;
  return (
    (request.method === "POST" && statusPath.test(url.pathname)) ||
    (request.method === "PUT" && artifactPath.test(url.pathname)) ||
    (request.method === "GET" && sourcePath.test(url.pathname))
  );
}

/**
 * Protects the isolated PR-review environment without changing production.
 * Container callbacks retain their existing per-job secret authentication.
 */
export async function handleReviewAccess(
  request: Request,
  env: ReviewAccessEnv,
): Promise<Response | null> {
  if (env.PR_REVIEW_MODE !== "enabled") return null;

  const expectedToken = env.PR_REVIEW_AUTH_TOKEN;
  if (!expectedToken) {
    return json({ error: "PR review authentication is unavailable" }, 503);
  }

  const url = new URL(request.url);
  if (isContainerCallback(request, url)) return null;

  const authorized = await tokensMatch(
    cookieValue(request, PR_REVIEW_COOKIE),
    expectedToken,
  );
  if (!authorized) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (request.method === "GET" && url.pathname === "/api/review/identity") {
    if (!env.CF_VERSION_METADATA) {
      return json({ error: "Worker version metadata is unavailable" }, 503);
    }
    return json(env.CF_VERSION_METADATA, 200);
  }

  return null;
}
