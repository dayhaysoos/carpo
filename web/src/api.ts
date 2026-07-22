import type {
  ApiError,
  ClipListResponse,
  ClipResponse,
  CreateClipRequest,
  CreateClipFromVideoRequest,
  SourceVideoDetailResponse,
  SourceVideoListResponse,
  SourceVideoResponse,
  UploadUrlResponse,
} from "./types";

export async function requestUploadUrl(input: {
  contentType: string;
  sizeBytes: number;
  filename: string;
}): Promise<UploadUrlResponse> {
  const response = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((d) => d.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }

  return response.json() as Promise<UploadUrlResponse>;
}

export function uploadFileWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as ApiError;
        const detail = body.details?.map((d) => d.message).join("; ");
        reject(new Error(detail || body.error || `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
    xhr.send(file);
  });
}

export async function createClip(
  request: CreateClipRequest,
): Promise<ClipResponse> {
  const response = await fetch("/api/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((d) => d.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }

  return response.json() as Promise<ClipResponse>;
}

export async function getClip(id: string): Promise<ClipResponse> {
  const response = await fetch(`/api/clips/${id}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipResponse>;
}

export async function listClips(
  limit = 50,
  offset = 0,
): Promise<ClipListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const response = await fetch(`/api/clips?${params}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipListResponse>;
}

export async function listSourceVideos(
  limit = 50,
  offset = 0,
  archived = false,
): Promise<SourceVideoListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    archived: String(archived),
  });
  const response = await fetch(`/api/videos?${params}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<SourceVideoListResponse>;
}

export async function createClipFromSourceVideo(
  videoId: string,
  request: CreateClipFromVideoRequest,
): Promise<ClipResponse> {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((d) => d.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipResponse>;
}

export async function setSourceVideoArchived(
  videoId: string,
  archived: boolean,
): Promise<SourceVideoResponse> {
  const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<SourceVideoResponse>;
}

export async function deleteSourceVideo(videoId: string): Promise<void> {
  const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
}

export function sourceVideoUploadUrl(videoId: string): string {
  return `/api/videos/${encodeURIComponent(videoId)}/source`;
}

export async function getSourceVideo(
  id: string,
): Promise<SourceVideoDetailResponse> {
  const response = await fetch(`/api/videos/${encodeURIComponent(id)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<SourceVideoDetailResponse>;
}

export async function deleteClip(id: string): Promise<void> {
  const response = await fetch(`/api/clips/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
}

export async function requestGifExport(id: string): Promise<ClipResponse> {
  const response = await fetch(`/api/clips/${id}/gif`, { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipResponse>;
}
