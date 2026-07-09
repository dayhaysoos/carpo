import {
  deleteClip,
  deleteClipArtifacts,
  getClipById,
  insertClip,
  listClips,
  sweepStaleClips,
  markGifEncoding,
  outputKeysForClip,
} from "./db";
import type { Env } from "./env";
import { JOB_SECRET_HEADER, verifyJobSecret } from "./auth";
import { applyStatusUpdate, dispatchEncodingJob, dispatchGifExportJob } from "./jobs";
import { recordToResponse } from "./serialize";
import type { ClipRecord, ClipStatus } from "./types";
import {
  decodeUploadPathParam,
  generateUploadKey,
  maxUploadSizeBytes,
  normalizeUploadContentType,
  validateUploadUrlRequest,
} from "./uploads";
import { validateCreateClipRequest } from "./validation";
import {
  handleHelperClaim,
  handleHelperFail,
  handleHelperFulfill,
  isHelperEnabled,
  scheduleHelperClaimWindowFallback,
  sweepAndRecoverHelperClips,
} from "./helper";

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/clips") {
    return handleCreateClip(request, env, ctx);
  }

  if (request.method === "POST" && url.pathname === "/api/upload-url") {
    return handleRequestUploadUrl(request, env, url);
  }

  if (request.method === "PUT" && url.pathname.startsWith("/api/uploads/")) {
    const encodedKey = url.pathname.slice("/api/uploads/".length);
    return handleUploadPut(request, env, encodedKey);
  }

  if (request.method === "GET" && url.pathname === "/api/clips") {
    return handleListClips(url, env, ctx);
  }

  if (request.method === "POST" && url.pathname === "/api/helper/claim") {
    return handleHelperClaim(request, env);
  }

  const helperFulfillMatch = url.pathname.match(
    /^\/api\/helper\/jobs\/([^/]+)\/fulfill$/,
  );
  if (request.method === "POST" && helperFulfillMatch) {
    return handleHelperFulfill(
      request,
      helperFulfillMatch[1],
      env,
      ctx,
      url.origin,
    );
  }

  const helperFailMatch = url.pathname.match(
    /^\/api\/helper\/jobs\/([^/]+)\/fail$/,
  );
  if (request.method === "POST" && helperFailMatch) {
    return handleHelperFail(
      request,
      helperFailMatch[1],
      env,
      ctx,
      url.origin,
    );
  }

  if (
    request.method === "POST" &&
    url.pathname.startsWith("/api/clips/") &&
    url.pathname.endsWith("/gif")
  ) {
    const clipId = url.pathname.slice("/api/clips/".length, -"/gif".length);
    return handleRequestGifExport(clipId, env, ctx);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/clips/")) {
    const clipId = url.pathname.slice("/api/clips/".length);
    return handleGetClip(clipId, env, ctx, url.origin);
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/clips/")) {
    const clipId = url.pathname.slice("/api/clips/".length);
    return handleDeleteClip(clipId, env);
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

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/api/internal/jobs/") &&
    url.pathname.endsWith("/source")
  ) {
    const clipId = url.pathname.slice("/api/internal/jobs/".length, -"/source".length);
    return handleInternalSourceFetch(request, clipId, env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    return handleArtifactRequest(url.pathname.slice("/artifacts/".length), env);
  }

  return env.ASSETS.fetch(request);
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

  if (validation.value.source.type === "upload") {
    const uploadKey = validation.value.source.key;
    const object = await env.CLIPS_BUCKET.head(uploadKey);
    if (!object) {
      return json(
        {
          error: "Upload not found",
          details: [
            {
              field: "source.key",
              message: "Uploaded source object was not found; upload the file before creating a clip",
            },
          ],
        },
        404,
      );
    }
  }

  const clipId = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  const useHelper =
    isHelperEnabled(env) && validation.value.source.type === "youtube";
  const record = await insertClip(
    env.DB,
    clipId,
    validation.value,
    useHelper ? { helperState: "pending" } : undefined,
  );

  if (useHelper) {
    ctx.waitUntil(
      scheduleHelperClaimWindowFallback(env, clipId, origin, ctx),
    );
  } else {
    ctx.waitUntil(
      dispatchEncodingJob(env, clipId, validation.value, origin),
    );
  }

  return json(recordToResponse(record, env.R2_PUBLIC_PREFIX), 201);
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

async function handleListClips(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "", 10) || 0, 0);

  await sweepAndRecoverHelperClips(env, url.origin, ctx);
  await sweepStaleClips(env.DB);
  const { clips, total } = await listClips(env.DB, limit, offset);
  const prefix = env.R2_PUBLIC_PREFIX;

  return json({
    clips: clips.map((record) => recordToResponse(record, prefix)),
    total,
    limit,
    offset,
  });
}

