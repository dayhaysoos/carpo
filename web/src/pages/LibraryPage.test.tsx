import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  deleteSourceVideo,
  listSourceVideos,
  prepareLibraryMomentReview,
  searchPrivateLibrary,
  setSourceVideoArchived,
} from "../api";
import type { SourceVideoResponse } from "../types";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api", () => ({
  deleteSourceVideo: vi.fn(),
  listSourceVideos: vi.fn(),
  prepareLibraryMomentReview: vi.fn(),
  searchPrivateLibrary: vi.fn(),
  setSourceVideoArchived: vi.fn(),
}));

const videos: SourceVideoResponse[] = [
  {
    id: "first-video",
    title: "First video",
    source: { type: "youtube", url: "https://youtu.be/first" },
    clipCount: 2,
    activeClipCount: 0,
  failedClipCount: 0,
  thumbnail: null,
  durationSeconds: null,
  retainedSourceReady: false,
  transcriptStatus: "unknown",
  transcriptCheckedAt: null,
  transcriptCheckError: null,
  transcriptRetryAt: null,
  archivedAt: null,
    createdAt: "2026-07-20T12:00:00Z",
    updatedAt: "2026-07-20T12:00:00Z",
  },
  {
    id: "second-video",
    title: "Second video",
    source: { type: "upload", key: "uploads/second.mp4" },
    clipCount: 3,
    activeClipCount: 0,
  failedClipCount: 0,
  thumbnail: null,
  durationSeconds: null,
  retainedSourceReady: true,
  transcriptStatus: "unknown",
  transcriptCheckedAt: null,
  transcriptCheckError: null,
  transcriptRetryAt: null,
  archivedAt: null,
    createdAt: "2026-07-21T12:00:00Z",
    updatedAt: "2026-07-21T12:00:00Z",
  },
];

