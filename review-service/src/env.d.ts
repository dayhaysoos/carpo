declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    ASSETS: Fetcher;
    BROWSER: Fetcher;
    EVIDENCE_BUCKET: R2Bucket;
    AUDIT_API_TOKEN?: string;
    REVIEW_VIEW_TOKEN?: string;
    TARGET_REVIEW_AUTH_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_READ_TOKEN?: string;
    TARGET_REVIEW_ORIGIN: string;
    REPORT_ORIGIN: string;
    CARPO_PR_REVIEW_MODEL: string;
    GITHUB_REPOSITORY?: string;
    TARGET_REVIEW_WORKER_NAME?: string;
  }
}

interface Env extends Cloudflare.Env {}
