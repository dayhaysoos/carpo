import type {
  ApiError,
  CaptionCue,
  CaptionTrackAvailable,
  CaptionTrackProposal,
  CaptionTrackResponse,
  ClipListResponse,
  ClipResponse,
  CaptionThemeId,
  CaptionProposalSource,
  CreateClipRequest,
  CreateClipFromVideoRequest,
  CreateSourceVideoRequest,
  SourceVideoDetailResponse,
  SourceVideoListResponse,
  SourceVideoResponse,
  TranscriptResponse,
  UploadUrlResponse,
  CurrentUserResponse,
  LibrarySearchMode,
  LibrarySearchResponse,
  PrepareLibraryMomentRequest,
  PreparedLibraryMomentReview,
  VisualSearchResponse,
  PrepareVisualMomentRequest,
  PreparedVisualMomentReview,
  ClipDistributionView,
  ClipExportPreset,
  ClipExportResult,
  ClipShareCreatedResult,
  ClipShareRevokedResult,
  ShareExpirationPreset,
} from "./types";

export async function getCurrentUser(): Promise<CurrentUserResponse> {
  const response = await fetch("/api/me");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<CurrentUserResponse>;
}

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

export async function getCaptionTrack(
  clipId: string,
): Promise<CaptionTrackResponse> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/captions`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<CaptionTrackResponse>;
}

export async function saveCaptionTrack(
  clipId: string,
  cues: CaptionCue[],
  options: {
    theme?: CaptionThemeId;
    proposalSource?: CaptionProposalSource;
  } = {},
): Promise<CaptionTrackAvailable> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/captions`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cues, ...options }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((item) => item.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<CaptionTrackAvailable>;
}

export function captionTrackVttUrl(clipId: string): string {
  return `/api/clips/${encodeURIComponent(clipId)}/captions.vtt`;
}

export function captionTrackSrtUrl(clipId: string): string {
  return `/api/clips/${encodeURIComponent(clipId)}/captions.srt`;
}

export async function validateCaptionTrackProposal(
  clipId: string,
  input: {
    source: CaptionProposalSource;
    baseRevision: string | null;
    cues: CaptionCue[];
    theme: CaptionThemeId;
  },
): Promise<CaptionTrackProposal> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/captions/proposals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((item) => item.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<CaptionTrackProposal>;
}

export async function renderCaptionTrack(
  clipId: string,
): Promise<CaptionTrackAvailable> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/captions/render`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<CaptionTrackAvailable>;
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

export async function searchPrivateLibrary(input: {
  query: string;
  mode: LibrarySearchMode;
  archived?: boolean;
  limit?: number;
}): Promise<LibrarySearchResponse> {
  const response = await fetch("/api/library/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<LibrarySearchResponse>;
}

export async function prepareLibraryMomentReview(
  input: PrepareLibraryMomentRequest,
): Promise<PreparedLibraryMomentReview> {
  const response = await fetch("/api/library/moments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<PreparedLibraryMomentReview>;
}

export async function getPreparedLibraryMomentReview(
  proposalId: string,
): Promise<PreparedLibraryMomentReview> {
  const response = await fetch(
    `/api/library/moments/${encodeURIComponent(proposalId)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<PreparedLibraryMomentReview>;
}

export async function searchVisualMoments(
  videoId: string,
  query: string,
): Promise<VisualSearchResponse> {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/visual-search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<VisualSearchResponse>;
}

export async function prepareVisualMomentReview(
  input: PrepareVisualMomentRequest,
): Promise<PreparedVisualMomentReview> {
  const response = await fetch("/api/visual-moments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<PreparedVisualMomentReview>;
}

export async function getPreparedVisualMomentReview(
  proposalId: string,
): Promise<PreparedVisualMomentReview> {
  const response = await fetch(
    `/api/visual-moments/${encodeURIComponent(proposalId)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<PreparedVisualMomentReview>;
}

export async function createSourceVideo(
  request: CreateSourceVideoRequest,
): Promise<SourceVideoResponse> {
  const response = await fetch("/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((d) => d.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<SourceVideoResponse>;
}

export async function retryRemoteSourceIngestion(
  videoId: string,
): Promise<SourceVideoResponse> {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/ingest`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<SourceVideoResponse>;
}

export async function createClipFromSourceVideo(
  videoId: string,
  request: CreateClipFromVideoRequest,
  idempotencyKey?: string,
): Promise<ClipResponse> {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/clips`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
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

export async function updateSourceVideoDuration(
  videoId: string,
  durationSeconds: number,
): Promise<SourceVideoResponse> {
  const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSeconds }),
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

export async function getVideoTranscript(
  videoId: string,
): Promise<TranscriptResponse> {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/transcript`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<TranscriptResponse>;
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

export async function getClipDistribution(
  clipId: string,
): Promise<ClipDistributionView> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/distribution`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipDistributionView>;
}

export async function createClipShare(
  clipId: string,
  expiration: ShareExpirationPreset,
): Promise<ClipShareCreatedResult> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/distribution/shares`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiration }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipShareCreatedResult>;
}

export async function revokeClipShare(
  clipId: string,
  shareId: string,
): Promise<ClipShareRevokedResult> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/distribution/shares/${encodeURIComponent(shareId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipShareRevokedResult>;
}

export async function createClipExport(
  clipId: string,
  preset: ClipExportPreset,
): Promise<ClipExportResult> {
  const response = await fetch(
    `/api/clips/${encodeURIComponent(clipId)}/distribution/exports/${encodeURIComponent(preset)}`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipExportResult>;
}
