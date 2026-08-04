export const MAX_CLIP_LENGTH_SECONDS = 60;
export const MIN_TRIM_GAP_SECONDS = 0.001;
export const MAX_CAPTION_LENGTH = 200;

export const CLIP_QUALITIES = ["720p", "1080p"] as const;
export type ClipQuality = (typeof CLIP_QUALITIES)[number];
export const DEFAULT_CLIP_QUALITY: ClipQuality = "1080p";

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

export type TranscriptStatus =
  | "unknown"
  | "checking"
  | "available"
  | "unavailable"
  | "unsupported"
  | "failed";

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
  sourceTitle?: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  filters: FilterSpec[];
  quality?: ClipQuality;
}

export interface ClipOutputs {
  mp4: string | null;
  thumbnail: string | null;
  gif: string | null;
}

export interface ClipResponse {
  id: string;
  videoId: string;
  title: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  quality: ClipQuality;
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

export interface SourceVideoResponse {
  id: string;
  title: string;
  source: ClipSource;
  clipCount: number;
  activeClipCount: number;
  failedClipCount: number;
  thumbnail: string | null;
  durationSeconds: number | null;
  retainedSourceReady: boolean;
  transcriptStatus: TranscriptStatus;
  transcriptCheckedAt: string | null;
  transcriptCheckError: string | null;
  transcriptRetryAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceVideoRequest {
  source: ClipSource;
  title?: string;
  durationSeconds?: number;
}

export type CreateClipFromVideoRequest = Omit<
  CreateClipRequest,
  "source" | "sourceTitle"
>;

export interface SourceVideoListResponse {
  videos: SourceVideoResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface SourceVideoDetailResponse {
  video: SourceVideoResponse;
  clips: ClipResponse[];
}

export interface TranscriptBlock {
  id: string;
  startCueId: string;
  endCueId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptDocumentResponse {
  transcriptStatus: "available";
  language: string;
  automatic: boolean;
  cached: boolean;
  blocks: TranscriptBlock[];
}

export interface TranscriptPreparationResponse {
  transcriptStatus: "checking";
  retryAfterMs: number;
}

export type TranscriptResponse =
  | TranscriptDocumentResponse
  | TranscriptPreparationResponse;

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
