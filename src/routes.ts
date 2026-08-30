import {
  deleteClip,
  deleteClipArtifacts,
  deleteSourceVideoRecords,
  ensureSourceVideo,
  getClipById,
  getClipByIdForOwner,
  getSourceVideoById,
  getSourceVideoByIdForOwner,
  isRetainedUploadSource,
  isOwnedUploadSource,
  listClips,
  listClipsByVideoId,
  listClipsByVideoIdForOwner,
  listSourceVideos,
  setSourceVideoArchived,
  updateSourceVideoDuration,
  sweepStaleClips,
  outputKeysForClip,
  queueArtifactDeletion,
} from "./db";
import type { Env } from "./env";
import type { AuthenticatedUser } from "./identity";
import { isMachineRequest, LEGACY_USER_ID } from "./identity";
import { prewarmEncoder } from "./encoder-pool";
import {
  HELPER_TOKEN_HEADER,
  JOB_SECRET_HEADER,
  verifyHelperToken,
  verifyJobSecret,
} from "./auth";
import {
  applyStatusUpdate,
  dispatchCaptionRenderJob,
  dispatchGifExportJob,
} from "./jobs";
import { recordToResponse, sourceVideoRecordToResponse } from "./serialize";
import type { ClipRecord, ClipStatus, CreateClipRequest } from "./types";
import {
  decodeUploadPathParam,
  generateUploadKey,
  isUploadSourceExpired,
  isOwnedUploadKey,
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
  requestVideoTranscript,
  searchVideoTranscript,
} from "./transcript-search";
import {
  CaptionTrackError,
  beginCaptionRender,
  exportCaptionTrack,
  ownsCaptionedArtifact,
  saveCaptionTrack,
  validateCaptionTrackProposal,
  viewCaptionTrack,
} from "./caption-tracks";
import {
  LibraryDiscoveryError,
  MAX_LIBRARY_SEARCH_QUERY_LENGTH,
  MAX_LIBRARY_SEARCH_RESULTS,
  prepareLibraryMomentReview,
  readPreparedLibraryMomentReview,
  searchPrivateLibrary,
  type LibrarySearchMode,
  type PrepareLibraryMomentInput,
} from "./library-discovery";
import {
  MAX_VISUAL_QUERY_LENGTH,
  visualDiscovery,
  VisualDiscoveryError,
  type PrepareVisualMomentInput,
} from "./visual-discovery";
import { handleClipDistributionApi } from "./clip-distribution-http";
import {
  ClipDistribution,
  ClipDistributionError,
} from "./clip-distribution";
import { R2MediaDelivery } from "./r2-media-delivery";