function renderLibrary() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/library"]}>
        <LibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Library video actions", () => {
  beforeEach(() => {
    vi.mocked(listSourceVideos).mockResolvedValue({
      videos,
      total: videos.length,
      limit: 24,
      offset: 0,
    });
    vi.mocked(deleteSourceVideo).mockResolvedValue();
    vi.mocked(searchPrivateLibrary).mockResolvedValue({
      query: "",
      mode: "exact",
      results: [],
      coverage: { totalVideos: 2, searchableVideos: 0, unavailableVideos: 2 },
    });
    vi.mocked(prepareLibraryMomentReview).mockResolvedValue({
      proposalId: "prepared-library-proposal",
      searchResultId: "search-result",
      videoId: "first-video",
      reviewUrl: "/?video=first-video&libraryProposal=prepared-library-proposal",
      input: {
        title: "Private launch — First video",
        startSeconds: 9,
        endSeconds: 16,
        quality: "1080p",
      },
      evidence: {
        rationale: "Grounded transcript match",
        sourceBlockIds: ["cue-0-1"],
        workspaceRevision: "video-revision:transcript-revision",
      },
    });
    vi.mocked(setSourceVideoArchived).mockImplementation(async (id, archived) => ({
      ...videos.find((video) => video.id === id)!,
      archivedAt: archived ? "2026-07-22T12:00:00Z" : null,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (document as Document & { modelContext?: unknown }).modelContext;
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext;
  });

  it("selects multiple videos and deletes them after one confirmation", async () => {
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    await user.click(screen.getByRole("button", { name: "Select videos" }));
    await user.click(
      screen.getByRole("button", { name: "Select First video, 2 clips" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select Second video, 3 clips" }),
    );

    expect(screen.getByText("2 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(
      screen.getByRole("heading", { name: "Delete 2 videos?" }),
    ).toBeTruthy();
    expect(screen.getByText(/their 5 clips/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete 2 videos" }));
    await waitFor(() => {
      expect(deleteSourceVideo).toHaveBeenCalledTimes(2);
    });
    expect(deleteSourceVideo).toHaveBeenCalledWith("first-video");
    expect(deleteSourceVideo).toHaveBeenCalledWith("second-video");
  });

  it("keeps an individual delete retryable without entering selection mode", async () => {
    vi.mocked(deleteSourceVideo)
      .mockRejectedValueOnce(new Error("Storage is temporarily unavailable"))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    await user.click(
      screen.getByRole("button", { name: "More actions for First video" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete video" }));

    expect(screen.getByRole("heading", { name: "Delete video?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete video" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not delete 1 video.",
      );
    });
    expect(
      screen.getByRole("link", { name: "Open First video, 2 clips" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete video" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Delete video?" }),
      ).toBeNull();
    });
    expect(deleteSourceVideo).toHaveBeenCalledTimes(2);
    expect(deleteSourceVideo).toHaveBeenNthCalledWith(1, "first-video");
    expect(deleteSourceVideo).toHaveBeenNthCalledWith(2, "first-video");
  });

  it("clears an individual archive failure after a successful retry", async () => {
    vi.mocked(setSourceVideoArchived)
      .mockRejectedValueOnce(new Error("Archive failed"))
      .mockResolvedValueOnce({ ...videos[0], archivedAt: "2026-07-22T12:00:00Z" });
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    const openMenu = async () => {
      await user.click(
        screen.getByRole("button", { name: "More actions for First video" }),
      );
    };
    await openMenu();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not archive 1 video.",
      );
    });
    expect(
      screen.getByRole("link", { name: "Open First video, 2 clips" }),
    ).toBeTruthy();

    await openMenu();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(setSourceVideoArchived).toHaveBeenCalledTimes(2);
  });

  it("keeps failed bulk deletions selected so they can be retried", async () => {
    vi.mocked(deleteSourceVideo)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Storage is temporarily unavailable"));
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    await user.click(screen.getByRole("button", { name: "Select videos" }));
    await user.click(screen.getByRole("button", { name: "Select all loaded" }));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    await user.click(screen.getByRole("button", { name: "Delete 2 videos" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Delete video?" }),
      ).toBeTruthy();
    });
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "1 succeeded. Could not delete 1 video.",
    );
    expect(
      screen.getByRole("button", { name: "Delete video" }),
    ).toBeTruthy();
  });

  it("searches exact transcript evidence and prepares the selected moment for review", async () => {
    vi.mocked(searchPrivateLibrary).mockResolvedValue({
      query: "private launch",
      mode: "exact",
      coverage: { totalVideos: 2, searchableVideos: 1, unavailableVideos: 1 },
      results: [
        {
          resultId: "search-result",
          mode: "exact",
          query: "private launch",
          video: {
            id: "first-video",
            title: "First video",
            sourceType: "youtube",
            archived: false,
          },
          evidence: {
            blockIds: ["cue-0-1"],
            text: "The private launch starts tomorrow",
            startSeconds: 10,
            endSeconds: 14,
          },
          proposedRange: { startSeconds: 9, endSeconds: 16 },
          revisions: {
            transcriptRevision: "transcript-revision",
            videoRevision: "video-revision",
          },
        },
      ],
    });
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    await user.type(screen.getByRole("searchbox", { name: "Word or phrase" }), "private launch");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("The private launch starts tomorrow")).toBeTruthy();
    expect(screen.getByText(/Searched 1 of 2 videos/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review moment" }));
    await waitFor(() => {
      expect(prepareLibraryMomentReview).toHaveBeenCalledWith({
        resultId: "search-result",
        mode: "exact",
        query: "private launch",
        videoId: "first-video",
        transcriptRevision: "transcript-revision",
        videoRevision: "video-revision",
        blockIds: ["cue-0-1"],
        evidenceStartSeconds: 10,
        evidenceEndSeconds: 14,
      });
    });
  });

  it("keeps Exact available when optional Meaning search reports an outage", async () => {
    vi.mocked(searchPrivateLibrary).mockResolvedValue({
      query: "trustworthy design",
      mode: "meaning",
      results: [],
      coverage: { totalVideos: 2, searchableVideos: 2, unavailableVideos: 0 },
      meaningStatus: "unavailable",
      meaningMessage: "Meaning search is unavailable. Exact search is still available.",
    });
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("First video");

    await user.click(screen.getByRole("radio", { name: "Meaning" }));
    await user.type(screen.getByRole("searchbox", { name: "Idea or moment" }), "trustworthy design");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Exact search is still available",
    );
    expect(screen.getByRole("radio", { name: "Exact" })).toBeTruthy();
  });

  it("registers the bounded private-Library WebMCP tools on the Library surface", async () => {
    const registered: string[] = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: (tool: { name: string }) => registered.push(tool.name),
      },
    });

    renderLibrary();

    await waitFor(() => {
      expect(registered).toContain("searchPrivateLibrary");
    });
    expect(registered).toEqual([
      "getCarpoLibraryInstructions",
      "searchPrivateLibrary",
      "prepareLibraryMomentReview",
    ]);
  });
});
