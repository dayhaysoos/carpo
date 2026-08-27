import type { Env } from "./env";

const EVIDENCE_PATH_PREFIX = "/api/review/evidence/";
const EVIDENCE_KEY_PATTERN =
  /^pull-requests\/[1-9][0-9]{0,9}\/(?:[0-9a-f]{40}|[0-9a-f]{64})\/executions\/(?:actions-[1-9][0-9]{0,19}-[1-9][0-9]{0,2}|manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})\/(?:create|library|archived|failure)\.png$/;

type ReviewEvidenceObject = Pick<
  R2Object,
  "httpEtag" | "writeHttpMetadata"
>;

type ReviewEvidenceBodyObject = ReviewEvidenceObject &
  Pick<R2ObjectBody, "body">;

type ReviewEvidenceBucket = {
  get(key: string): Promise<ReviewEvidenceBodyObject | null>;
  head(key: string): Promise<ReviewEvidenceObject | null>;
};

type ReviewEvidenceEnv = Pick<Env, "PR_REVIEW_MODE"> & {
  PR_REVIEW_EVIDENCE_BUCKET?: ReviewEvidenceBucket;
};

function responseHeaders(object: ReviewEvidenceObject): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "image/png");
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "public, max-age=3600, immutable");
  headers.set("ETag", object.httpEtag);
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Exposes only immutable browser-review PNGs from the dedicated evidence
 * bucket. Every other review route continues through the private cookie gate.
 */
export async function handleReviewEvidence(
  request: Request,
  env: ReviewEvidenceEnv,
): Promise<Response | null> {
  if (env.PR_REVIEW_MODE !== "enabled") return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(EVIDENCE_PATH_PREFIX)) return null;

  const key = url.pathname.slice(EVIDENCE_PATH_PREFIX.length);
  if (!EVIDENCE_KEY_PATTERN.test(key)) {
    return errorResponse("Not found", 404);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
      },
    });
  }

  const bucket = env.PR_REVIEW_EVIDENCE_BUCKET;
  if (!bucket) {
    return errorResponse("Review evidence is unavailable", 503);
  }

  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return errorResponse("Not found", 404);
    return new Response(null, {
      status: 200,
      headers: responseHeaders(object),
    });
  }

  const object = await bucket.get(key);
  if (!object) return errorResponse("Not found", 404);
  return new Response(object.body, {
    status: 200,
    headers: responseHeaders(object),
  });
}
