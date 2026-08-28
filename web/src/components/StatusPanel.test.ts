import { describe, expect, it } from "vitest";
import { YOUTUBE_BLOCKED_ERROR } from "../errors";
import type { ClipResponse } from "../types";
import { visibleStatusPanelClips } from "./StatusPanel";

function clip(input: {
  id: string;
  videoId: string;
  status: ClipResponse["status"];
  errorMessage?: string;
}): ClipResponse {
  return {
    id: input.id,
    videoId: input.videoId,
    title: input.id,
    source: { type: "youtube", url: "https://youtu.be/example" },
    trimStart: 0,
    trimEnd: 10,
    quality: "1080p",
    caption: null,
    filters: [],
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: { mp4: null, thumbnail: null, gif: null },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
}

describe("StatusPanel scope", () => {
  it("hides the active upload job because its journey renders inline", () => {
    const activeUpload = clip({
      id: "active-upload",
      videoId: "upload-video",
      status: "encoding",
    });
    const otherJob = clip({
      id: "other-job",
      videoId: "other-video",
      status: "queued",
    });

    expect(
      visibleStatusPanelClips([activeUpload, otherJob], {
        excludeVideoId: "upload-video",
      }).visibleClips.map(({ id }) => id),
    ).toEqual(["other-job"]);
  });

  it("keeps only the current YouTube source's blocked failure", () => {
    const currentFailure = clip({
      id: "current-failure",
      videoId: "current-video",
      status: "failed",
      errorMessage: YOUTUBE_BLOCKED_ERROR,
    });
    const unrelatedFailure = clip({
      id: "unrelated-failure",
      videoId: "old-video",
      status: "failed",
      errorMessage: YOUTUBE_BLOCKED_ERROR,
    });

    expect(
      visibleStatusPanelClips([currentFailure, unrelatedFailure], {
        includeBlockedFailureVideoId: "current-video",
      }).visibleClips.map(({ id }) => id),
    ).toEqual(["current-failure"]);
  });
});
