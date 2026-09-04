import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { CreatorPage } from "./CreatorPage";

const api = vi.hoisted(() => ({
  createClipFromSourceVideo: vi.fn(),
  getSourceVideo: vi.fn(),
  getVideoTranscript: vi.fn(),
  updateSourceVideoDuration: vi.fn().mockResolvedValue({}),
}));
const nativePlayer = vi.hoisted(() => ({
  mediaStateSourceUrl: "",
  duration: 0,
  ready: false,
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    createClipFromSourceVideo: api.createClipFromSourceVideo,
    getSourceVideo: api.getSourceVideo,
    getVideoTranscript: api.getVideoTranscript,
    updateSourceVideoDuration: api.updateSourceVideoDuration,
  };
});

vi.mock("../hooks/useNativeVideoPlayer", () => ({
  useNativeVideoPlayer: () => ({
    videoRef: { current: null },
    ready: nativePlayer.ready,
    duration: nativePlayer.duration,
    currentTime: 0,
    error: false,
    seekTo: vi.fn(),
    mediaStateSourceUrl: nativePlayer.mediaStateSourceUrl,
  }),
}));

vi.mock("../hooks/useYoutubePlayer", () => ({
  useYoutubePlayer: () => ({
    containerId: "creator-youtube-player",
    ready: false,
    currentTime: 0,
    duration: 0,
    title: "",
    seekTo: vi.fn(),
  }),
}));

vi.mock("agents/react", () => ({
  useAgent: () => ({}),
}));

