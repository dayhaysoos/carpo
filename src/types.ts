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

export type SourceType = "youtube" | "upload";

export const MAX_CAPTION_LENGTH = 200;

export const FILTER_TYPES = ["caption"] as const;

export type FilterType = (typeof FILTER_TYPES)[number];

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
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
  filters: FilterSpec[];
}

export interface ClipRecord {
  id: string;
  title: string;
  source_type: SourceType;
  source_ref: string;
  trim_start: number;
  trim_end: number;
  caption: string | null;
  filters_json: string;
  status: ClipStatus;
  error_message: string | null;
  failure_mode: FailureMode | null;
  output_mp4_key: string | null;
  output_thumbnail_key: string | null;
  callback_secret: string;
  created_at: string;
  updated_at: string;
}

export interface ClipOutputs {
  mp4: string | null;
  thumbnail: string | null;
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
  outputs: ClipOutputs;
  createdAt: string;
  updatedAt: string;
}

export interface EncoderJobSpec {
  jobId: string;
  source: ClipSource;
  trimStart: number;
  trimEnd: number;
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
}

export interface StatusUpdateRequest {
  status: ClipStatus;
  errorMessage?: string | null;
}
