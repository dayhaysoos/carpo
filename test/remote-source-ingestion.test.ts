import { describe, expect, it } from "vitest";
import {
  classifyRemoteSourceFailure,
  matchRemoteSourceFailure,
  viewRemoteSourceIngestion,
} from "../src/remote-source-ingestion";
import type { SourceVideoRecord } from "../src/types";

function youtubeRecord(
  status: SourceVideoRecord["retained_source_status"],
  error: string | null = null,
): SourceVideoRecord {
  return {
    id: "video-1",
    owner_id: "owner-1",
    source_type: "youtube",
    source_ref: "https://www.youtube.com/watch?v=video-1",
    title: "Remote source",
    clip_count: 0,
    active_clip_count: 0,
    failed_clip_count: 0,
    thumbnail_key: null,
    archived_at: null,
    youtube_title_resolved_at: null,
    youtube_title_checked_at: null,
    retained_source_key:
      status === "ready" ? "sources/youtube/video-1/source.mp4" : null,
    retained_source_status: status,
    retained_source_error: error,
    retained_source_updated_at: null,
    duration_seconds: null,
    transcript_status: "unknown",
    transcript_checked_at: null,
    transcript_check_error: null,
    transcript_retry_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("remote source ingestion", () => {
  it.each([
    ["HTTP Error 429: Too Many Requests", "rate_limited", true],
    ["Sign in to confirm you are not a bot", "login_required", false],
    ["Unsupported URL: no video formats", "unsupported_media", false],
    ["Extractor failed after a provider changed its player response", "provider_changed", true],
    ["This video is not available in your country", "geo_restricted", false],
  ] as const)(
    "classifies %s",
    (raw, code, retryable) => {
      expect(classifyRemoteSourceFailure("youtube", raw)).toMatchObject({
        provider: "youtube",
        code,
        retryable,
        recovery: { type: "upload", href: "/?source=upload" },
      });
    },
  );

  it("presents persisted import state through one typed view", () => {
    expect(viewRemoteSourceIngestion(youtubeRecord("empty"))).toEqual({
      provider: "youtube",
      status: "pending",
      failure: null,
    });
    expect(
      viewRemoteSourceIngestion(
        youtubeRecord("failed", "HTTP Error 429: Too Many Requests"),
      ),
    ).toMatchObject({
      status: "failed",
      failure: { code: "rate_limited" },
    });
  });

  it("does not mislabel an encoder failure as a provider failure", () => {
    expect(
      matchRemoteSourceFailure(
        "youtube",
        "Encoding failed for this video format.",
      ),
    ).toBeNull();
  });
});