vi.mock("@cloudflare/think/react", () => ({
  useAgentChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    addToolOutput: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("../components/StatusPanel", () => ({
  StatusPanel: () => null,
}));

function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back</button>;
}

function uploadVideo(id: string, title: string, durationSeconds: number) {
  return {
    id,
    title,
    source: {
      type: "upload" as const,
      key: `uploads/${title}`,
    },
    clipCount: 0,
    activeClipCount: 0,
    failedClipCount: 0,
    thumbnail: null,
    durationSeconds,
    retainedSourceReady: true,
    transcriptStatus: "available" as const,
    transcriptCheckedAt: null,
    transcriptCheckError: null,
    transcriptRetryAt: null,
    archivedAt: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("CreatorPage upload metadata", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    nativePlayer.mediaStateSourceUrl = "";
    nativePlayer.duration = 0;
    nativePlayer.ready = false;
  });

  it("does not persist a previous upload's duration after browser back", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const firstVideo = uploadVideo("first-upload-id", "first.mp4", 57.8);
    const secondVideo = uploadVideo("second-upload-id", "second.mp4", 1);
    nativePlayer.mediaStateSourceUrl = `/api/videos/${secondVideo.id}/source`;
    nativePlayer.duration = secondVideo.durationSeconds;
    nativePlayer.ready = true;
    api.getSourceVideo.mockImplementation((videoId: string) =>
      Promise.resolve({
        video: videoId === firstVideo.id ? firstVideo : secondVideo,
        clips: [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[
            `/?video=${firstVideo.id}`,
            `/?video=${secondVideo.id}`,
          ]}
          initialIndex={1}
        >
          <BackButton />
          <CreatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(secondVideo.title);
    api.updateSourceVideoDuration.mockClear();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(firstVideo.title);
    await waitFor(() =>
      expect(api.getSourceVideo).toHaveBeenCalledWith(firstVideo.id),
    );

    expect(api.updateSourceVideoDuration).not.toHaveBeenCalledWith(
      firstVideo.id,
      secondVideo.durationSeconds,
    );
  });

  it("creates a 20-minute clip from a one-hour uploaded Video", async () => {
    const user = userEvent.setup();
    const video = uploadVideo("long-upload-id", "Long_recording.mp4", 60 * 60);
    const queuedClip = {
      id: "long-clip",
      videoId: video.id,
      title: "Long recording",
      source: video.source,
      trimStart: 0,
      trimEnd: 20 * 60,
      quality: "1080p" as const,
      caption: null,
      filters: [],
      status: "queued" as const,
      errorMessage: null,
      gifStatus: "none" as const,
      gifErrorMessage: null,
      outputs: { mp4: null, thumbnail: null, gif: null },
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    };
    nativePlayer.mediaStateSourceUrl = `/api/videos/${video.id}/source`;
    nativePlayer.duration = video.durationSeconds;
    nativePlayer.ready = true;
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    api.getVideoTranscript.mockResolvedValue({
      transcriptStatus: "available",
      language: "en",
      automatic: false,
      cached: true,
      blocks: [],
    });
    api.createClipFromSourceVideo.mockResolvedValue(queuedClip);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/?video=${video.id}`]}>
          <CreatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const titleInput = await screen.findByRole("textbox", { name: "Title" });
    await waitFor(() =>
      expect((titleInput as HTMLInputElement).value).toBe("Long recording"),
    );
    const endInput = screen.getByRole("textbox", {
      name: "End",
    }) as HTMLInputElement;
    await user.clear(endInput);
    await user.type(endInput, "20:00.000");
    await user.tab();

    const createButton = screen.getByRole("button", { name: "Create clip" });
    await waitFor(() =>
      expect((createButton as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(createButton);

    await waitFor(() =>
      expect(api.createClipFromSourceVideo).toHaveBeenCalledWith(video.id, {
        title: "Long recording",
        trimStart: 0,
        trimEnd: 20 * 60,
        filters: [],
        quality: "1080p",
      }),
    );
  });

  it("keeps the exact uploaded clip inline through completion", async () => {
    const user = userEvent.setup();
    const video = uploadVideo("upload-id", "Launch_day-final.MP4", 45);
    const queuedClip = {
      id: "first-clip",
      videoId: video.id,
      title: "Launch day final",
      source: video.source,
      trimStart: 0,
      trimEnd: 10,
      quality: "1080p" as const,
      caption: null,
      filters: [],
      status: "queued" as const,
      errorMessage: null,
      gifStatus: "none" as const,
      gifErrorMessage: null,
      outputs: { mp4: null, thumbnail: null, gif: null },
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    };
    nativePlayer.mediaStateSourceUrl = `/api/videos/${video.id}/source`;
    nativePlayer.duration = 45;
    nativePlayer.ready = true;
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    api.getVideoTranscript.mockResolvedValue({
      transcriptStatus: "available",
      language: "en",
      automatic: false,
      cached: true,
      blocks: [],
    });
    api.createClipFromSourceVideo.mockResolvedValue(queuedClip);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/?video=${video.id}`]}>
          <CreatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const titleInput = await screen.findByRole("textbox", { name: "Title" });
    await waitFor(() =>
      expect((titleInput as HTMLInputElement).value).toBe("Launch day final"),
    );
    const createButton = screen.getByRole("button", { name: "Create clip" });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(createButton);

    await waitFor(() =>
      expect(api.createClipFromSourceVideo).toHaveBeenCalledWith(video.id, {
        title: "Launch day final",
        trimStart: 0,
        trimEnd: 10,
        filters: [],
        quality: "1080p",
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Preview Launch day final, Queued",
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Preview Launch day final/ }),
    ).toHaveLength(1);

    queryClient.setQueryData(["source-video", video.id], {
      video: { ...video, activeClipCount: 0 },
      clips: [
        {
          ...queuedClip,
          status: "complete",
          outputs: {
            mp4: "/api/clips/first-clip.mp4",
            thumbnail: "/api/clips/first-clip.jpg",
            gif: null,
          },
        },
      ],
    });

    const completedRow = await screen.findByRole("button", {
      name: "Preview Launch day final, Complete",
    });
    expect(
      screen.getAllByRole("button", { name: /Preview Launch day final/ }),
    ).toHaveLength(1);
    await user.click(completedRow);
    expect(
      await screen.findByRole("region", {
        name: "Preview Launch day final",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Download" }).getAttribute("href"),
    ).toBe("/api/clips/first-clip.mp4?download=1");
  });
});
