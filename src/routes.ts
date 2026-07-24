import {
  deleteClip,
  deleteClipArtifacts,
  deleteSourceVideoRecords,
  ensureSourceVideo,
  getClipById,
  getSourceVideoById,
  isRetainedUploadSource,
  listClips,
  listClipsByVideoId,
  listSourceVideos,
  setSourceVideoArchived,
  updateSourceVideoDuration,
  sweepStaleClips,
  markGifEncoding,
  outputKeysForClip,
  queueArtifactDeletion,
} from "./db";
import type { Env } from "./env";
import { prewarmEncoder } from "./encoder-pool";
import { JOB_SECRET_HEADER, verifyJobSecret } from "./auth";
import { applyStatusUpdate, dispatchGifExportJob } from "./jobs";
import { recordToResponse, sourceVideoRecordToResponse } from "./serialize";
import type { ClipRecord, ClipStatus, CreateClipRequest } from "./types";
import {
  decodeUploadPathParam,
  generateUploadKey,
  isUploadSourceExpired,
  maxUploadSizeBytes,
  normalizeUploadContentType,
  sweepExpiredUploadSources,
  validateUploadUrlRequest,
} from "./uploads";
import {
  validateCreateClipRequest,
  validateCreateSourceVideoRequest,
} from "./validation";
import {
  handleHelperClaim,
  handleHelperFail,
  handleHelperFulfill,
  sweepAndRecoverHelperClips,
} from "./helper";
import {
  fallbackSourceTitle,
  normalizeClipSource,
} from "./source-videos";
import { drainArtifactDeletions } from "./artifact-deletions";
import { resolveUnresolvedYoutubeTitles } from "./youtube-metadata";
import { createClipForVideo, enqueueClip } from "./clip-service";
import { checkSourceVideoTranscript } from "./video-context";
import {
  MAX_TRANSCRIPT_PADDING_SECONDS,
  MAX_TRANSCRIPT_QUERY_LENGTH,
  MAX_TRANSCRIPT_SEARCH_RESULTS,
  getVideoTranscript,
  searchVideoTranscript,
} from "./transcript-search";

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  ctx.waitUntil(drainArtifactDeletions(env.DB, env.CLIPS_BUCKET));

  if (request.method === "POST" && url.pathname === "/api/clips") {
    return handleCreateClip(request, env, ctx);
  }

  if (request.method === "POST" && url.pathname === "/api/upload-url") {
    return handleRequestUploadUrl(request, env, url, ctx);
  }

  if (request.method === "PUT" && url.pathname.startsWith("/api/uploads/")) {
    const encodedKey = url.pathname.slice("/api/uploads/".length);
    return handleUploadPut(request, env, encodedKey);
  }

  if (request.method === "GET" && url.pathname === "/api/clips") {
    return handleListClips(url, env, ctx);
  }

  if (request.method === "GET" && url.pathname === "/api/videos") {
    return handleListSourceVideos(url, env, ctx);
  }

  if (request.method === "POST" && url.pathname === "/api/videos") {
    return handleCreateSourceVideo(request, env);
  }

  const videoSourceMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/source$/);
  if (request.method === "GET" && videoSourceMatch) {
    return handleSourceVideoSource(request, videoSourceMatch[1], env);
  }

  const videoClipsMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/clips$/);
  if (request.method === "POST" && videoClipsMatch) {
    return handleCreateClipForVideo(
      request,
      videoClipsMatch[1],
      env,
      ctx,
    );
  }

  const transcriptCheckMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript\/check$/,
  );
  if (request.method === "POST" && transcriptCheckMatch) {
    return handleTranscriptCheck(transcriptCheckMatch[1], env);
  }

  const transcriptSearchMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript\/search$/,
  );
  if (request.method === "POST" && transcriptSearchMatch) {
    return handleTranscriptSearch(
      request,
      transcriptSearchMatch[1],
      env,
    );
  }

  const transcriptReadMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && transcriptReadMatch) {
    return handleTranscriptRead(transcriptReadMatch[1], env);
  }

  const videoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
  if (request.method === "GET" && videoMatch) {
    return handleGetSourceVideo(videoMatch[1], env, ctx, url.origin);
  }

  if (request.method === "PATCH" && videoMatch) {
    return handleUpdateSourceVideo(request, videoMatch[1], env);
  }

  if (request.method === "DELETE" && videoMatch) {
    return handleDeleteSourceVideo(videoMatch[1], env);
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

async function handleTranscriptCheck(
  videoId: string,
  env: Env,
): Promise<Response> {
  const existing = await getSourceVideoById(env.DB, videoId);
  if (!existing) {
    return json({ error: "Video not found" }, 404);
  }

  try {
    const video = await checkSourceVideoTranscript(env, videoId);
    if (!video) {
      return json({ error: "Video not found" }, 404);
    }
    return json(sourceVideoRecordToResponse(video, env.R2_PUBLIC_PREFIX));
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Transcript availability check failed",
      },
      502,
    );
  }
}

