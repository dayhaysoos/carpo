export const MAX_CLIP_LENGTH_SECONDS = 60;
export const MAX_CAPTION_LENGTH = 200;

export const CLIP_STATUSES = [
  "queued",
  "downloading",
  "encoding",
  "uploading",
  "complete",
  "failed",
] as const;

export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const GIF_STATUSES = ["none", "encoding", "complete", "failed"] as const;

export type GifStatus = (typeof GIF_STATUSES)[number];

export interface YoutubeSource {
  type: "youtube";
  url: string;
}

export interface UploadSource {
  type: "upload";
  key: string;
}

export type ClipSource = YoutubeSource | UploadSource;

export interface UploadUrlResponse {
  key: string;
  uploadUrl: string;
  maxSizeBytes: number;
  contentType: string;
  method: "PUT";
}

export interface CaptionFilter {
  type: "caption";
  text: string;
}

export type FilterSpec = CaptionFilter;

export interface CreateClipRequest {
  title: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  filters: FilterSpec[];
}

export interface ClipOutputs {
  mp4: string | null;
  thumbnail: string | null;
  gif: string | null;
}

export interface ClipResponse {
  id: string;
  title: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  caption: string | null;
  filters: FilterSpec[];
  status: ClipStatus;
  errorMessage: string | null;
  gifStatus: GifStatus;
  gifErrorMessage: string | null;
  outputs: ClipOutputs;
  createdAt: string;
  updatedAt: string;
}

export interface ClipListResponse {
  clips: ClipResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ApiError {
  error: string;
  details?: ValidationError[];
}
