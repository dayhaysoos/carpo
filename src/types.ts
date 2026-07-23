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

export type FailureMode = "confirmed" | "ambiguous";

export const GIF_STATUSES = ["none", "encoding", "complete", "failed"] as const;

export type GifStatus = (typeof GIF_STATUSES)[number];

export type SourceType = "youtube" | "upload";

export type RetainedSourceStatus = "empty" | "importing" | "ready" | "failed";

export type HelperState =
  | "pending"
  | "claimed"
  | "fulfilled"
  | "expired"
  | "recovering";

export const MAX_CAPTION_LENGTH = 200;

export const FILTER_TYPES = ["caption"] as const;

export const CLIP_QUALITIES = ["720p", "1080p"] as const;

export type ClipQuality = (typeof CLIP_QUALITIES)[number];

export const DEFAULT_CLIP_QUALITY: ClipQuality = "1080p";

export interface CaptionFilter {
  type: "caption";
  text: string;
}

export type FilterSpec = CaptionFilter;

export interface YoutubeSource {
  type: "youtube";
  url: string;
}

export interface UploadSource {
  type: "upload";
  key: string;
}

export type ClipSource = YoutubeSource | UploadSource;

export interface CreateClipRequest {
  title: string;
  sourceTitle?: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  filters: FilterSpec[];
  quality?: ClipQuality;
}

export interface ClipRecord {
  id: string;
  title: string;
  source_type: SourceType;
  source_ref: string;
  trim_start: number;
  trim_end: number;
  quality: ClipQuality;
  caption: string | null;
  filters_json: string;
  status: ClipStatus;
  error_message: string | null;
  failure_mode: FailureMode | null;
  output_mp4_key: string | null;
  output_thumbnail_key: string | null;
  output_gif_key: string | null;
  gif_status: GifStatus;
  gif_error_message: string | null;
  callback_secret: string;
  helper_state: HelperState | null;
  helper_claimed_at: string | null;
  helper_upload_key: string | null;
  video_id: string | null;
  created_at: string;
  updated_at: string;
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

export interface SourceVideoRecord {
  id: string;
  source_type: SourceType;
  source_ref: string;
  title: string;
  clip_count: number;
  active_clip_count: number;
  failed_clip_count: number;
  thumbnail_key: string | null;
  archived_at: string | null;
  youtube_title_resolved_at: string | null;
  youtube_title_checked_at: string | null;
  retained_source_key: string | null;
  retained_source_status: RetainedSourceStatus;
  retained_source_error: string | null;
  retained_source_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceVideoResponse {
  id: string;
  title: string;
  source: ClipSource;
  clipCount: number;
  activeClipCount: number;
  failedClipCount: number;
  thumbnail: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface ClipListResponse {
  clips: ClipResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface EncoderJobSpec {
  jobId: string;
  sourceVideoId?: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  quality: ClipQuality;
  caption: string | null;
  filters: FilterSpec[];
  maxClipLengthSeconds: number;
  outputs: {
    mp4Key: string;
    thumbnailKey: string;
  };
  callbackUrl: string;
  callbackSecret: string;
  artifactUploadUrls: {
    mp4: string;
    thumbnail: string;
  };
  /** Worker-authenticated URL for the encoder to fetch an upload source. */
  sourceFetchUrl?: string;
  /** Preserve a full YouTube download as a reusable source artifact. */
  retainSourceArtifact?: boolean;
}

export interface GifEncoderJobSpec {
  jobId: string;
  jobType: "gif";
  sourceMp4Key: string;
  source: { type: "file"; path: string };
  outputs: {
    gifKey: string;
  };
  deferArtifactUpload?: boolean;
}

export interface StatusUpdateRequest {
  status: ClipStatus;
  errorMessage?: string | null;
}
