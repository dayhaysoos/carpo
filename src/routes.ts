import { getClipById, insertClip, outputKeysForClip } from "./db";
import type { Env } from "./env";
import { JOB_SECRET_HEADER, verifyJobSecret } from "./auth";
import { applyStatusUpdate, dispatchEncodingJob } from "./jobs";
import { recordToResponse } from "./serialize";
import type { ClipRecord, ClipStatus } from "./types";
import { validateCreateClipRequest } from "./validation";

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/clips") {
    return handleCreateClip(request, env, ctx);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/clips/")) {
    const clipId = url.pathname.slice("/api/clips/".length);
    return handleGetClip(clipId, env);
  }

  if (
    request.method === "POST" &&
    url.pathname.startsWith("/api/internal/jobs/") &&
    url.pathname.endsWith("/status")
  ) {
    const parts = url.pathname.split("/");
    const clipId = parts[4];
    return handleInternalStatusUpdate(request, clipId, env);
  }

  if (
    request.method === "PUT" &&
    url.pathname.startsWith("/api/internal/jobs/") &&
    url.pathname.includes("/artifacts/")
  ) {
    return handleInternalArtifactUpload(request, url.pathname, env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    return handleArtifactRequest(url.pathname.slice("/artifacts/".length), env);
  }

  if (url.pathname === "/" || url.pathname.startsWith("/assets")) {
    return env.ASSETS.fetch(request);
  }

  return json({ error: "Not found" }, 404);
}

async function handleCreateClip(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const maxClipLength = Number(env.MAX_CLIP_LENGTH_SECONDS) || 60;
  const validation = validateCreateClipRequest(body, maxClipLength);
  if (!validation.ok) {
    return json({ error: "Validation failed", details: validation.errors }, 400);
  }

  const clipId = crypto.randomUUID();
  const record = await insertClip(env.DB, clipId, validation.value);

  ctx.waitUntil(
    dispatchEncodingJob(env, clipId, validation.value, new URL(request.url).origin),
  );

  return json(recordToResponse(record, env.R2_PUBLIC_PREFIX), 201);
}

async function handleGetClip(clipId: string, env: Env): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  return json(recordToResponse(record, env.R2_PUBLIC_PREFIX));
}

async function handleInternalArtifactUpload(
  request: Request,
  pathname: string,
  env: Env,
): Promise<Response> {
  const match = pathname.match(
    /^\/api\/internal\/jobs\/([^/]+)\/artifacts\/(mp4|thumbnail)$/,
  );
  if (!match) {
    return json({ error: "Invalid artifact path" }, 400);
  }

  const clipId = match[1];
  const artifactType = match[2];
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  const authError = verifyInternalJobAuth(request, record);
  if (authError) {
    return authError;
  }

  const keys = outputKeysForClip(clipId);
  const objectKey = artifactType === "mp4" ? keys.mp4Key : keys.thumbnailKey;
  const contentType =
    artifactType === "mp4" ? "video/mp4" : "image/jpeg";

  await env.CLIPS_BUCKET.put(objectKey, request.body, {
    httpMetadata: { contentType },
  });

  return new Response(null, { status: 204 });
}

async function handleInternalStatusUpdate(
  request: Request,
  clipId: string,
  env: Env,
): Promise<Response> {
  let body: { status?: ClipStatus; errorMessage?: string | null };
  try {
    body = (await request.json()) as {
      status?: ClipStatus;
      errorMessage?: string | null;
    };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.status) {
    return json({ error: "status is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  const authError = verifyInternalJobAuth(request, record);
  if (authError) {
    return authError;
  }

  await applyStatusUpdate(env, clipId, body.status, body.errorMessage ?? null);
  const updated = await getClipById(env.DB, clipId);
  return json(recordToResponse(updated!, env.R2_PUBLIC_PREFIX));
}

async function handleArtifactRequest(key: string, env: Env): Promise<Response> {
  const object = await env.CLIPS_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
}

function verifyInternalJobAuth(
  request: Request,
  record: ClipRecord,
): Response | null {
  const provided = request.headers.get(JOB_SECRET_HEADER);
  if (!verifyJobSecret(provided, record.callback_secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
