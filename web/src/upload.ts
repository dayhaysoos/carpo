const ALLOWED_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv"]);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

export function extensionForFile(file: File): string | null {
  const fromName = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ALLOWED_EXTENSIONS.has(fromName)) {
    return fromName;
  }
  return null;
}

export function contentTypeForFile(file: File): string | null {
  const ext = extensionForFile(file);
  if (!ext) {
    return null;
  }
  if (file.type && normalizeContentType(file.type) === CONTENT_TYPE_BY_EXTENSION[ext]) {
    return normalizeContentType(file.type);
  }
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? null;
}

export function validateUploadFile(
  file: File,
  maxSizeBytes: number,
): string | null {
  const contentType = contentTypeForFile(file);
  if (!contentType) {
    return "Choose an mp4, webm, mov, or mkv video file";
  }
  if (file.size <= 0) {
    return "File is empty";
  }
  if (file.size > maxSizeBytes) {
    const maxMb = Math.round(maxSizeBytes / (1024 * 1024));
    return `File is too large (max ${maxMb}MB)`;
  }
  return null;
}

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function formatUploadProgress(loaded: number, total: number): string {
  if (total <= 0) {
    return "Uploading…";
  }
  const percent = Math.min(100, Math.round((loaded / total) * 100));
  return `Uploading… ${percent}%`;
}
