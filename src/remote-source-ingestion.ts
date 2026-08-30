import {
  claimSourceVideoRetainedSourceImport,
  getSourceVideoById,
  markSourceVideoRetainedSourceFailed,
} from "./db";
import { ENCODER_POOL_INSTANCE, prewarmEncoder } from "./encoder-pool";
import type { Env } from "./env";
import type {
  RemoteSourceFailure,
  RemoteSourceIngestionView,
  RemoteSourceProvider,
  SourceVideoRecord,
} from "./types";
import { youtubeRetainedSourceKey } from "./source-videos";

const UPLOAD_RECOVERY = {
  type: "upload" as const,
  href: "/?source=upload",
  label: "Upload the video instead",
};

function failure(
  provider: RemoteSourceProvider,
  code: RemoteSourceFailure["code"],
  message: string,
  retryable: boolean,
): RemoteSourceFailure {
  return {
    provider,
    code,
    message,
    retryable,
    recovery: UPLOAD_RECOVERY,
  };
}

export function classifyRemoteSourceFailure(
  provider: RemoteSourceProvider,
  rawMessage: string | null | undefined,
): RemoteSourceFailure {
  return (
    matchRemoteSourceFailure(provider, rawMessage) ??
    failure(
      provider,
      "unknown",
      "Carpo could not import this YouTube video. Retry or upload the video file instead.",
      true,
    )
  );
}

export function matchRemoteSourceFailure(
  provider: RemoteSourceProvider,
  rawMessage: string | null | undefined,
): RemoteSourceFailure | null {
  const raw = rawMessage?.trim() ?? "";
  const text = raw.toLowerCase();

  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate limiting") ||
    text.includes("blocking downloads from this server")
  ) {
    return failure(
      provider,
      "rate_limited",
      "YouTube temporarily blocked this download. Retry later or upload the video file.",
      true,
    );
  }

  if (
    text.includes("sign in") ||
    text.includes("login") ||
    text.includes("cookies are required") ||
    text.includes("requires sign-in") ||
    text.includes("private video") ||
    text.includes("youtube video is private") ||
    text.includes("members-only") ||
    text.includes("join this channel")
  ) {
    return failure(
      provider,
      "login_required",
      "YouTube requires access that Carpo cannot use. Upload the video file instead.",
      false,
    );
  }

  if (
    text.includes("geo restricted") ||
    text.includes("not available in your country") ||
    text.includes("not available in your region")
  ) {
    return failure(
      provider,
      "geo_restricted",
      "This YouTube video is unavailable from Carpo's region. Upload the video file instead.",
      false,
    );
  }

  if (
    text.includes("unsupported url") ||
    text.includes("not a supported youtube link") ||
    text.includes("no video formats") ||
    text.includes("invalid youtube url") ||
    text.includes("enter a valid youtube url")
  ) {
    return failure(
      provider,
      "unsupported_media",
      "This URL does not contain a supported YouTube video. Upload the video file instead.",
      false,
    );
  }

  if (
    text.includes("extractor") ||
    text.includes("javascript runtime") ||
    text.includes("signature") ||
    text.includes("player response") ||
    text.includes("provider changed")
  ) {
    return failure(
      provider,
      "provider_changed",
      "YouTube changed how this video is delivered, so Carpo cannot import it right now. Upload the video file instead.",
      true,
    );
  }

  if (
    text.includes("video unavailable") ||
    text.includes("this youtube video is unavailable") ||
    text.includes("video has been removed") ||
    text.includes("content isn't available")
  ) {
    return failure(
      provider,
      "unavailable",
      "This YouTube video is unavailable. Upload the video file instead.",
      false,
    );
  }

  if (
    text.includes("youtube download timed out") ||
    text.includes("youtube appears to be blocking/stalling") ||
    text.includes("youtube source download failed") ||
    text.includes("failed to download youtube video")
  ) {
    return failure(
      provider,
      "unknown",
      "Carpo could not import this YouTube video. Retry or upload the video file instead.",
      true,
    );
  }

  return null;
}

export function viewRemoteSourceIngestion(
  video: SourceVideoRecord,
): RemoteSourceIngestionView | null {
  if (video.source_type !== "youtube") return null;

  const status =
    video.retained_source_status === "empty"
      ? "pending"
      : video.retained_source_status;
  return {
    provider: "youtube",
    status,
    failure:
      status === "failed"
        ? classifyRemoteSourceFailure("youtube", video.retained_source_error)
        : null,
  };
}

export function remoteSourceReady(video: SourceVideoRecord): boolean {
  return (
    video.source_type !== "youtube" ||
    (video.retained_source_status === "ready" &&
      Boolean(video.retained_source_key))
  );
}

export async function performRemoteSourceIngestion(
  env: Env,
  videoId: string,
): Promise<void> {
  const video = await getSourceVideoById(env.DB, videoId);
  if (!video || video.source_type !== "youtube" || remoteSourceReady(video)) {
    return;
  }

  const key = youtubeRetainedSourceKey(video.id);
  const claimed = await claimSourceVideoRetainedSourceImport(
    env.DB,
    video.id,
    key,
  );
  if (!claimed) return;

  try {
    await prewarmEncoder(env, {
      body: { source: { type: "youtube", url: video.source_ref } },
    });
    const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
    const response = await container.fetch(
      "http://encoder/__carpo/ingest-source",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id }),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        detail || `Source ingestion dispatch failed (${response.status})`,
      );
    }
  } catch (error) {
    await markSourceVideoRetainedSourceFailed(
      env.DB,
      video.id,
      error instanceof Error ? error.message : "Source ingestion failed",
    );
  }
}
