import { describe, expect, it } from "vitest";
import type { ClipResponse, SourceVideoResponse } from "./types";
import {
  deriveUploadClipTitle,
  getOwnedUploadClipJourneyView,
  INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  updateOwnedUploadClipJourney,
} from "./owned-upload-clip-journey";

const uploadVideo: SourceVideoResponse = {
  id: "upload-video",
  title: "Launch_day-final.MP4",
  source: { type: "upload", key: "uploads/launch.mp4" },
  clipCount: 1,
  activeClipCount: 1,
  failedClipCount: 0,
  thumbnail: null,
  durationSeconds: 45,
  retainedSourceReady: true,
  transcriptStatus: "checking",
  transcriptCheckedAt: null,
  transcriptCheckError: null,
  transcriptRetryAt: null,
  archivedAt: null,
  createdAt: "2026-08-28T12:00:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
};

function clip(status: ClipResponse["status"]): ClipResponse {
  return {
    id: "first-clip",
    videoId: uploadVideo.id,
    title: "Launch day final",
    source: uploadVideo.source,
    trimStart: 2,
    trimEnd: 12,
    quality: "1080p",
    caption: null,
    filters: [],
    status,
    errorMessage: status === "failed" ? "Encoder failed" : null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: {
      mp4: status === "complete" ? "/clips/first-clip.mp4" : null,
      thumbnail: null,
      gif: null,
    },
    createdAt: "2026-08-28T12:05:00.000Z",
    updatedAt: "2026-08-28T12:05:00.000Z",
  };
}

describe("owned upload clip journey", () => {
  it("turns an upload filename into an editable clip title", () => {
    expect(deriveUploadClipTitle("Launch_day-final.MP4")).toBe(
      "Launch day final",
    );
    expect(deriveUploadClipTitle("folder/product demo.webm")).toBe(
      "product demo",
    );
  });

  it("tracks the exact created clip and prefers its refreshed server state", () => {
    const activated = updateOwnedUploadClipJourney(
      INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
      { type: "source-changed", sourceVideoId: uploadVideo.id },
    );
    const queued = updateOwnedUploadClipJourney(activated, {
      type: "clip-created",
      sourceVideoId: uploadVideo.id,
      clip: { id: "first-clip", title: "Launch day final", status: "queued" },
    });

    expect(
      getOwnedUploadClipJourneyView({
        state: queued,
        video: uploadVideo,
        clips: [],
      }),
    ).toMatchObject({ phase: "rendering", createdClip: { status: "queued" } });

    expect(
      getOwnedUploadClipJourneyView({
        state: queued,
        video: uploadVideo,
        clips: [clip("complete")],
      }),
    ).toMatchObject({
      phase: "complete",
      clip: { id: "first-clip", outputs: { mp4: "/clips/first-clip.mp4" } },
      createdClip: { status: "complete" },
    });
  });

  it("drops stale clip state when the active source changes", () => {
    const state = updateOwnedUploadClipJourney(
      {
        sourceVideoId: uploadVideo.id,
        createdClip: {
          id: "first-clip",
          title: "Launch day final",
          status: "encoding",
        },
      },
      { type: "source-changed", sourceVideoId: "another-video" },
    );

    expect(state).toEqual({
      sourceVideoId: "another-video",
      createdClip: null,
    });
  });

  it("restores the newest clip for an uploaded source after a page reload", () => {
    const olderClip = {
      ...clip("complete"),
      id: "older-clip",
      title: "Older clip",
      createdAt: "2026-08-28T11:00:00.000Z",
    };
    const latestClip = clip("encoding");
    const state = updateOwnedUploadClipJourney(
      INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
      { type: "source-changed", sourceVideoId: uploadVideo.id },
    );

    expect(
      getOwnedUploadClipJourneyView({
        state,
        video: uploadVideo,
        clips: [olderClip, latestClip],
      }),
    ).toMatchObject({
      phase: "rendering",
      clip: { id: latestClip.id },
      createdClip: { id: latestClip.id },
    });
  });
});