async function handleDeleteClip(clipId: string, env: Env): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  await deleteClipArtifacts(env.CLIPS_BUCKET, clipId, record);
  const deleted = await deleteClip(env.DB, clipId);
  if (!deleted) {
    return json({ error: "Clip not found" }, 404);
  }

  return new Response(null, { status: 204 });
}

async function handleGetClip(
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  await sweepAndRecoverHelperClips(env, origin, ctx);
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  return json(recordToResponse(record, env.R2_PUBLIC_PREFIX));
}

async function handleRequestGifExport(
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  if (record.status !== "complete") {
    return json(
      {
        error: "Clip is not complete",
        details: [
          {
            field: "status",
            message: "GIF export is only available for completed clips",
          },
        ],
      },
      409,
    );
  }

  if (record.gif_status === "complete" && record.output_gif_key) {
    return json(recordToResponse(record, env.R2_PUBLIC_PREFIX));
  }

  if (record.gif_status === "encoding") {
    return json(recordToResponse(record, env.R2_PUBLIC_PREFIX));
  }

  const started = await markGifEncoding(env.DB, clipId);
  if (!started) {
    const latest = await getClipById(env.DB, clipId);
    if (!latest) {
      return json({ error: "Clip not found" }, 404);
    }
    return json(recordToResponse(latest, env.R2_PUBLIC_PREFIX));
  }

  ctx.waitUntil(dispatchGifExportJob(env, clipId));

  const updated = await getClipById(env.DB, clipId);
  return json(recordToResponse(updated!, env.R2_PUBLIC_PREFIX), 202);
}

async function handleRequestUploadUrl(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const maxSizeBytes = maxUploadSizeBytes(env);
  const validation = validateUploadUrlRequest(body, maxSizeBytes);
  if (!validation.ok) {
    return json({ error: "Validation failed", details: validation.errors }, 400);
  }

  const key = generateUploadKey(validation.value.contentType);
  const uploadUrl = `${url.origin}/api/uploads/${encodeURIComponent(key)}`;

  return json({
    key,
    uploadUrl,
    maxSizeBytes,
    contentType: validation.value.contentType,
    method: "PUT",
  });
}

async function handleUploadPut(
  request: Request,
  env: Env,
  encodedKey: string,
): Promise<Response> {
  const key = decodeUploadPathParam(encodedKey);
  if (!key) {
    return json({ error: "Invalid upload key" }, 400);
  }

  const maxSizeBytes = maxUploadSizeBytes(env);
  const declaredLength = parseContentLength(request.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > maxSizeBytes) {
    return json(
      {
        error: "File too large",
        details: [
          {
            field: "Content-Length",
            message: `Upload exceeds maximum size of ${Math.round(maxSizeBytes / (1024 * 1024))}MB`,
          },
        ],
      },
      413,
    );
  }

  const rawContentType = request.headers.get("Content-Type") ?? "";
  const contentType = normalizeUploadContentType(rawContentType);
  if (!contentType) {
    return json(
      {
        error: "Unsupported content type",
        details: [
          {
            field: "Content-Type",
            message: "Only mp4, webm, mov, and mkv video uploads are accepted",
          },
        ],
      },
      415,
    );
  }

  if (!request.body) {
    return json({ error: "Request body is required" }, 400);
  }

  await env.CLIPS_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
  });

  const stored = await env.CLIPS_BUCKET.head(key);
  if (!stored) {
    return json({ error: "Upload failed" }, 500);
  }
  if (stored.size > maxSizeBytes) {
    await env.CLIPS_BUCKET.delete(key);
    return json(
      {
        error: "File too large",
        details: [
          {
            field: "sizeBytes",
            message: `Upload exceeds maximum size of ${Math.round(maxSizeBytes / (1024 * 1024))}MB`,
          },
        ],
      },
      413,
    );
  }

  return json({ key, sizeBytes: stored.size, contentType }, 201);
}

async function handleInternalSourceFetch(
  request: Request,
  clipId: string,
  env: Env,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  const authError = verifyInternalJobAuth(request, record);
  if (authError) {
    return authError;
  }

  if (record.source_type !== "upload") {
    return json({ error: "Clip source is not an upload" }, 400);
  }

  const object = await env.CLIPS_BUCKET.get(record.source_ref);
  if (!object) {
    return new Response("Upload source not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");

  return new Response(object.body, { headers });
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

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
