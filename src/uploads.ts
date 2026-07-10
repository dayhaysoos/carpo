/** Upload source objects live under this R2 prefix (distinct from clip outputs). */
export const UPLOAD_KEY_PREFIX = "uploads/";

// Two-tier TTL: clip creation rejects upload sources at ACCEPT_TTL sharp,
// while the sweep only deletes objects older than SWEEP_TTL (ACCEPT_TTL plus
// a one-hour grace margin). An object accepted just under the 24h line thus
// keeps a full hour of sweep immunity — far longer than any encode — so the
// opportunistic sweep on list requests can never delete a source that a
// just-created clip's dispatch is still staging.
export const UPLOAD_SOURCE_ACCEPT_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_SOURCE_SWEEP_TTL_MS =
  UPLOAD_SOURCE_ACCEPT_TTL_MS + 60 * 60 * 1000;

export function isUploadSourceExpired(
  uploaded: Date,
  now: Date,
  ttlMs = UPLOAD_SOURCE_ACCEPT_TTL_MS,
): boolean {
  return now.getTime() - uploaded.getTime() >= ttlMs;
}

export async function sweepExpiredUploadSources(
  bucket: R2Bucket,
  options?: { now?: Date; maxAgeMs?: number },
): Promise<number> {
  const now = options?.now ?? new Date();
  const maxAgeMs = options?.maxAgeMs ?? UPLOAD_SOURCE_SWEEP_TTL_MS;
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const listing = await bucket.list({ prefix: UPLOAD_KEY_PREFIX, cursor });
    for (const object of listing.objects) {
      if (isUploadSourceExpired(object.uploaded, now, maxAgeMs)) {
        await bucket.delete(object.key);
        deleted += 1;
      }
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  return deleted;
}

/** Worker-streaming cap (paid Workers request body limit is 100MB). */
export const MAX_UPLOAD_SIZE_WORKER_BYTES = 95 * 1024 * 1024;

/** Presigned direct-to-R2 cap when S3 API credentials are configured. */
export const MAX_UPLOAD_SIZE_PRESIGNED_BYTES = 200 * 1024 * 1024;

export const ALLOWED_UPLOAD_CONTENT_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
] as const;

export type AllowedUploadContentType =
  (typeof ALLOWED_UPLOAD_CONTENT_TYPES)[number];

const EXTENSION_BY_CONTENT_TYPE: Record<AllowedUploadContentType, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, AllowedUploadContentType> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

export interface UploadUrlRequest {
  contentType: string;
  sizeBytes: number;
  filename?: string;
}

export interface UploadUrlResponse {
  key: string;
  uploadUrl: string;
  maxSizeBytes: number;
  contentType: string;
  method: "PUT";
}

export function maxUploadSizeBytes(env: {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}): number {
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return MAX_UPLOAD_SIZE_PRESIGNED_BYTES;
  }
  return MAX_UPLOAD_SIZE_WORKER_BYTES;
}

export function usesPresignedUploads(env: {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export function normalizeUploadContentType(
  contentType: string,
): AllowedUploadContentType | null {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_UPLOAD_CONTENT_TYPES.includes(
    normalized as AllowedUploadContentType,
  )
    ? (normalized as AllowedUploadContentType)
    : null;
}

export function extensionForContentType(
  contentType: AllowedUploadContentType,
): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType];
}

export function contentTypeForUploadKey(key: string): string | null {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? null;
}

export function isValidUploadKey(key: string): boolean {
  if (!key.startsWith(UPLOAD_KEY_PREFIX)) {
    return false;
  }
  const remainder = key.slice(UPLOAD_KEY_PREFIX.length);
  if (!remainder || remainder.includes("/")) {
    return false;
  }
  const ext = remainder.split(".").pop()?.toLowerCase() ?? "";
  return ext in CONTENT_TYPE_BY_EXTENSION;
}

export function generateUploadKey(contentType: AllowedUploadContentType): string {
  const ext = extensionForContentType(contentType);
  return `${UPLOAD_KEY_PREFIX}${crypto.randomUUID()}.${ext}`;
}

export function decodeUploadPathParam(encoded: string): string | null {
  try {
    const key = decodeURIComponent(encoded);
    return isValidUploadKey(key) ? key : null;
  } catch {
    return null;
  }
}

export function validateUploadUrlRequest(
  body: unknown,
  maxSizeBytes: number,
):
  | { ok: true; value: UploadUrlRequest & { contentType: AllowedUploadContentType } }
  | { ok: false; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];

  if (!body || typeof body !== "object") {
    return {
      ok: false,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const input = body as Record<string, unknown>;
  const rawContentType =
    typeof input.contentType === "string" ? input.contentType.trim() : "";
  const contentType = normalizeUploadContentType(rawContentType);
  if (!rawContentType) {
    errors.push({ field: "contentType", message: "contentType is required" });
  } else if (!contentType) {
    errors.push({
      field: "contentType",
      message: "Unsupported video type; use mp4, webm, mov, or mkv",
    });
  }

  let sizeBytes: number | null = null;
  if (typeof input.sizeBytes !== "number" || !Number.isFinite(input.sizeBytes)) {
    errors.push({
      field: "sizeBytes",
      message: "sizeBytes must be a finite number",
    });
  } else if (input.sizeBytes <= 0) {
    errors.push({
      field: "sizeBytes",
      message: "sizeBytes must be greater than zero",
    });
  } else {
    sizeBytes = input.sizeBytes;
    if (sizeBytes > maxSizeBytes) {
      errors.push({
        field: "sizeBytes",
        message: `File exceeds maximum upload size of ${formatMegabytes(maxSizeBytes)}`,
      });
    }
  }

  const filename =
    typeof input.filename === "string" ? input.filename.trim() : undefined;
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!(ext in CONTENT_TYPE_BY_EXTENSION)) {
      errors.push({
        field: "filename",
        message: "Filename must use a supported video extension (mp4, webm, mov, mkv)",
      });
    } else if (contentType && CONTENT_TYPE_BY_EXTENSION[ext] !== contentType) {
      errors.push({
        field: "filename",
        message: "Filename extension does not match contentType",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      contentType: contentType!,
      sizeBytes: sizeBytes!,
      filename,
    },
  };
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