const MAX_CAPTION_TRACK_BODY_BYTES = 128 * 1024;

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser | null,
): Promise<Response> {
  const url = new URL(request.url);
  ctx.waitUntil(drainArtifactDeletions(env.DB, env.CLIPS_BUCKET));

  if (!user && !isMachineRequest(request)) {
    return json({ error: "Authentication required" }, 401);
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({ email: user!.id === LEGACY_USER_ID ? null : user!.email });
  }

  if (request.method === "POST" && url.pathname === "/api/clips") {
    return handleCreateClip(request, env, ctx, user!);
  }

  if (request.method === "POST" && url.pathname === "/api/upload-url") {
    return handleRequestUploadUrl(request, env, url, ctx, user);
  }

  if (request.method === "PUT" && url.pathname.startsWith("/api/uploads/")) {
    const encodedKey = url.pathname.slice("/api/uploads/".length);
    return handleUploadPut(request, env, encodedKey, user);
  }

  if (request.method === "GET" && url.pathname === "/api/clips") {
    return handleListClips(url, env, ctx, user!);
  }

  const distributionResponse = await handleClipDistributionApi(
    request,
    env,
    ctx,
    user!,
  );
  if (distributionResponse) return distributionResponse;

  if (request.method === "GET" && url.pathname === "/api/videos") {
    return handleListSourceVideos(url, env, ctx, user!);
  }

  if (request.method === "POST" && url.pathname === "/api/videos") {
    return handleCreateSourceVideo(request, env, user!);
  }

  if (request.method === "POST" && url.pathname === "/api/library/search") {
    return handleLibrarySearch(request, env, user!);
  }

  if (request.method === "POST" && url.pathname === "/api/library/moments") {
    return handlePrepareLibraryMoment(request, env, user!);
  }

  const visualSearchMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/visual-search$/,
  );
  if (request.method === "POST" && visualSearchMatch) {
    return handleVisualSearch(request, visualSearchMatch[1], env, user!);
  }

  if (request.method === "POST" && url.pathname === "/api/visual-moments") {
    return handlePrepareVisualMoment(request, env, user!);
  }

  const visualMomentMatch = url.pathname.match(
    /^\/api\/visual-moments\/([^/]+)$/,
  );
  if (request.method === "GET" && visualMomentMatch) {
    return handleReadVisualMoment(visualMomentMatch[1], env, user!);
  }

  const visualEvidenceMatch = url.pathname.match(
    /^\/api\/visual-evidence\/([^/]+)$/,
  );
  if (request.method === "GET" && visualEvidenceMatch) {
    return handleVisualEvidence(visualEvidenceMatch[1], env, user!);
  }

  const libraryMomentMatch = url.pathname.match(
    /^\/api\/library\/moments\/([^/]+)$/,
  );
  if (request.method === "GET" && libraryMomentMatch) {
    return handleReadLibraryMoment(libraryMomentMatch[1], env, user!);
  }

  const videoSourceMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/source$/);
  if (request.method === "GET" && videoSourceMatch) {
    return handleSourceVideoSource(request, videoSourceMatch[1], env, user!);
  }

  const videoClipsMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/clips$/);
  if (request.method === "POST" && videoClipsMatch) {
    return handleCreateClipForVideo(
      request,
      videoClipsMatch[1],
      env,
      ctx,
      user!,
    );
  }

  const transcriptCheckMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript\/check$/,
  );
  if (request.method === "POST" && transcriptCheckMatch) {
    return handleTranscriptCheck(transcriptCheckMatch[1], env, user!);
  }

  const transcriptSearchMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript\/search$/,
  );
  if (request.method === "POST" && transcriptSearchMatch) {
    return handleTranscriptSearch(
      request,
      transcriptSearchMatch[1],
      env,
      user!,
    );
  }

  const transcriptReadMatch = url.pathname.match(
    /^\/api\/videos\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && transcriptReadMatch) {
    return handleTranscriptRead(transcriptReadMatch[1], env, user!);
  }

  const videoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
  if (request.method === "GET" && videoMatch) {
    return handleGetSourceVideo(videoMatch[1], env, ctx, url.origin, user!);
  }

  if (request.method === "PATCH" && videoMatch) {
    return handleUpdateSourceVideo(request, videoMatch[1], env, user!);
  }

  if (request.method === "DELETE" && videoMatch) {
    return handleDeleteSourceVideo(videoMatch[1], env, user!);
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
    return handleRequestGifExport(clipId, env, ctx, user!);
  }

  const captionExportMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/captions\.(vtt|srt)$/,
  );
  if (request.method === "GET" && captionExportMatch) {
    return handleCaptionTrackExport(
      captionExportMatch[1],
      captionExportMatch[2] as "vtt" | "srt",
      env,
      user!,
    );
  }

  const captionProposalMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/captions\/proposals$/,
  );
  if (request.method === "POST" && captionProposalMatch) {
    return handleCaptionTrackProposal(
      request,
      captionProposalMatch[1],
      env,
      user!,
    );
  }

  const captionRenderMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/captions\/render$/,
  );
  if (request.method === "POST" && captionRenderMatch) {
    return handleCaptionTrackRender(
      captionRenderMatch[1],
      env,
      ctx,
      user!,
    );
  }

  const captionTrackMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/captions$/,
  );
  if (request.method === "GET" && captionTrackMatch) {
    return handleCaptionTrackRead(captionTrackMatch[1], env, user!);
  }
  if (request.method === "PUT" && captionTrackMatch) {
    return handleCaptionTrackSave(request, captionTrackMatch[1], env, user!);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/clips/")) {
    const clipId = url.pathname.slice("/api/clips/".length);
    return handleGetClip(clipId, env, ctx, url.origin, user!);
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/clips/")) {
    const clipId = url.pathname.slice("/api/clips/".length);
    return handleDeleteClip(clipId, env, user!);
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
    return handleArtifactRequest(
      url.pathname.slice("/artifacts/".length),
      env,
      user!,
    );
  }

  return env.ASSETS.fetch(request);
}

