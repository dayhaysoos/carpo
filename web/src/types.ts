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
  captionedMp4?: string | null;
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
  sourceFailure?: RemoteSourceFailure | null;
  gifStatus: GifStatus;
  gifErrorMessage: string | null;
  outputs: ClipOutputs;
  createdAt: string;
  updatedAt: string;
}

export interface CaptionCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export const CAPTION_THEME_IDS = [
  "classic",
  "high-contrast-box",
  "bold-yellow",
] as const;

export type CaptionThemeId = (typeof CAPTION_THEME_IDS)[number];
export type CaptionProposalSource = "think" | "webmcp";
export type CaptionRenderStatus = "none" | "encoding" | "complete" | "failed";

export interface CaptionTrackAvailable {
  captionStatus: "available";
  clipId: string;
  clipDurationSeconds: number;
  saved: boolean;
  sourceLanguage: string | null;
  sourceAutomatic: boolean | null;
  cues: CaptionCue[];
  theme: CaptionThemeId;
  lastProposalSource: CaptionProposalSource | null;
  renderStatus: CaptionRenderStatus;
  renderErrorMessage: string | null;
  outputCaptionedMp4: string | null;
  revision: string | null;
  updatedAt: string | null;
}

export interface CaptionTrackProposal {
  source: CaptionProposalSource;
  baseRevision: string | null;
  cues: CaptionCue[];
  theme: CaptionThemeId;
}

export interface CaptionTrackProposalInput {
  clipId: string;
  baseRevision: string | null;
  cues: CaptionCue[];
  theme: CaptionThemeId;
}

export interface CaptionTrackChecking {
  captionStatus: "checking";
  retryAfterMs: number;
}

export type CaptionTrackResponse =
  | CaptionTrackAvailable
  | CaptionTrackChecking;

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
  remoteIngestion?: RemoteSourceIngestionView | null;
  transcriptStatus: TranscriptStatus;
  transcriptCheckedAt: string | null;
  transcriptCheckError: string | null;
  transcriptRetryAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RemoteSourceFailureCode =
  | "rate_limited"
  | "login_required"
  | "unsupported_media"
  | "provider_changed"
  | "geo_restricted"
  | "unavailable"
  | "unknown";

export interface RemoteSourceFailure {
  provider: "youtube";
  code: RemoteSourceFailureCode;
  message: string;
  retryable: boolean;
  recovery: {
    type: "upload";
    href: string;
    label: string;
  };
}

export interface RemoteSourceIngestionView {
  provider: "youtube";
  status: "pending" | "importing" | "ready" | "failed";
  failure: RemoteSourceFailure | null;
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

export type ClipShareStatus = "active" | "expired" | "revoked";
export type ShareExpirationPreset = "day" | "week" | "month" | "never";
export type ClipExportPreset =
  | "original-mp4"
  | "captioned-mp4"
  | "looping-gif";
export type ClipExportStatus =
  | "ready"
  | "preparing"
  | "unavailable"
  | "failed";

export interface ClipShareSummary {
  url?: string;
  id: string;
  status: ClipShareStatus;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdByEmail: string;
}

export interface ClipDistributionExport {
  id: ClipExportPreset;
  label: string;
  description: string;
  status: ClipExportStatus;
  downloadUrl: string | null;
  errorMessage: string | null;
}

export interface ClipDistributionView {
  clipId: string;
  clipTitle: string;
  shares: ClipShareSummary[];
  exports: ClipDistributionExport[];
}

export interface ClipShareCreatedResult {
  type: "share-created";
  share: ClipShareSummary;
  token: string;
  url: string;
}

export interface ClipShareRevokedResult {
  type: "share-revoked";
  share: ClipShareSummary;
}

export interface ClipExportResult {
  type: "export";
  export: ClipDistributionExport;
  started: boolean;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ApiError {
  error: string;
  details?: ValidationError[];
}

export interface CurrentUserResponse {
  id: string;
  email: string | null;
}

export type LibrarySearchMode = "exact" | "meaning";

export interface LibrarySearchResult {
  resultId: string;
  mode: LibrarySearchMode;
  query: string;
  video: {
    id: string;
    title: string;
    sourceType: "youtube" | "upload";
    archived: boolean;
  };
  evidence: {
    blockIds: string[];
    text: string;
    startSeconds: number;
    endSeconds: number;
  };
  proposedRange: {
    startSeconds: number;
    endSeconds: number;
  };
  revisions: {
    transcriptRevision: string;
    videoRevision: string;
  };
  similarityScore?: number;
}

export interface LibrarySearchResponse {
  query: string;
  mode: LibrarySearchMode;
  results: LibrarySearchResult[];
  coverage: {
    totalVideos: number;
    searchableVideos: number;
    unavailableVideos: number;
  };
  meaningStatus?: "available" | "unavailable";
  meaningMessage?: string;
}

export interface PrepareLibraryMomentRequest {
  resultId: string;
  mode: LibrarySearchMode;
  query: string;
  videoId: string;
  transcriptRevision: string;
  videoRevision: string;
  blockIds: string[];
  evidenceStartSeconds: number;
  evidenceEndSeconds: number;
}

export interface PreparedLibraryMomentReview {
  proposalId: string;
  searchResultId: string;
  videoId: string;
  reviewUrl: string;
  input: {
    title: string;
    startSeconds: number;
    endSeconds: number;
    quality: "1080p";
  };
  evidence: {
    rationale: string;
    sourceBlockIds: string[];
    workspaceRevision: string;
  };
}

export type VisualConfidence = "low" | "medium" | "high";

export interface VisualMomentResult {
  resultId: string;
  query: string;
  videoId: string;
  sourceRevision: string;
  proposedRange: { startSeconds: number; endSeconds: number };
  evidence: Array<{
    observationId: string;
    timestampSeconds: number;
    frameUrl: string;
    confidence: VisualConfidence;
    uncertainty: string;
    rationale: string;
  }>;
}

export interface VisualSearchResponse {
  query: string;
  videoId: string;
  sourceRevision: string;
  sampledFrameCount: number;
  coverageMessage: string;
  results: VisualMomentResult[];
}

export interface PrepareVisualMomentRequest {
  resultId: string;
  query: string;
  videoId: string;
  sourceRevision: string;
  observationIds: string[];
  startSeconds: number;
  endSeconds: number;
}

export interface PreparedVisualMomentReview {
  proposalId: string;
  searchResultId: string;
  videoId: string;
  reviewUrl: string;
  input: {
    title: string;
    startSeconds: number;
    endSeconds: number;
    quality: "1080p";
  };
  evidence: {
    rationale: string;
    sourceFrameIds: string[];
    sourceRevision: string;
  };
}
