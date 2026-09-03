export interface Env {
  AI: Ai;
  LIBRARY_TRANSCRIPT_INDEX?: VectorizeIndex;
  DB: D1Database;
  CLIPS_BUCKET: R2Bucket;
  ENCODER_CONTAINER: DurableObjectNamespace;
  TRANSCRIPT_PREPARATION: DurableObjectNamespace;
  VideoClipAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  R2_PUBLIC_PREFIX: string;
  AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  WORKER_BASE_URL?: string;
  HELPER_TOKEN?: string;
  HELPER_CLAIM_WINDOW_SECONDS?: string;
  YOUTUBE_TITLE_TIMEOUT_MS?: string;
  PR_REVIEW_AUTH_TOKEN?: string;
  PR_REVIEW_MODE?: string;
  PR_REVIEW_EVIDENCE_BUCKET?: R2Bucket;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}
