import {
  CLIP_QUALITIES,
  DEFAULT_CLIP_QUALITY,
  FILTER_TYPES,
  MAX_CAPTION_LENGTH,
  MAX_CLIP_LENGTH_SECONDS,
} from "./types";
import type { ClipQuality, ClipSource, CreateClipRequest, FilterSpec } from "./types";
import { isValidUploadKey } from "./uploads";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export interface ValidationError {
  field: string;
  message: string;
}

export function validateCreateClipRequest(
  body: unknown,
  maxClipLength = MAX_CLIP_LENGTH_SECONDS,
): { ok: true; value: CreateClipRequest & { caption: string | null } } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }

  const input = body as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    errors.push({ field: "title", message: "Title is required" });
  } else if (title.length > 200) {
    errors.push({ field: "title", message: "Title must be 200 characters or fewer" });
  }

  const sourceTitle =
    typeof input.sourceTitle === "string" ? input.sourceTitle.trim() : "";
  if (sourceTitle.length > 200) {
    errors.push({
      field: "sourceTitle",
      message: "Source title must be 200 characters or fewer",
    });
  }

  const source = input.source;
  if (!source || typeof source !== "object") {
    errors.push({ field: "source", message: "Source is required" });
  } else {
    const sourceObj = source as Record<string, unknown>;
    const sourceType = sourceObj.type;
    if (sourceType === "youtube") {
      const url = typeof sourceObj.url === "string" ? sourceObj.url.trim() : "";
      if (!url) {
        errors.push({ field: "source.url", message: "YouTube URL is required" });
      } else if (!isValidYoutubeUrl(url)) {
        errors.push({
          field: "source.url",
          message: "Must be a valid YouTube URL (youtube.com or youtu.be)",
        });
      }
    } else if (sourceType === "upload") {
      const key = typeof sourceObj.key === "string" ? sourceObj.key.trim() : "";
      if (!key) {
        errors.push({ field: "source.key", message: "Upload key is required" });
      } else if (!isValidUploadKey(key)) {
        errors.push({
          field: "source.key",
          message: "Upload key must be an uploads/ object key with a supported video extension",
        });
      }
    } else {
      errors.push({
        field: "source.type",
        message: "Source type must be 'youtube' or 'upload'",
      });
    }
  }

  const trimStart = parseTimestamp(input.trimStart, "trimStart", errors);
  const trimEnd = parseTimestamp(input.trimEnd, "trimEnd", errors);

  if (trimStart !== null && trimEnd !== null) {
    if (trimEnd <= trimStart) {
      errors.push({
        field: "trimEnd",
        message: "trimEnd must be greater than trimStart",
      });
    } else {
      const duration = trimEnd - trimStart;
      if (duration > maxClipLength) {
        errors.push({
          field: "trim",
          message: `Clip length must not exceed ${maxClipLength} seconds (got ${duration.toFixed(2)}s)`,
        });
      }
    }
  }

  if (input.caption !== undefined && input.caption !== null) {
    errors.push({
      field: "caption",
      message: "Caption must be provided as a filter entry ({ type: \"caption\", text: \"...\" })",
    });
  }

  let filters: FilterSpec[] = [];
  if (input.filters === undefined) {
    filters = [];
  } else if (!Array.isArray(input.filters)) {
    errors.push({ field: "filters", message: "Filters must be an array" });
  } else {
    filters = validateFilters(input.filters, errors);
  }

  let quality: ClipQuality = DEFAULT_CLIP_QUALITY;
  if (input.quality !== undefined && input.quality !== null) {
    if (
      typeof input.quality !== "string" ||
      !CLIP_QUALITIES.includes(input.quality as ClipQuality)
    ) {
      errors.push({
        field: "quality",
        message: "quality must be '720p' or '1080p'",
      });
    } else {
      quality = input.quality as ClipQuality;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sourceObj = source as Record<string, unknown>;
  const parsedSource: ClipSource =
    sourceObj.type === "upload"
      ? {
          type: "upload",
          key: (sourceObj.key as string).trim(),
        }
      : {
          type: "youtube",
          url: (sourceObj.url as string).trim(),
        };

  return {
    ok: true,
    value: {
      title,
      ...(sourceTitle ? { sourceTitle } : {}),
      source: parsedSource,
      trimStart: trimStart!,
      trimEnd: trimEnd!,
      filters,
      quality,
      caption: extractCaptionFromFilters(filters),
    },
  };
}

function validateFilters(filters: unknown[], errors: ValidationError[]): FilterSpec[] {
  const validated: FilterSpec[] = [];
  let captionCount = 0;

  for (let index = 0; index < filters.length; index += 1) {
    const item = filters[index];
    const fieldPrefix = `filters[${index}]`;

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ field: fieldPrefix, message: "Filter must be an object" });
      continue;
    }

    const filter = item as Record<string, unknown>;
    const filterType = filter.type;

    if (filterType === "caption") {
      captionCount += 1;
      if (captionCount > 1) {
        errors.push({
          field: fieldPrefix,
          message: "only one caption filter is supported",
        });
        continue;
      }

      const text = typeof filter.text === "string" ? filter.text : "";
      if (!text.trim()) {
        errors.push({
          field: `${fieldPrefix}.text`,
          message: "Caption text is required",
        });
      } else if (text.length > MAX_CAPTION_LENGTH) {
        errors.push({
          field: `${fieldPrefix}.text`,
          message: `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer`,
        });
      } else {
        validated.push({ type: "caption", text });
      }
      continue;
    }

    if (typeof filterType !== "string" || !FILTER_TYPES.includes(filterType as FilterSpec["type"])) {
      errors.push({
        field: `${fieldPrefix}.type`,
        message: `Unknown filter type: ${String(filterType)}`,
      });
    }
  }

  return validated;
}

export function extractCaptionFromFilters(filters: FilterSpec[]): string | null {
  const captionFilter = filters.find((filter) => filter.type === "caption");
  return captionFilter?.text ?? null;
}

function parseTimestamp(
  value: unknown,
  field: string,
  errors: ValidationError[],
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ field, message: `${field} must be a finite number` });
    return null;
  }
  if (value < 0) {
    errors.push({ field, message: `${field} must be non-negative` });
    return null;
  }
  return value;
}

export function isValidYoutubeUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    const normalizedHost = url.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(normalizedHost)) {
      return false;
    }
    if (normalizedHost === "youtu.be") {
      return url.pathname.length > 1;
    }
    if (url.pathname.startsWith("/watch")) {
      return url.searchParams.has("v") && url.searchParams.get("v")!.length > 0;
    }
    if (url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/").filter(Boolean).length >= 2;
    }
    if (url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/").filter(Boolean).length >= 2;
    }
    return false;
  } catch {
    return false;
  }
}
