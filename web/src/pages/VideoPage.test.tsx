import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  deleteClip,
  deleteSourceVideo,
  getClipDistribution,
  getSourceVideo,
  requestGifExport,
  setSourceVideoArchived,
} from "../api";
import type { ClipResponse, SourceVideoDetailResponse } from "../types";
import { VideoPage } from "./VideoPage";

vi.mock("../api", () => ({
  deleteClip: vi.fn(),
  deleteSourceVideo: vi.fn(),
  createClipExport: vi.fn(),
  createClipShare: vi.fn(),
  getClipDistribution: vi.fn(),
  getSourceVideo: vi.fn(),
  requestGifExport: vi.fn(),
  revokeClipShare: vi.fn(),
  setSourceVideoArchived: vi.fn(),
}));

function clip(
  id: string,
  title: string,
  status: ClipResponse["status"] = "complete",
): ClipResponse {
  return {
    id,
    videoId: "video-1",
    title,
    source: { type: "youtube", url: "https://youtu.be/source" },
    trimStart: 0,
    trimEnd: 3,
    quality: "1080p",
    caption: null,
    filters: [],
    status,
    errorMessage: status === "failed" ? "Encoding failed" : null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: {
      mp4: status === "complete" ? `/clips/${id}.mp4` : null,
      thumbnail: status === "complete" ? `/clips/${id}.jpg` : null,
      gif: null,
    },
    createdAt: "2026-07-23T12:00:00Z",
    updatedAt: "2026-07-23T12:00:00Z",
  };
}

const detail: SourceVideoDetailResponse = {
  video: {
    id: "video-1",
    title: "Source video",
    source: { type: "youtube", url: "https://youtu.be/source" },
    clipCount: 3,
    activeClipCount: 0,
    failedClipCount: 1,
    thumbnail: null,
    durationSeconds: 60,
    retainedSourceReady: true,
    transcriptStatus: "available",
    transcriptCheckedAt: "2026-07-23T12:00:00Z",
    transcriptCheckError: null,
    transcriptRetryAt: null,
    archivedAt: null,
    createdAt: "2026-07-23T12:00:00Z",
    updatedAt: "2026-07-23T12:00:00Z",
  },
  clips: [
    clip("clip-1", "First clip"),
    clip("clip-2", "Second clip"),
    clip("clip-3", "Failed clip", "failed"),
  ],
};

function renderVideoPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/library/videos/video-1"]}>
        <Routes>
          <Route path="/library/videos/:videoId" element={<VideoPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("VideoPage clip actions", () => {
  beforeEach(() => {
    vi.mocked(getSourceVideo).mockResolvedValue(detail);
    vi.mocked(getClipDistribution).mockResolvedValue({
      clipId: "clip-1",
      clipTitle: "First clip",
      shares: [],
      exports: [
        {
          id: "original-mp4",
          label: "Original MP4",
          description: "Original",
          status: "ready",
          downloadUrl: "/clips/clip-1.mp4",
          errorMessage: null,
        },
        {
          id: "captioned-mp4",
          label: "Captioned MP4",
          description: "Captioned",
          status: "unavailable",
          downloadUrl: null,
          errorMessage: null,
        },
        {
          id: "looping-gif",
          label: "Looping GIF",
          description: "GIF",
          status: "unavailable",
          downloadUrl: null,
          errorMessage: null,
        },
      ],
    });
    vi.mocked(deleteClip).mockResolvedValue();
    vi.mocked(deleteSourceVideo).mockResolvedValue();
    vi.mocked(requestGifExport).mockResolvedValue(detail.clips[0]);
    vi.mocked(setSourceVideoArchived).mockResolvedValue(detail.video);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("plays and downloads the captioned version directly from the clip card", async () => {
    const captioned = { ...detail.clips[0], outputs: { ...detail.clips[0].outputs, captionedMp4: "/artifacts/captioned-render.mp4" } };
    vi.mocked(getSourceVideo).mockResolvedValue({ ...detail, clips: [captioned] });
    renderVideoPage();
    expect((await screen.findByRole("link", { name: "Download captioned MP4" })).getAttribute("href")).toBe("/artifacts/captioned-render.mp4?download=1");
    await userEvent.setup().click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByLabelText("First clip video").getAttribute("src")).toBe("/artifacts/captioned-render.mp4");
  });

  it("selects every clip and deletes them after one confirmation", async () => {
    const user = userEvent.setup();
    renderVideoPage();
    await screen.findByText("First clip");

    await user.click(screen.getByRole("button", { name: "Select clips" }));
    await user.click(screen.getByRole("button", { name: "Select all clips" }));

    expect(screen.getByText("3 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(
      screen.getByRole("heading", { name: "Delete 3 clips?" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete 3 clips" }));
    await waitFor(() => expect(deleteClip).toHaveBeenCalledTimes(3));
    expect(deleteClip).toHaveBeenCalledWith("clip-1");
    expect(deleteClip).toHaveBeenCalledWith("clip-2");
    expect(deleteClip).toHaveBeenCalledWith("clip-3");
  });

  it("keeps failed bulk clip deletions selected for retry", async () => {
    vi.mocked(deleteClip)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Storage is temporarily unavailable"))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    renderVideoPage();
    await screen.findByText("First clip");

    await user.click(screen.getByRole("button", { name: "Select clips" }));
    await user.click(screen.getByRole("button", { name: "Select all clips" }));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    await user.click(screen.getByRole("button", { name: "Delete 3 clips" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Delete clip?" }),
      ).toBeTruthy();
    });
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "2 succeeded. Could not delete 1 clip.",
    );
  });

  it("moves between completed clip previews with arrow keys", async () => {
    const user = userEvent.setup();
    renderVideoPage();
    await screen.findByText("First clip");

    await user.click(
      screen.getByRole("button", { name: "Play First clip" }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "First clip" }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();

    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("heading", { level: 2, name: "Second clip" }),
    ).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();

    await user.keyboard("{ArrowLeft}");
    expect(
      screen.getByRole("heading", { level: 2, name: "First clip" }),
    ).toBeTruthy();
  });

  it("leaves arrow-key seeking to the focused video player", async () => {
    const user = userEvent.setup();
    renderVideoPage();
    await screen.findByText("First clip");

    await user.click(
      screen.getByRole("button", { name: "Play First clip" }),
    );
    const player = screen.getByLabelText("First clip video");
    player.focus();
    fireEvent.keyDown(player, { key: "ArrowRight" });

    expect(
      screen.getByRole("heading", { level: 2, name: "First clip" }),
    ).toBeTruthy();
  });

  it("opens owner-managed sharing and export controls for a completed clip", async () => {
    const user = userEvent.setup();
    renderVideoPage();
    await screen.findByText("First clip");

    const distributionButtons = screen.getAllByRole("button", {
      name: "Share & export",
    });
    await user.click(distributionButtons[0]);

    expect(
      await screen.findByRole("heading", { name: "Public share links" }),
    ).toBeTruthy();
    expect(getClipDistribution).toHaveBeenCalledWith("clip-1");
  });
});
