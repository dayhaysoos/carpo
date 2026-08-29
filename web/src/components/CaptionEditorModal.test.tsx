import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captionTrackSrtUrl,
  captionTrackVttUrl,
  getCaptionTrack,
  renderCaptionTrack,
  saveCaptionTrack,
} from "../api";
import type { CaptionTrackAvailable, ClipResponse } from "../types";
import { CaptionEditorModal } from "./CaptionEditorModal";

vi.mock("../api", () => ({
  captionTrackVttUrl: vi.fn((clipId: string) => `/captions/${clipId}.vtt`),
  captionTrackSrtUrl: vi.fn((clipId: string) => `/captions/${clipId}.srt`),
  getCaptionTrack: vi.fn(),
  renderCaptionTrack: vi.fn(),
  saveCaptionTrack: vi.fn(),
}));

const clip: ClipResponse = {
  id: "clip-1",
  videoId: "video-1",
  title: "Launch moment",
  source: { type: "upload", key: "uploads/legacy/source.mp4" },
  trimStart: 10,
  trimEnd: 20,
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
  createdAt: "2026-08-28T12:00:00Z",
  updatedAt: "2026-08-28T12:00:00Z",
};

const draft: CaptionTrackAvailable = {
  captionStatus: "available",
  clipId: clip.id,
  clipDurationSeconds: 10,
  saved: false,
  sourceLanguage: "en",
  sourceAutomatic: true,
  cues: [
    { id: "cue-1", startSeconds: 0, endSeconds: 2, text: "First idea" },
  ],
  theme: "classic",
  lastProposalSource: null,
  renderStatus: "none",
  renderErrorMessage: null,
  outputCaptionedMp4: null,
  revision: null,
  updatedAt: null,
};

function renderEditor(onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CaptionEditorModal clip={clip} onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

describe("CaptionEditorModal", () => {
  beforeEach(() => {
    vi.mocked(getCaptionTrack).mockResolvedValue(draft);
    vi.mocked(saveCaptionTrack).mockImplementation(async (_clipId, cues) => ({
      ...draft,
      saved: true,
      cues,
      updatedAt: "2026-08-28T12:05:00Z",
    }));
    vi.mocked(renderCaptionTrack).mockResolvedValue({
      ...draft,
      saved: true,
      renderStatus: "encoding",
      revision: "revision-1",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews the active cue and saves manual corrections", async () => {
    const user = userEvent.setup();
    renderEditor();

    const text = await screen.findByLabelText("Cue 1 text");
    await user.clear(text);
    await user.type(text, "Corrected by hand");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save to export" }).hasAttribute("disabled"),
    ).toBe(true);

    const video = screen.getByLabelText("Launch moment caption preview");
    Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
    fireEvent.timeUpdate(video);
    expect(
      document.querySelector(".caption-preview-text")?.textContent,
    ).toBe("Corrected by hand");

    await user.click(screen.getByRole("button", { name: "Save captions" }));
    await waitFor(() =>
      expect(saveCaptionTrack).toHaveBeenCalledWith(
        clip.id,
        expect.arrayContaining([
          expect.objectContaining({ text: "Corrected by hand" }),
        ]),
        { theme: "classic" },
      ),
    );
    expect(
      (await screen.findByRole("link", { name: "Download VTT" })).getAttribute(
        "href",
      ),
    ).toBe("/captions/clip-1.vtt");
    expect(captionTrackVttUrl).toHaveBeenCalledWith(clip.id);
    expect(captionTrackSrtUrl).toHaveBeenCalledWith(clip.id);
  });

  it("protects unsaved manual corrections when the modal closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor(onClose);

    const text = await screen.findByLabelText("Cue 1 text");
    await user.type(text, " changed");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved caption changes?");
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("can start a manual track while transcript preparation is pending", async () => {
    vi.mocked(getCaptionTrack).mockResolvedValue({
      captionStatus: "checking",
      retryAfterMs: 60_000,
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      await screen.findByRole("button", {
        name: "Start with a blank track",
      }),
    );
    expect(
      screen.getByText(
        "Manual caption track. Review every word and timing before export.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Manual track — save your work")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add cue" }));
    await user.clear(screen.getByLabelText("Cue 1 text"));
    await user.type(screen.getByLabelText("Cue 1 text"), "Written by hand");
    await user.click(screen.getByRole("button", { name: "Save captions" }));

    await waitFor(() =>
      expect(saveCaptionTrack).toHaveBeenCalledWith(
        clip.id,
        expect.arrayContaining([
          expect.objectContaining({ text: "Written by hand" }),
        ]),
        { theme: "classic" },
      ),
    );
  });

  it("keeps an advisory Think proposal unsaved until the user saves it", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CaptionEditorModal
          clip={clip}
          onClose={vi.fn()}
          initialProposal={{
            source: "think",
            baseRevision: null,
            theme: "bold-yellow",
            cues: [
              {
                id: "agent-cue",
                startSeconds: 1,
                endSeconds: 3,
                text: "Suggested by Think",
              },
            ],
          }}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Think suggestion")).toBeTruthy();
    expect(screen.getByDisplayValue("Suggested by Think")).toBeTruthy();
    expect(
      (screen.getByRole("combobox", {
        name: "Caption theme",
      }) as HTMLSelectElement).value,
    ).toBe("bold-yellow");
    expect(
      screen.getByRole("button", { name: "Render captioned MP4" }),
    ).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Save captions" }));
    await waitFor(() =>
      expect(saveCaptionTrack).toHaveBeenCalledWith(
        clip.id,
        expect.arrayContaining([
          expect.objectContaining({ text: "Suggested by Think" }),
        ]),
        { theme: "bold-yellow", proposalSource: "think" },
      ),
    );
  });
});
