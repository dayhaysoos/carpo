import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CreatorPage } from "./CreatorPage";

const api = vi.hoisted(() => ({
  createSourceVideo: vi.fn(),
  getSourceVideo: vi.fn(),
  getVideoTranscript: vi.fn(),
  createClipFromSourceVideo: vi.fn(),
  requestUploadUrl: vi.fn(),
  uploadFileWithProgress: vi.fn(),
}));
const youtubePlayer = vi.hoisted(() => ({
  ready: true,
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    createSourceVideo: api.createSourceVideo,
    getSourceVideo: api.getSourceVideo,
    getVideoTranscript: api.getVideoTranscript,
    createClipFromSourceVideo: api.createClipFromSourceVideo,
    requestUploadUrl: api.requestUploadUrl,
    uploadFileWithProgress: api.uploadFileWithProgress,
  };
});

vi.mock("../hooks/useYoutubePlayer", () => ({
  useYoutubePlayer: (videoId: string | null) => ({
    containerId: "creator-youtube-player",
    ready: Boolean(videoId) && youtubePlayer.ready,
    currentTime: 0,
    duration: videoId && youtubePlayer.ready ? 214 : 0,
    title: videoId && youtubePlayer.ready ? "Fresh YouTube source" : "",
    seekTo: vi.fn(),
  }),
}));

