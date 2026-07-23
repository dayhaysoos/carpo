import {
  getSourceVideoById,
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
import { normalizeClipSource } from "./source-videos";
import type { ClipResponse, CreateClipRequest } from "./types";
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
  videoId: string;
  input: unknown;
  env: Env;
  origin: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

interface EnqueueClipOptions {
  clipRequest: CreateClipRequest;
  env: Env;
  origin: string;
  waitUntil: (promise: Promise<unknown>) => void;
  videoId?: string;
}

export async function enqueueClip({
  clipRequest,
  env,
  origin,
  waitUntil,
  videoId,
}: EnqueueClipOptions): Promise<ClipResponse> {
  const clipId = crypto.randomUUID();
  const record = await insertClip(env.DB, clipId, clipRequest, {
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
  videoId,
  input,
  env,
  origin,
  waitUntil,
}: CreateClipForVideoOptions): Promise<ClipCreationResult> {
  const video = await getSourceVideoById(env.DB, videoId);
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

  return {
    ok: true,
    clip: await enqueueClip({
      clipRequest,
      env,
      origin,
      waitUntil,
      videoId,
    }),
  };
}