async function handleTranscriptSearch(
  request: Request,
  videoId: string,
  env: Env,
): Promise<Response> {
  const existing = await getSourceVideoById(env.DB, videoId);
  if (!existing) {
    return json({ error: "Video not found" }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Request body must be an object" }, 400);
  }
  const input = body as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > MAX_TRANSCRIPT_QUERY_LENGTH) {
    return json(
      {
        error: `query must be between 1 and ${MAX_TRANSCRIPT_QUERY_LENGTH} characters`,
      },
      400,
    );
  }

  const optionalNumber = (
    field: string,
    fallback: number,
    maximum: number,
    integer = false,
  ): number | Response => {
    const value = input[field] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > maximum ||
      (integer && !Number.isInteger(value))
    ) {
      return json(
        {
          error: `${field} must be ${integer ? "an integer" : "a number"} between 0 and ${maximum}`,
        },
        400,
      );
    }
    return value;
  };
  const beforeSeconds = optionalNumber(
    "beforeSeconds",
    1,
    MAX_TRANSCRIPT_PADDING_SECONDS,
  );
  if (beforeSeconds instanceof Response) return beforeSeconds;
  const afterSeconds = optionalNumber(
    "afterSeconds",
    2,
    MAX_TRANSCRIPT_PADDING_SECONDS,
  );
  if (afterSeconds instanceof Response) return afterSeconds;
  const limit = optionalNumber(
    "limit",
    20,
    MAX_TRANSCRIPT_SEARCH_RESULTS,
    true,
  );
  if (limit instanceof Response) return limit;
  if (limit < 1) {
    return json({ error: "limit must be at least 1" }, 400);
  }

  try {
    return json(
      await searchVideoTranscript(env, videoId, {
        query,
        beforeSeconds,
        afterSeconds,
        limit,
      }),
    );
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Transcript search failed",
      },
      502,
    );
  }
}

async function handleTranscriptRead(
  videoId: string,
  env: Env,
): Promise<Response> {
  const existing = await getSourceVideoById(env.DB, videoId);
  if (!existing) {
    return json({ error: "Video not found" }, 404);
  }

  try {
    return json(await getVideoTranscript(env, videoId));
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Transcript preparation failed",
      },
      502,
    );
  }
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

  const clipRequest = {
    ...validation.value,
    source: normalizeClipSource(validation.value.source),
  };

  if (clipRequest.source.type === "upload") {
    const uploadKey = clipRequest.source.key;
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
    if (isUploadSourceExpired(object.uploaded, new Date())) {
      return json(
        {
          error: "Upload expired",
          details: [
            {
              field: "source.key",
              message: "Uploaded source has expired; re-upload the file before creating a clip",
            },
          ],
        },
        410,
      );
    }
  }

  return createClipJob(
    clipRequest,
    env,
    ctx,
    new URL(request.url).origin,
  );
}

async function handleCreateClipForVideo(
  request: Request,
  videoId: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await createClipForVideo({
    videoId,
    input: body,
    env,
    origin: new URL(request.url).origin,
    waitUntil: (promise) => ctx.waitUntil(promise),
    idempotencyKey: request.headers.get("Idempotency-Key")?.trim() || undefined,
  });
  return result.ok
    ? json(result.clip, 201)
    : json(
        { error: result.error, ...(result.details ? { details: result.details } : {}) },
        result.status,
      );
}

