export interface Env {
  AI: Ai;
  DB: D1Database;
  CLIPS_BUCKET: R2Bucket;
  ENCODER_CONTAINER: DurableObjectNamespace;
  TRANSCRIPT_PREPARATION: DurableObjectNamespace;
  VideoClipAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  MAX_CLIP_LENGTH_SECONDS: string;
  R2_PUBLIC_PREFIX: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  WORKER_BASE_URL?: string;
  HELPER_TOKEN?: string;
  HELPER_CLAIM_WINDOW_SECONDS?: string;
  YOUTUBE_TITLE_TIMEOUT_MS?: string;
}