async function readObjectBody(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be an object" }, 400);
  }
  return body as Record<string, unknown>;
}

async function handleLibrarySearch(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const mode = body.mode;
  const archived = body.archived ?? false;
  const limit = body.limit ?? 10;
  if (!query || query.length > MAX_LIBRARY_SEARCH_QUERY_LENGTH) {
    return json(
      {
        error: `query must be between 1 and ${MAX_LIBRARY_SEARCH_QUERY_LENGTH} characters`,
      },
      400,
    );
  }
  if (mode !== "exact" && mode !== "meaning") {
    return json({ error: "mode must be exact or meaning" }, 400);
  }
  if (typeof archived !== "boolean") {
    return json({ error: "archived must be a boolean" }, 400);
  }
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_LIBRARY_SEARCH_RESULTS
  ) {
    return json(
      { error: `limit must be an integer between 1 and ${MAX_LIBRARY_SEARCH_RESULTS}` },
      400,
    );
  }
  try {
    return json(
      await searchPrivateLibrary(env, user.id, {
        query,
        mode: mode as LibrarySearchMode,
        archived,
        limit: limit as number,
      }),
    );
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Library search failed",
      },
      502,
    );
  }
}

function prepareLibraryMomentInput(
  body: Record<string, unknown>,
): PrepareLibraryMomentInput | null {
  const mode = body.mode;
  const blockIds = body.blockIds;
  if (
    typeof body.resultId !== "string" ||
    (mode !== "exact" && mode !== "meaning") ||
    typeof body.query !== "string" ||
    typeof body.videoId !== "string" ||
    typeof body.transcriptRevision !== "string" ||
    typeof body.videoRevision !== "string" ||
    typeof body.evidenceStartSeconds !== "number" ||
    !Number.isFinite(body.evidenceStartSeconds) ||
    typeof body.evidenceEndSeconds !== "number" ||
    !Number.isFinite(body.evidenceEndSeconds) ||
    !Array.isArray(blockIds) ||
    !blockIds.every((blockId) => typeof blockId === "string")
  ) {
    return null;
  }
  return {
    resultId: body.resultId,
    mode,
    query: body.query,
    videoId: body.videoId,
    transcriptRevision: body.transcriptRevision,
    videoRevision: body.videoRevision,
    blockIds,
    evidenceStartSeconds: body.evidenceStartSeconds,
    evidenceEndSeconds: body.evidenceEndSeconds,
  };
}

function libraryDiscoveryErrorResponse(error: unknown): Response {
  if (!(error instanceof LibraryDiscoveryError)) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Library proposal could not be prepared",
      },
      502,
    );
  }
  const status =
    error.code === "RESULT_NOT_FOUND"
      ? 404
      : error.code === "RESULT_EXPIRED"
        ? 410
        : error.code === "STALE_RESULT"
          ? 409
          : 400;
  return json({ error: error.message, code: error.code }, status);
}

async function handlePrepareLibraryMoment(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;
  const input = prepareLibraryMomentInput(body);
  if (!input) {
    return json({ error: "Invalid Library result" }, 400);
  }
  try {
    return json(await prepareLibraryMomentReview(env, user.id, input), 201);
  } catch (error) {
    return libraryDiscoveryErrorResponse(error);
  }
}

async function handleReadLibraryMoment(
  encodedProposalId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  let proposalId: string;
  try {
    proposalId = decodeURIComponent(encodedProposalId);
  } catch {
    return json({ error: "Invalid Library proposal id" }, 400);
  }
  try {
    return json(await readPreparedLibraryMomentReview(env, user.id, proposalId));
  } catch (error) {
    return libraryDiscoveryErrorResponse(error);
  }
}

function visualDiscoveryErrorResponse(error: unknown): Response {
  if (!(error instanceof VisualDiscoveryError)) {
    return json(
      { error: error instanceof Error ? error.message : "Visual search failed" },
      502,
    );
  }
  const status =
    error.code === "SOURCE_NOT_FOUND" || error.code === "RESULT_NOT_FOUND"
      ? 404
      : error.code === "RESULT_EXPIRED"
        ? 410
        : error.code === "STALE_RESULT"
          ? 409
          : 400;
  return json({ error: error.message, code: error.code }, status);
}

