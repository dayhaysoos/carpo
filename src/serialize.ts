import type { ClipRecord, ClipResponse, ClipSource, FilterSpec } from "./types";

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
        : null,
      thumbnail: record.output_thumbnail_key
        ? `${artifactPrefix}/${record.output_thumbnail_key}`
        : null,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