async function createClipJob(
  clipRequest: CreateClipRequest,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
  videoId?: string,
): Promise<Response> {
  const clip = await enqueueClip({
    clipRequest,
    env,
    origin,
    waitUntil: (promise) => ctx.waitUntil(promise),
    videoId,
  });
  return json(clip, 201);
}

async function handleSourceVideoSource(
  request: Request,
  videoId: string,
  env: Env,
): Promise<Response> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    return json({ error: "Video not found" }, 404);
  }
  const sourceKey =
    video.source_type === "upload"
      ? video.source_ref
      : video.retained_source_status === "ready"
        ? video.retained_source_key
        : null;
  if (!sourceKey) {
    return json({ error: "Retained video source is not ready" }, 409);
  }

  const rangeHeader = request.headers.get("range");
  const object = await env.CLIPS_BUCKET.get(
    sourceKey,
    rangeHeader ? { range: request.headers } : undefined,
  );
  if (!object) {
    return json({ error: "Video source unavailable" }, 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "bytes");

  const range = rangeHeader
    ? resolveR2Range(object.range, object.size)
    : null;
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set("content-length", String(range.length));
  }

  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function resolveR2Range(
  range: R2Range | undefined,
  objectSize: number,
): { offset: number; length: number } | null {
  if (!range) {
    return null;
  }
  if ("suffix" in range && typeof range.suffix === "number") {
    const length = Math.min(range.suffix, objectSize);
    return { offset: objectSize - length, length };
  }

  const offset =
    "offset" in range && typeof range.offset === "number" ? range.offset : 0;
  const length =
    "length" in range && typeof range.length === "number"
      ? range.length
      : objectSize - offset;
  return { offset, length };
}

async function handleListSourceVideos(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "", 10) || 0, 0);
  const archived = url.searchParams.get("archived") === "true";

  await sweepAndRecoverHelperClips(env, url.origin, ctx);
  await sweepStaleClips(env.DB);
  const { videos, total } = await listSourceVideos(
    env.DB,
    limit,
    offset,
    archived,
  );
  const titledVideos = await resolveUnresolvedYoutubeTitles(
    env.DB,
    videos,
    Number(env.YOUTUBE_TITLE_TIMEOUT_MS) || undefined,
  );

  return json({
    videos: titledVideos.map((video) =>
      sourceVideoRecordToResponse(video, env.R2_PUBLIC_PREFIX),
    ),
    total,
    limit,
    offset,
  });
}

async function handleCreateSourceVideo(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const validation = validateCreateSourceVideoRequest(body);
  if (!validation.ok) {
    return json(
      {
        error: "Invalid video source",
        details: validation.errors,
      },
      400,
    );
  }

  const source = normalizeClipSource(validation.value.source);
  const sourceTitle =
    validation.value.title ||
    fallbackSourceTitle(source, "Uploaded video");
  const videoId = await ensureSourceVideo(env.DB, {
    source,
    title: sourceTitle,
    updateUploadTitle: Boolean(
      validation.value.title && source.type === "upload",
    ),
  });
  if (validation.value.durationSeconds !== undefined) {
    await updateSourceVideoDuration(
      env.DB,
      videoId,
      validation.value.durationSeconds,
    );
  }
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    return json({ error: "Failed to create video" }, 500);
  }
  return json(sourceVideoRecordToResponse(video, env.R2_PUBLIC_PREFIX));
}

