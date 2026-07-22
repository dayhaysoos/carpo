import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  deleteSourceVideo,
  listSourceVideos,
  setSourceVideoArchived,
} from "../api";
import type { SourceVideoResponse } from "../types";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api", () => ({
  deleteSourceVideo: vi.fn(),
  listSourceVideos: vi.fn(),
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
    vi.mocked(setSourceVideoArchived).mockImplementation(async (id, archived) => ({
      ...videos.find((video) => video.id === id)!,
      archivedAt: archived ? "2026-07-22T12:00:00Z" : null,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
