import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { CreatorPage } from "./CreatorPage";

const api = vi.hoisted(() => ({
  getSourceVideo: vi.fn(),
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
    getSourceVideo: api.getSourceVideo,
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
});
