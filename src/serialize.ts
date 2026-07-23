import type {
  ClipRecord,
  ClipResponse,
  ClipSource,
  FilterSpec,
  SourceVideoRecord,
  SourceVideoResponse,
} from "./types";
import { extractYoutubeVideoId } from "./source-videos";

export function parseFilters(filtersJson: string): FilterSpec[] {
  try {
    const parsed = JSON.parse(filtersJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordToSource(record: ClipRecord): ClipSource {
  if (record.source_type === "youtube") {
    return { type: "youtube", url: record.source_ref };
  }
  return { type: "upload", key: record.source_ref };
}

export function recordToResponse(
  record: ClipRecord,
  artifactPrefix: string,
): ClipResponse {
  return {
    id: record.id,
    videoId: record.video_id ?? "",
    title: record.title,
    source: recordToSource(record),
    trimStart: record.trim_start,
    trimEnd: record.trim_end,
    quality: record.quality ?? "1080p",
    caption: record.caption,
    filters: parseFilters(record.filters_json),
    status: record.status,
    errorMessage: record.error_message,
    outputs: {
      mp4: record.output_mp4_key
        ? `${artifactPrefix}/${record.output_mp4_key}`
        : null,
      thumbnail: record.output_thumbnail_key
        ? `${artifactPrefix}/${record.output_thumbnail_key}`
        : null,
      gif: record.output_gif_key
        ? `${artifactPrefix}/${record.output_gif_key}`
        : null,
    },
    gifStatus: record.gif_status ?? "none",
    gifErrorMessage: record.gif_error_message,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function sourceVideoRecordToResponse(
  record: SourceVideoRecord,
  artifactPrefix: string,
): SourceVideoResponse {
  const source: ClipSource =
    record.source_type === "youtube"
      ? { type: "youtube", url: record.source_ref }
      : { type: "upload", key: record.source_ref };
  const youtubeId =
    source.type === "youtube" ? extractYoutubeVideoId(source.url) : null;

  return {
    id: record.id,
    title: record.title,
    source,
    clipCount: Number(record.clip_count),
    activeClipCount: Number(record.active_clip_count),
    failedClipCount: Number(record.failed_clip_count),
    thumbnail: record.thumbnail_key
      ? `${artifactPrefix}/${record.thumbnail_key}`
      : youtubeId
        ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
        : null,
    durationSeconds: record.duration_seconds,
    retainedSourceReady:
      source.type === "upload" ||
      (record.retained_source_status === "ready" &&
        Boolean(record.retained_source_key)),
    transcriptStatus: record.transcript_status,
    transcriptCheckedAt: record.transcript_checked_at,
    transcriptCheckError: record.transcript_check_error,
    transcriptRetryAt: record.transcript_retry_at,
    archivedAt: record.archived_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