vi.mock("agents/react", () => ({
  useAgent: (options: { onOpen?: () => void }) => {
    useEffect(() => options.onOpen?.(), [options.onOpen]);
    return {};
  },
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

describe("CreatorPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    youtubePlayer.ready = true;
    delete (document as Document & { modelContext?: unknown }).modelContext;
  });

  function renderPage(initialEntry = "/") {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <CreatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("always shows Think before a video is selected", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "New clip" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Clip with Think" }),
    ).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
  });

  it("opens the existing editable review when the registered WebMCP tool proposes a grounded clip", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const video = {
      id: "webmcp-video-id",
      title: "WebMCP upload",
      source: {
        type: "upload" as const,
        key: "uploads/webmcp.mp4",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: 45,
      retainedSourceReady: true,
      transcriptStatus: "available" as const,
      transcriptCheckedAt: "2026-08-27T20:00:00.000Z",
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-08-27T19:00:00.000Z",
      updatedAt: "2026-08-27T20:00:00.000Z",
    };
    const transcript = {
      transcriptStatus: "available" as const,
      language: "en",
      automatic: true,
      cached: true,
      blocks: [
        {
          id: "webmcp-block-1",
          startCueId: "cue-1",
          endCueId: "cue-2",
          startSeconds: 6,
          endSeconds: 12,
          text: "A real passage from the uploaded video.",
        },
      ],
    };
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    api.getVideoTranscript.mockResolvedValue(transcript);
    const registrations = new Map<
      string,
      { execute: (input: unknown) => Promise<unknown> }
    >();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: (
          tool: { name: string; execute: (input: unknown) => Promise<unknown> },
        ) => {
          registrations.set(tool.name, tool);
        },
      },
    });

    renderPage(`/?video=${video.id}`);

    await screen.findByText(video.title);
    await waitFor(() => expect(registrations.has("proposeClips")).toBe(true));
    const readWorkspace = registrations.get("readClipWorkspace");
    const proposeClips = registrations.get("proposeClips");
    if (!readWorkspace || !proposeClips) {
      throw new Error("Expected Carpo WebMCP tools to be registered");
    }
    const workspace = (await readWorkspace.execute({})) as {
      revisions: { workspaceRevision: string };
    };

    await proposeClips.execute({
      requestId: "react-integration",
      videoId: video.id,
      workspaceRevision: workspace.revisions.workspaceRevision,
      proposals: [
        {
          proposalId: "agent-found-moment",
          title: "Agent-found moment",
          startSeconds: 6,
          endSeconds: 12,
          sourceBlockIds: ["webmcp-block-1"],
          rationale: "This passage is concise and self-contained.",
        },
      ],
    });

    expect(
      await screen.findByRole("heading", { name: "Review clips" }),
    ).toBeTruthy();
    expect(screen.getByText("Agent-found moment")).toBeTruthy();
    expect(screen.getByText(/Suggested via WebMCP/)).toBeTruthy();
    expect(
      screen.getByText("This passage is concise and self-contained."),
    ).toBeTruthy();
    const trimStart = screen
      .getAllByRole("slider", { name: "Trim start" })
      .find((element) => element.tagName === "INPUT") as HTMLInputElement;
    fireEvent.change(trimStart, { target: { value: "7" } });
    expect(trimStart.value).toBe("7");
    expect(api.createClipFromSourceVideo).not.toHaveBeenCalled();
  });

  it("activates Think for a valid URL before the player is ready", async () => {
    const user = userEvent.setup();
    youtubePlayer.ready = false;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const video = {
      id: "fresh-video-id",
      title: "Fresh YouTube source",
      source: {
        type: "youtube" as const,
        url: "https://www.youtube.com/watch?v=freshThink01",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: 214,
      retainedSourceReady: false,
      transcriptStatus: "unknown" as const,
      transcriptCheckedAt: null,
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    api.createSourceVideo.mockResolvedValue(video);
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    renderPage();

    await user.click(screen.getByRole("tab", { name: "YouTube URL" }));
    await user.type(
      screen.getByRole("textbox", { name: "YouTube URL" }),
      video.source.url,
    );

    await waitFor(() =>
      expect(api.createSourceVideo).toHaveBeenCalledWith({
        source: video.source,
        title: "YouTube video freshThink01",
      }),
    );
    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
    expect(api.createSourceVideo).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale activation after the pasted URL changes", async () => {
    const user = userEvent.setup();
    const staleVideo = {
      id: "stale-video-id",
      title: "Stale source",
      source: {
        type: "youtube" as const,
        url: "https://www.youtube.com/watch?v=staleThink01",
      },
    };
    const currentVideo = {
      ...staleVideo,
      id: "current-video-id",
      title: "Current source",
      source: {
        type: "youtube" as const,
        url: "https://www.youtube.com/watch?v=currentThink1",
      },
    };
    let resolveStale: (video: typeof staleVideo) => void = () => {};
    const staleRequest = new Promise<typeof staleVideo>((resolve) => {
      resolveStale = resolve;
    });
    api.createSourceVideo.mockImplementation(
      (request: { source: { type: string; url?: string } }) =>
        request.source.url === staleVideo.source.url
          ? staleRequest
          : Promise.resolve(currentVideo),
    );
    api.getSourceVideo.mockResolvedValue({
      video: {
        ...currentVideo,
        clipCount: 0,
        activeClipCount: 0,
        failedClipCount: 0,
        thumbnail: null,
        durationSeconds: 214,
        retainedSourceReady: false,
        transcriptStatus: "unknown",
        transcriptCheckedAt: null,
        transcriptCheckError: null,
        transcriptRetryAt: null,
        archivedAt: null,
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
      clips: [],
    });
    renderPage();

    await user.click(screen.getByRole("tab", { name: "YouTube URL" }));
    const input = screen.getByRole("textbox", { name: "YouTube URL" });
    await user.type(input, staleVideo.source.url);
    await waitFor(() => expect(api.createSourceVideo).toHaveBeenCalledTimes(1));

    await user.clear(input);
    await user.type(input, currentVideo.source.url);
    await waitFor(() => expect(api.createSourceVideo).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(api.getSourceVideo).toHaveBeenCalledWith(currentVideo.id),
    );

    resolveStale(staleVideo);
    await waitFor(() =>
      expect(api.getSourceVideo).not.toHaveBeenCalledWith(staleVideo.id),
    );
  });

  it("finishes activation when player metadata arrives during the request", async () => {
    const user = userEvent.setup();
    youtubePlayer.ready = false;
    const video = {
      id: "metadata-race-video-id",
      title: "YouTube video metadataRace1",
      source: {
        type: "youtube" as const,
        url: "https://www.youtube.com/watch?v=metadataRace1",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: null,
      retainedSourceReady: false,
      transcriptStatus: "unknown" as const,
      transcriptCheckedAt: null,
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    type MetadataRaceVideo = typeof video;
    let finishActivation: (result: MetadataRaceVideo) => void = () => {};
    api.createSourceVideo.mockReturnValue(
      new Promise<MetadataRaceVideo>((resolve) => {
        finishActivation = resolve;
      }),
    );
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    renderPage();

    await user.click(screen.getByRole("tab", { name: "YouTube URL" }));
    await user.type(
      screen.getByRole("textbox", { name: "YouTube URL" }),
      video.source.url,
    );
    await waitFor(() => expect(api.createSourceVideo).toHaveBeenCalledTimes(1));

    youtubePlayer.ready = true;
    await user.tab();
    finishActivation(video);

    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
    expect(api.createSourceVideo).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a library video after choosing another", async () => {
    const user = userEvent.setup();
    const video = {
      id: "library-video-id",
      title: "Library video",
      source: {
        type: "youtube" as const,
        url: "https://www.youtube.com/watch?v=libraryThink1",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: 214,
      retainedSourceReady: false,
      transcriptStatus: "unknown" as const,
      transcriptCheckedAt: null,
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    renderPage(`/?video=${video.id}`);

    await user.click(await screen.findByRole("link", { name: "Choose another" }));

    await waitFor(() => expect(screen.getByText("Waiting")).toBeTruthy());
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(api.createSourceVideo).not.toHaveBeenCalled();
  });

  it("activates Think after a new upload completes", async () => {
    const user = userEvent.setup();
    const video = {
      id: "fresh-upload-id",
      title: "fresh-upload.mp4",
      source: {
        type: "upload" as const,
        key: "uploads/fresh-upload.mp4",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: null,
      retainedSourceReady: true,
      transcriptStatus: "unsupported" as const,
      transcriptCheckedAt: null,
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    api.requestUploadUrl.mockResolvedValue({
      key: video.source.key,
      uploadUrl: "/api/uploads/fresh-upload.mp4",
      maxSizeBytes: 100_000,
      contentType: "video/mp4",
      method: "PUT",
    });
    api.uploadFileWithProgress.mockImplementation(
      async (
        _url: string,
        file: File,
        _contentType: string,
        onProgress: (loaded: number, total: number) => void,
      ) => {
        onProgress(file.size, file.size);
      },
    );
    api.createSourceVideo.mockResolvedValue(video);
    api.getSourceVideo.mockResolvedValue({ video, clips: [] });
    renderPage();

    const file = new File(["video"], "fresh-upload.mp4", {
      type: "video/mp4",
    });
    await user.upload(screen.getByLabelText("Video file"), file);

    await waitFor(() =>
      expect(api.createSourceVideo).toHaveBeenCalledWith({
        source: video.source,
        title: file.name,
      }),
    );
    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
    expect(api.createSourceVideo).toHaveBeenCalledTimes(1);
  });

  it("keeps Think on the latest file when uploads finish out of order", async () => {
    const user = userEvent.setup();
    let finishFirstUpload: () => void = () => {};
    const firstUpload = new Promise<void>((resolve) => {
      finishFirstUpload = resolve;
    });
    api.requestUploadUrl.mockImplementation(
      ({ filename }: { filename: string }) =>
        Promise.resolve({
          key: `uploads/${filename}`,
          uploadUrl: `/api/uploads/${filename}`,
          maxSizeBytes: 100_000,
          contentType: "video/mp4",
          method: "PUT",
        }),
    );
    api.uploadFileWithProgress.mockImplementation(
      async (_url: string, file: File) =>
        file.name === "first.mp4" ? firstUpload : Promise.resolve(),
    );
    const latestVideo = {
      id: "latest-upload-id",
      title: "second.mp4",
      source: {
        type: "upload" as const,
        key: "uploads/second.mp4",
      },
      clipCount: 0,
      activeClipCount: 0,
      failedClipCount: 0,
      thumbnail: null,
      durationSeconds: null,
      retainedSourceReady: true,
      transcriptStatus: "unsupported" as const,
      transcriptCheckedAt: null,
      transcriptCheckError: null,
      transcriptRetryAt: null,
      archivedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    api.createSourceVideo.mockResolvedValue(latestVideo);
    api.getSourceVideo.mockResolvedValue({ video: latestVideo, clips: [] });
    renderPage();

    const input = screen.getByLabelText("Video file");
    await user.upload(
      input,
      new File(["first"], "first.mp4", { type: "video/mp4" }),
    );
    await waitFor(() =>
      expect(api.uploadFileWithProgress).toHaveBeenCalledTimes(1),
    );
    await user.upload(
      input,
      new File(["second"], "second.mp4", { type: "video/mp4" }),
    );

    await waitFor(() =>
      expect(api.createSourceVideo).toHaveBeenCalledWith({
        source: latestVideo.source,
        title: latestVideo.title,
      }),
    );
    finishFirstUpload();
    await waitFor(() =>
      expect(api.createSourceVideo).not.toHaveBeenCalledWith({
        source: { type: "upload", key: "uploads/first.mp4" },
        title: "first.mp4",
      }),
    );
    expect(api.createSourceVideo).toHaveBeenCalledTimes(1);
  });

  it("abandons an upload when the source mode changes", async () => {
    const user = userEvent.setup();
    let finishUpload: () => void = () => {};
    const upload = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    api.requestUploadUrl.mockResolvedValue({
      key: "uploads/abandoned.mp4",
      uploadUrl: "/api/uploads/abandoned.mp4",
      maxSizeBytes: 100_000,
      contentType: "video/mp4",
      method: "PUT",
    });
    api.uploadFileWithProgress.mockReturnValue(upload);
    renderPage();

    await user.upload(
      screen.getByLabelText("Video file"),
      new File(["video"], "abandoned.mp4", { type: "video/mp4" }),
    );
    await waitFor(() =>
      expect(api.uploadFileWithProgress).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("tab", { name: "YouTube URL" }));

    finishUpload();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(
      screen.getByRole("textbox", { name: "YouTube URL" }),
    ).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(api.createSourceVideo).not.toHaveBeenCalled();
  });
});
