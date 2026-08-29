declare module "cloudflare:workers" {
  interface Env {
    DB: D1Database;
    LIBRARY_TRANSCRIPT_INDEX?: VectorizeIndex;
    CLIPS_BUCKET: R2Bucket;
    ENCODER_CONTAINER: DurableObjectNamespace;
    ASSETS: Fetcher;
    MAX_CLIP_LENGTH_SECONDS: string;
    R2_PUBLIC_PREFIX: string;
    R2_ENDPOINT?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_BUCKET_NAME?: string;
    WORKER_BASE_URL?: string;
    YOUTUBE_TITLE_TIMEOUT_MS?: string;
    PR_REVIEW_AUTH_TOKEN?: string;
    PR_REVIEW_MODE?: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
