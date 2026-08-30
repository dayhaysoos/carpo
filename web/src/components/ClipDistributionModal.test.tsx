import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClipExport,
  createClipShare,
  getClipDistribution,
  revokeClipShare,
} from "../api";
import type { ClipDistributionView, ClipResponse } from "../types";
import { ClipDistributionModal } from "./ClipDistributionModal";

vi.mock("../api", () => ({
  createClipExport: vi.fn(),
  createClipShare: vi.fn(),
  getClipDistribution: vi.fn(),
  revokeClipShare: vi.fn(),
}));

const clip: ClipResponse = {
  id: "clip-1",
  videoId: "video-1",
  title: "Launch moment",
  source: { type: "upload", key: "uploads/legacy/video.mp4" },
  trimStart: 0,
  trimEnd: 8,
  quality: "1080p",
  caption: null,
  filters: [],
  status: "complete",
  errorMessage: null,
  gifStatus: "none",
  gifErrorMessage: null,
  outputs: {
    mp4: "/artifacts/clips/clip-1/clip.mp4",
    thumbnail: null,
    gif: null,
  },
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

const view: ClipDistributionView = {
  clipId: clip.id,
  clipTitle: clip.title,
  shares: [
    {
      id: "share-1",
      status: "active",
      createdAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-09-06T12:00:00.000Z",
      revokedAt: null,
      createdByEmail: "owner@example.com",
    },
  ],
  exports: [
    {
      id: "original-mp4",
      label: "Original MP4",
      description: "Original",
      status: "ready",
      downloadUrl: "/artifacts/clips/clip-1/clip.mp4",
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
};

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClipDistributionModal clip={clip} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("ClipDistributionModal", () => {
  beforeEach(() => {
    vi.mocked(getClipDistribution).mockResolvedValue(view);
    vi.mocked(createClipShare).mockResolvedValue({
      type: "share-created",
      share: {
        id: "share-2",
        status: "active",
        createdAt: "2026-08-30T13:00:00.000Z",
        expiresAt: "2026-09-06T13:00:00.000Z",
        revokedAt: null,
        createdByEmail: "owner@example.com",
      },
      token: "a".repeat(43),
      url: `https://carpo.example/share/${"a".repeat(43)}`,
    });
    vi.mocked(revokeClipShare).mockResolvedValue({
      type: "share-revoked",
      share: { ...view.shares[0], status: "revoked", revokedAt: "2026-08-30T14:00:00.000Z" },
    });
    vi.mocked(createClipExport).mockResolvedValue({
      type: "export",
      export: { ...view.exports[2], status: "preparing" },
      started: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("creates a seven-day link by default and leaves it manually copyable", async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByRole("heading", { name: "Private share links" });

    expect((screen.getByLabelText("Share expiration") as HTMLSelectElement).value).toBe("week");
    await user.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() => expect(createClipShare).toHaveBeenCalledWith(clip.id, "week"));
    const link = await screen.findByLabelText("New share link");
    expect((link as HTMLInputElement).readOnly).toBe(true);
    expect((link as HTMLInputElement).value).toContain("/share/");
    expect(screen.getByText(/stores only its secure hash/i)).toBeTruthy();
  });

  it("revokes an active share and starts the GIF preset", async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByRole("heading", { name: "Private share links" });

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeClipShare).toHaveBeenCalledWith(clip.id, "share-1"));
    expect(await screen.findByText("Revoked link")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create GIF" }));
    await waitFor(() =>
      expect(createClipExport).toHaveBeenCalledWith(clip.id, "looping-gif"),
    );
    expect(await screen.findByRole("button", { name: "Preparing…" })).toBeTruthy();
  });
});