async function handleUpdateSourceVideo(
  request: Request,
  videoId: string,
  env: Env,
): Promise<Response> {
  if (!videoId) {
    return json({ error: "Video id is required" }, 400);
  }

  let body: { archived?: unknown; durationSeconds?: unknown };
  try {
    body = (await request.json()) as {
      archived?: unknown;
      durationSeconds?: unknown;
    };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const hasArchived = body.archived !== undefined;
  const hasDuration = body.durationSeconds !== undefined;
  if (!hasArchived && !hasDuration) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "body",
            message: "archived or durationSeconds is required",
          },
        ],
      },
      400,
    );
  }
  if (hasArchived && typeof body.archived !== "boolean") {
    return json(
      {
        error: "Validation failed",
        details: [{ field: "archived", message: "archived must be a boolean" }],
      },
      400,
    );
  }
  if (
    hasDuration &&
    (typeof body.durationSeconds !== "number" ||
      !Number.isFinite(body.durationSeconds) ||
      body.durationSeconds <= 0)
  ) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "durationSeconds",
            message: "durationSeconds must be a positive finite number",
          },
        ],
      },
      400,
    );
  }

  const updates: boolean[] = [];
  if (hasArchived) {
    updates.push(
      await setSourceVideoArchived(env.DB, videoId, body.archived as boolean),
    );
  }
  if (hasDuration) {
    updates.push(
      await updateSourceVideoDuration(
        env.DB,
        videoId,
        body.durationSeconds as number,
      ),
    );
  }
  const updated = updates.some(Boolean);
  if (!updated) {
    return json({ error: "Video not found" }, 404);
  }
  const video = await getSourceVideoById(env.DB, videoId);
  return json(sourceVideoRecordToResponse(video!, env.R2_PUBLIC_PREFIX));
}

async function handleDeleteSourceVideo(
  videoId: string,
  env: Env,
): Promise<Response> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video) {
    return json({ error: "Video not found" }, 404);
  }
  let deleted: boolean;
  try {
    deleted = await deleteSourceVideoRecords(env.DB, videoId);
  } catch (error) {
    console.error("Failed to delete video records", error);
    return json({ error: "Unable to delete video" }, 500);
  }
  if (!deleted) {
    return json({ error: "Video not found" }, 404);
  }
  await drainArtifactDeletions(env.DB, env.CLIPS_BUCKET);
  return new Response(null, { status: 204 });
}

async function handleGetSourceVideo(
  videoId: string,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  if (!videoId) {
    return json({ error: "Video id is required" }, 400);
  }

  await sweepAndRecoverHelperClips(env, origin, ctx);
  await sweepStaleClips(env.DB);
  const [video, clips] = await Promise.all([
    getSourceVideoById(env.DB, videoId),
    listClipsByVideoId(env.DB, videoId),
  ]);

  if (!video) {
    return json({ error: "Video not found" }, 404);
  }
  const [titledVideo] = await resolveUnresolvedYoutubeTitles(
    env.DB,
    [video],
    Number(env.YOUTUBE_TITLE_TIMEOUT_MS) || undefined,
  );

  return json({
    video: sourceVideoRecordToResponse(titledVideo, env.R2_PUBLIC_PREFIX),
    clips: clips.map((clip) =>
      recordToResponse(clip, env.R2_PUBLIC_PREFIX),
    ),
  });
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
  ctx.waitUntil(
    sweepExpiredUploadSources(env.CLIPS_BUCKET, {
      shouldRetain: (key) => isRetainedUploadSource(env.DB, key),
    }),
  );
  const { clips, total } = await listClips(env.DB, limit, offset);
  const prefix = env.R2_PUBLIC_PREFIX;

  return json({
    clips: clips.map((record) => recordToResponse(record, prefix)),
    total,
    limit,
    offset,
  });
}

async function handleDeleteClip(
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

  const deleted = await deleteClip(env.DB, clipId);
  if (!deleted) {
    return json({ error: "Clip not found" }, 404);
  }

  await drainArtifactDeletions(env.DB, env.CLIPS_BUCKET);
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
  ctx: ExecutionContext,
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

  ctx.waitUntil(
    prewarmEncoder(env).catch((error) => {
      console.warn(
        "Encoder pre-warm failed:",
        error instanceof Error ? error.message : error,
      );
    }),
  );

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

  const clipStillExists = await getClipById(env.DB, clipId);
  if (!clipStillExists) {
    await queueArtifactDeletion(env.DB, objectKey);
    await drainArtifactDeletions(env.DB, env.CLIPS_BUCKET);
    return json({ error: "Clip was deleted during artifact upload" }, 410);
  }

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