async function handleVisualSearch(
  request: Request,
  encodedVideoId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > MAX_VISUAL_QUERY_LENGTH) {
    return json(
      { error: `query must be between 1 and ${MAX_VISUAL_QUERY_LENGTH} characters` },
      400,
    );
  }
  try {
    return json(
      await visualDiscovery.view(env, user.id, {
        videoId: decodeURIComponent(encodedVideoId),
        query,
      }),
    );
  } catch (error) {
    return visualDiscoveryErrorResponse(error);
  }
}

function prepareVisualMomentInput(
  body: Record<string, unknown>,
): PrepareVisualMomentInput | null {
  if (
    typeof body.resultId !== "string" ||
    typeof body.query !== "string" ||
    typeof body.videoId !== "string" ||
    typeof body.sourceRevision !== "string" ||
    !Array.isArray(body.observationIds) ||
    !body.observationIds.every((item) => typeof item === "string") ||
    typeof body.startSeconds !== "number" ||
    !Number.isFinite(body.startSeconds) ||
    typeof body.endSeconds !== "number" ||
    !Number.isFinite(body.endSeconds)
  ) {
    return null;
  }
  return {
    resultId: body.resultId,
    query: body.query,
    videoId: body.videoId,
    sourceRevision: body.sourceRevision,
    observationIds: body.observationIds,
    startSeconds: body.startSeconds,
    endSeconds: body.endSeconds,
  };
}

async function handlePrepareVisualMoment(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;
  const input = prepareVisualMomentInput(body);
  if (!input) return json({ error: "Invalid visual result" }, 400);
  try {
    return json(await visualDiscovery.perform(env, user.id, input), 201);
  } catch (error) {
    return visualDiscoveryErrorResponse(error);
  }
}

async function handleReadVisualMoment(
  encodedProposalId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  try {
    return json(
      await visualDiscovery.dossier(
        env,
        user.id,
        decodeURIComponent(encodedProposalId),
      ),
    );
  } catch (error) {
    return visualDiscoveryErrorResponse(error);
  }
}

