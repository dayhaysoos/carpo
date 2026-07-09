import type { ClipRecord, ClipResponse, ClipSource, FilterSpec } from "./types";
import { outputKeysForClip } from "./db";

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
  const plannedOutputs = outputKeysForClip(record.id);
  return {
    id: record.id,
    title: record.title,
    source: recordToSource(record),
    trimStart: record.trim_start,
    trimEnd: record.trim_end,
    caption: record.caption,
    filters: parseFilters(record.filters_json),
    status: record.status,
    errorMessage: record.error_message,
    outputs: {
      mp4: record.output_mp4_key
        ? `${artifactPrefix}/${record.output_mp4_key}`
        : `${artifactPrefix}/${plannedOutputs.mp4Key}`,
      thumbnail: record.output_thumbnail_key
        ? `${artifactPrefix}/${record.output_thumbnail_key}`
        : `${artifactPrefix}/${plannedOutputs.thumbnailKey}`,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
