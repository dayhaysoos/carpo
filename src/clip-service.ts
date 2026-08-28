import {
  getClipByIdForOwner,
  getSourceVideoById,
  getSourceVideoByIdForOwner,
  insertClip,
  markClipHelperPending,
} from "./db";
import type { Env } from "./env";
import {
  isHelperEnabled,
  scheduleHelperClaimWindowFallback,
} from "./helper";
import { dispatchEncodingJob } from "./jobs";
import { recordToResponse } from "./serialize";
import { normalizeClipSource, sourceReference } from "./source-videos";
import type { ClipRecord, ClipResponse, CreateClipRequest } from "./types";
import { validateCreateClipRequest } from "./validation";

export interface ClipCreationFailure {
  ok: false;
  status: number;
  error: string;
  details?: Array<{ field: string; message: string }>;
}

export interface ClipCreationSuccess {
  ok: true;
  clip: ClipResponse;
}

export type ClipCreationResult = ClipCreationSuccess | ClipCreationFailure;

interface CreateClipForVideoOptions {
  ownerId: string;
  videoId: string;
  input: unknown;
  env: Env;
  origin: string;
  waitUntil: (promise: Promise<unknown>) => void;
  idempotencyKey?: string;
}

interface EnqueueClipOptions {
  ownerId: string;
  clipRequest: CreateClipRequest;
  env: Env;
  origin: string;
  waitUntil: (promise: Promise<unknown>) => void;
  videoId?: string;
  clipId?: string;
}

export async function enqueueClip({
  ownerId,
  clipRequest,
  env,
  origin,
  waitUntil,
  videoId,
  clipId = crypto.randomUUID(),
}: EnqueueClipOptions): Promise<ClipResponse> {
  const record = await insertClip(env.DB, ownerId, clipId, clipRequest, {
    videoId,
  });
  const sourceVideo = record.video_id
    ? await getSourceVideoById(env.DB, record.video_id)
    : null;
  const retainedYoutubeSourceReady =
    sourceVideo?.retained_source_status === "ready" &&
    Boolean(sourceVideo.retained_source_key);
  const shouldUseHelper =
    isHelperEnabled(env) &&
    clipRequest.source.type === "youtube" &&
    !retainedYoutubeSourceReady;
  const useHelper =
    shouldUseHelper && (await markClipHelperPending(env.DB, clipId));

  if (useHelper) {
    record.helper_state = "pending";
  }

  if (useHelper) {
    waitUntil(
      scheduleHelperClaimWindowFallback(env, clipId, origin, { waitUntil }),
    );
  } else {
    waitUntil(dispatchEncodingJob(env, clipId, clipRequest, origin));
  }

  return recordToResponse(record, env.R2_PUBLIC_PREFIX);
}

export async function createClipForVideo({
  ownerId,
  videoId,
  input,
  env,
  origin,
  waitUntil,
  idempotencyKey,
}: CreateClipForVideoOptions): Promise<ClipCreationResult> {
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, ownerId);
  if (!video) {
    return { ok: false, status: 404, error: "Video not found" };
  }

  const source =
    video.source_type === "youtube"
      ? { type: "youtube" as const, url: video.source_ref }
      : { type: "upload" as const, key: video.source_ref };
  const validation = validateCreateClipRequest(
    {
      ...(input && typeof input === "object" ? input : {}),
      source,
      sourceTitle: video.title,
    },
    Number(env.MAX_CLIP_LENGTH_SECONDS) || 60,
  );
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      error: "Validation failed",
      details: validation.errors,
    };
  }

  if (source.type === "upload") {
    const object = await env.CLIPS_BUCKET.head(source.key);
    if (!object) {
      return {
        ok: false,
        status: 409,
        error: "Video source unavailable",
        details: [
          {
            field: "videoId",
            message: "The original uploaded video is no longer available",
          },
        ],
      };
    }
  }

  const clipRequest: CreateClipRequest = {
    ...validation.value,
    source: normalizeClipSource(validation.value.source),
  };
  if (idempotencyKey && idempotencyKey.length > 200) {
    return {
      ok: false,
      status: 400,
      error: "Invalid idempotency key",
    };
  }
  const clipId = idempotencyKey
    ? await idempotentClipId(videoId, idempotencyKey)
    : undefined;
  if (clipId) {
    const existing = await getClipByIdForOwner(env.DB, clipId, ownerId);
    if (existing) {
      return idempotentClipResult(existing, clipRequest, videoId, env);
    }
  }

  try {
    return {
      ok: true,
      clip: await enqueueClip({
        ownerId,
        clipRequest,
        env,
        origin,
        waitUntil,
        videoId,
        clipId,
      }),
    };
  } catch (error) {
    if (clipId && isClipIdConflict(error)) {
      const existing = await getClipByIdForOwner(env.DB, clipId, ownerId);
      if (existing) {
        return idempotentClipResult(existing, clipRequest, videoId, env);
      }
    }
    throw error;
  }
}

function idempotentClipResult(
  existing: ClipRecord,
  request: CreateClipRequest,
  videoId: string,
  env: Env,
): ClipCreationResult {
  const matches =
    existing.video_id === videoId &&
    existing.title === request.title &&
    existing.source_type === request.source.type &&
    existing.source_ref === sourceReference(request.source) &&
    existing.trim_start === request.trimStart &&
    existing.trim_end === request.trimEnd &&
    existing.quality === (request.quality ?? "1080p") &&
    existing.filters_json === JSON.stringify(request.filters ?? []);
  if (!matches) {
    return {
      ok: false,
      status: 409,
      error: "Idempotency key was already used for a different clip request",
    };
  }
  return {
    ok: true,
    clip: recordToResponse(existing, env.R2_PUBLIC_PREFIX),
  };
}

function isClipIdConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: clips.id")
  );
}

async function idempotentClipId(
  videoId: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${videoId}\0${idempotencyKey}`),
    ),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