async function handleVisualEvidence(
  encodedObservationId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  let observationId: string;
  try {
    observationId = decodeURIComponent(encodedObservationId);
  } catch {
    return json({ error: "Invalid visual evidence id" }, 400);
  }
  const row = await env.DB.prepare(
    `SELECT frame_key FROM visual_frame_observations
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(observationId, user.id)
    .first<{ frame_key: string }>();
  if (!row) return json({ error: "Visual evidence not found" }, 404);
  const object = await env.CLIPS_BUCKET.get(row.frame_key);
  if (!object || !object.body) {
    return json({ error: "Visual evidence not found" }, 404);
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleTranscriptCheck(
  videoId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const existing = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
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
  user: AuthenticatedUser,
): Promise<Response> {
  const existing = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
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
    const result = await searchVideoTranscript(env, videoId, {
      query,
      beforeSeconds,
      afterSeconds,
      limit,
    });
    return json(result, result.transcriptStatus === "checking" ? 202 : 200);
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
  user: AuthenticatedUser,
): Promise<Response> {
  const existing = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
  if (!existing) {
    return json({ error: "Video not found" }, 404);
  }

  try {
    const transcript = await requestVideoTranscript(env, videoId);
    return json(
      transcript,
      transcript.transcriptStatus === "checking" ? 202 : 200,
    );
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
  user: AuthenticatedUser,
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
    const ownsUpload =
      isOwnedUploadKey(uploadKey, user.id) ||
      (await isOwnedUploadSource(env.DB, uploadKey, user.id));
    if (!ownsUpload) {
      return json({ error: "Upload not found" }, 404);
    }
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
    user,
  );
}

async function handleCreateClipForVideo(
  request: Request,
  videoId: string,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await createClipForVideo({
    ownerId: user.id,
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
  user: AuthenticatedUser,
  videoId?: string,
): Promise<Response> {
  const clip = await enqueueClip({
    ownerId: user.id,
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
  user: AuthenticatedUser,
): Promise<Response> {
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
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

  const outcome = await new R2MediaDelivery(env.CLIPS_BUCKET).deliver({
    key: sourceKey,
    method: "GET",
    range: request.headers.get("Range"),
  });
  if (outcome.type === "missing") {
    return json({ error: "Video source unavailable" }, 404);
  }
  if (outcome.type === "range-not-satisfiable") {
    const response = json({ error: "Requested range is unavailable" }, 416);
    outcome.headers.forEach((value, name) => response.headers.set(name, value));
    return response;
  }
  return outcome.response;
}

async function handleListSourceVideos(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser,
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
    user.id,
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
  user: AuthenticatedUser,
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
  if (
    source.type === "upload" &&
    !isOwnedUploadKey(source.key, user.id) &&
    !(await isOwnedUploadSource(env.DB, source.key, user.id))
  ) {
    return json({ error: "Upload not found" }, 404);
  }

  const videoId = await ensureSourceVideo(env.DB, user.id, {
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
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
  if (!video) {
    return json({ error: "Failed to create video" }, 500);
  }
  return json(sourceVideoRecordToResponse(video, env.R2_PUBLIC_PREFIX));
}

async function handleUpdateSourceVideo(
  request: Request,
  videoId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  if (!videoId) {
    return json({ error: "Video id is required" }, 400);
  }

  const existing = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
  if (!existing) {
    return json({ error: "Video not found" }, 404);
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
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
  return json(sourceVideoRecordToResponse(video!, env.R2_PUBLIC_PREFIX));
}

async function handleDeleteSourceVideo(
  videoId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
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
  user: AuthenticatedUser,
): Promise<Response> {
  if (!videoId) {
    return json({ error: "Video id is required" }, 400);
  }

  await sweepAndRecoverHelperClips(env, origin, ctx);
  await sweepStaleClips(env.DB);
  const [video, clips] = await Promise.all([
    getSourceVideoByIdForOwner(env.DB, videoId, user.id),
    listClipsByVideoIdForOwner(env.DB, videoId, user.id),
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
  user: AuthenticatedUser,
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
  const { clips, total } = await listClips(env.DB, user.id, limit, offset);
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
  user: AuthenticatedUser,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipByIdForOwner(env.DB, clipId, user.id);
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
  user: AuthenticatedUser,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  await sweepAndRecoverHelperClips(env, origin, ctx);
  const record = await getClipByIdForOwner(env.DB, clipId, user.id);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }

  return json(recordToResponse(record, env.R2_PUBLIC_PREFIX));
}

function captionTrackErrorResponse(error: unknown): Response {
  if (!(error instanceof CaptionTrackError)) {
    console.error(
      JSON.stringify({
        message: "caption track operation failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return json({ error: "Caption operation failed" }, 500);
  }
  if (error.kind === "internal") {
    console.error(
      JSON.stringify({
        message: "caption track operation failed",
        error: error.message,
      }),
    );
    return json({ error: "Caption operation failed" }, 500);
  }
  const status =
    error.kind === "not_found"
      ? 404
      : error.kind === "validation"
        ? 400
        : error.kind === "transcript"
          ? 502
          : 409;
  return json(
    {
      error: error.message,
      ...(error.details.length > 0 ? { details: error.details } : {}),
    },
    status,
  );
}

async function handleCaptionTrackRead(
  clipId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  try {
    const track = await viewCaptionTrack(env, user.id, clipId);
    return json(track, track.captionStatus === "checking" ? 202 : 200);
  } catch (error) {
    return captionTrackErrorResponse(error);
  }
}

async function handleCaptionTrackSave(
  request: Request,
  clipId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const parsed = await readCaptionJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const cues =
    body && typeof body === "object" && "cues" in body
      ? (body as { cues: unknown }).cues
      : undefined;
  const theme =
    body && typeof body === "object" && "theme" in body
      ? (body as { theme: unknown }).theme
      : undefined;
  const proposalSource =
    body && typeof body === "object" && "proposalSource" in body
      ? (body as { proposalSource: unknown }).proposalSource
      : undefined;
  try {
    return json(
      await saveCaptionTrack(env, user.id, clipId, cues, {
        theme,
        proposalSource,
      }),
    );
  } catch (error) {
    return captionTrackErrorResponse(error);
  }
}

async function handleCaptionTrackExport(
  clipId: string,
  format: "vtt" | "srt",
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  try {
    const exported = await exportCaptionTrack(env, user.id, clipId, format);
    return new Response(exported.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        "Content-Type":
          format === "srt"
            ? "application/x-subrip; charset=utf-8"
            : "text/vtt; charset=utf-8",
      },
    });
  } catch (error) {
    return captionTrackErrorResponse(error);
  }
}

async function handleCaptionTrackProposal(
  request: Request,
  clipId: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const parsed = await readCaptionJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid proposal" }, 400);
  }
  const proposal = body as Record<string, unknown>;
  try {
    return json(
      await validateCaptionTrackProposal(env, user.id, clipId, {
        source: proposal.source,
        baseRevision: proposal.baseRevision,
        cues: proposal.cues,
        theme: proposal.theme,
      }),
    );
  } catch (error) {
    return captionTrackErrorResponse(error);
  }
}

async function readCaptionJson(
  request: Request,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: Response }
> {
  const contentLength = parseContentLength(
    request.headers.get("content-length"),
  );
  if (
    contentLength !== null &&
    contentLength > MAX_CAPTION_TRACK_BODY_BYTES
  ) {
    return {
      ok: false,
      response: json({ error: "Caption track is too large" }, 413),
    };
  }
  try {
    const raw = await readBoundedText(
      request.body,
      MAX_CAPTION_TRACK_BODY_BYTES,
    );
    if (raw === null) {
      return {
        ok: false,
        response: json({ error: "Caption track is too large" }, 413),
      };
    }
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: json({ error: "Invalid JSON body" }, 400),
    };
  }
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function handleCaptionTrackRender(
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser,
): Promise<Response> {
  try {
    const result = await beginCaptionRender(env, user.id, clipId);
    if (!result.started) return json(result.track);
    ctx.waitUntil(dispatchCaptionRenderJob(env, result.job));
    return json(result.track, 202);
  } catch (error) {
    return captionTrackErrorResponse(error);
  }
}

async function handleRequestGifExport(
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser,
): Promise<Response> {
  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }
  const distribution = new ClipDistribution({
    db: env.DB,
    artifactPrefix: env.R2_PUBLIC_PREFIX,
    scheduleGifExport: (scheduledClipId) => {
      ctx.waitUntil(dispatchGifExportJob(env, scheduledClipId));
    },
  });
  try {
    const result = await distribution.perform({
      type: "create-export",
      ownerId: user.id,
      clipId,
      preset: "looping-gif",
    });
    const updated = await getClipByIdForOwner(env.DB, clipId, user.id);
    if (!updated) return json({ error: "Clip not found" }, 404);
    return json(
      recordToResponse(updated, env.R2_PUBLIC_PREFIX),
      result.type === "export" && result.started ? 202 : 200,
    );
  } catch (error) {
    if (error instanceof ClipDistributionError) {
      if (error.kind === "not_found") {
        return json({ error: "Clip not found" }, 404);
      }
      if (error.kind === "not_complete") {
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
    }
    throw error;
  }
}

async function handleRequestUploadUrl(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
  user: AuthenticatedUser | null,
): Promise<Response> {
  if (!user && !validHelperRequest(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }
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

  const key = generateUploadKey(validation.value.contentType, user?.id);
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
  user: AuthenticatedUser | null,
): Promise<Response> {
  if (!user && !validHelperRequest(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const key = decodeUploadPathParam(encodedKey);
  if (!key) {
    return json({ error: "Invalid upload key" }, 400);
  }
  if (user && !isOwnedUploadKey(key, user.id)) {
    return json({ error: "Upload not found" }, 404);
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

async function handleArtifactRequest(
  key: string,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  const clipId = key.match(
    /^clips\/([^/]+)\/(?:clip\.(?:mp4|gif)|thumbnail\.jpg|captioned-[A-Za-z0-9-]+\.mp4)$/,
  )?.[1];
  const ownsArtifact = key.includes("/captioned-")
    ? await ownsCaptionedArtifact(env, user.id, key)
    : Boolean(clipId && (await getClipByIdForOwner(env.DB, clipId, user.id)));
  if (!clipId || !ownsArtifact) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.CLIPS_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");

  return new Response(object.body, { headers });
}

function validHelperRequest(request: Request, env: Env): boolean {
  return Boolean(
    env.HELPER_TOKEN &&
      verifyHelperToken(
        request.headers.get(HELPER_TOKEN_HEADER),
        env.HELPER_TOKEN,
      ),
  );
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
