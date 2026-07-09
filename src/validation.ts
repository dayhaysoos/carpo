import { MAX_CLIP_LENGTH_SECONDS } from "./types";
import type { CreateClipRequest } from "./types";

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
): { ok: true; value: CreateClipRequest } | { ok: false; errors: ValidationError[] } {
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

  const caption =
    input.caption === undefined || input.caption === null
      ? null
      : typeof input.caption === "string"
        ? input.caption
        : null;
  if (input.caption !== undefined && input.caption !== null && typeof input.caption !== "string") {
    errors.push({ field: "caption", message: "Caption must be a string or null" });
  }

  let filters: unknown[] = [];
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters)) {
      errors.push({ field: "filters", message: "Filters must be an array" });
    } else {
      filters = input.filters;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sourceObj = source as Record<string, unknown>;
  const parsedSource =
    sourceObj.type === "youtube"
      ? { type: "youtube" as const, url: (sourceObj.url as string).trim() }
      : { type: "upload" as const, key: (sourceObj.key as string).trim() };

  return {
    ok: true,
    value: {
      title,
      source: parsedSource,
      trimStart: trimStart!,
      trimEnd: trimEnd!,
      caption,
      filters: filters as CreateClipRequest["filters"],
    },
  };
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
