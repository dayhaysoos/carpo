import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ClipResponse } from "../types";
import type { OwnedUploadClipJourneyView } from "../owned-upload-clip-journey";
import { OwnedUploadClipResult } from "./OwnedUploadClipResult";

function completeClip(): ClipResponse {
  return {
    id: "clip-1",
    videoId: "video-1",
    title: "Launch day",
    source: { type: "upload", key: "uploads/launch.mp4" },
    trimStart: 1,
    trimEnd: 12,
    quality: "1080p",
    caption: null,
    filters: [],
    status: "complete",
    errorMessage: null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: {
      mp4: "/clips/clip-1.mp4",
      thumbnail: "/clips/clip-1.jpg",
      gif: null,
    },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:01:00.000Z",
  };
}

function renderResult(journey: OwnedUploadClipJourneyView) {
  return render(
    <MemoryRouter>
      <OwnedUploadClipResult journey={journey} />
    </MemoryRouter>,
  );
}

describe("OwnedUploadClipResult", () => {
  it("keeps an encoding clip visible in the upload workspace", () => {
    renderResult({
      sourceVideoId: "video-1",
      phase: "rendering",
      clip: null,
      createdClip: { id: "clip-1", title: "Launch day", status: "encoding" },
    });

    expect(screen.getByRole("heading", { name: "Launch day" })).toBeTruthy();
    expect(screen.getByText("Encoding")).toBeTruthy();
    expect(screen.getByText("Your clip is being prepared.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open in Library" }).getAttribute("href"),
    ).toBe("/library/videos/video-1");
  });

  it("offers playback and download when the exact clip completes", () => {
    const clip = completeClip();
    renderResult({
      sourceVideoId: clip.videoId,
      phase: "complete",
      clip,
      createdClip: clip,
    });

    expect(
      screen.getByLabelText("Launch day video").getAttribute("src"),
    ).toBe(clip.outputs.mp4);
    expect(
      screen.getByRole("link", { name: "Download MP4" }).getAttribute("href"),
    ).toBe(`${clip.outputs.mp4}?download=1`);
  });
});
