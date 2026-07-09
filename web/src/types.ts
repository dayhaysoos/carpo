export const MAX_CLIP_LENGTH_SECONDS = 60;

export const CLIP_STATUSES = [
  "queued",
  "downloading",
  "encoding",
  "uploading",
  "complete",
  "failed",
] as const;

export type ClipStatus = (typeof CLIP_STATUSES)[number];

export interface YoutubeSource {
  type: "youtube";
  url: string;
}

export interface CreateClipRequest {
  title: string;
  source: YoutubeSource;
  trimStart: number;
  trimEnd: number;
  filters?: Record<string, unknown>[];
}

export interface ClipOutputs {
  mp4: string | null;
  thumbnail: string | null;
}

export interface ClipResponse {
  id: string;
  title: string;
  source: YoutubeSource;
  trimStart: number;
  trimEnd: number;
  caption: string | null;
  filters: Record<string, unknown>[];
  status: ClipStatus;
  errorMessage: string | null;
  outputs: ClipOutputs;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ApiError {
  error: string;
  details?: ValidationError[];
}
