import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareVisualMomentReview,
  searchVisualMoments,
} from "../api";
import { VisualMomentSearchPanel } from "./VisualMomentSearchPanel";

vi.mock("../api", () => ({
  prepareVisualMomentReview: vi.fn(),
  searchVisualMoments: vi.fn(),
}));

function renderPanel(onPrepared = vi.fn()) {
  return {
    onPrepared,
    ...render(
      <QueryClientProvider client={new QueryClient()}>
        <VisualMomentSearchPanel videoId="video-1" onPrepared={onPrepared} />
      </QueryClientProvider>,
    ),
  };
}

describe("VisualMomentSearchPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows sampled evidence and opens the editable review without creating a clip", async () => {
    vi.mocked(searchVisualMoments).mockResolvedValue({
      query: "blue logo",
      videoId: "video-1",
      sourceRevision: "source-1",
      sampledFrameCount: 8,
      coverageMessage: "Checked 8 evenly sampled frames. Appearances between sampled frames may be missed.",
      results: [
        {
          resultId: "result-1",
          query: "blue logo",
          videoId: "video-1",
          sourceRevision: "source-1",
          proposedRange: { startSeconds: 2, endSeconds: 4 },
          evidence: [
            {
              observationId: "observation-1",
              timestampSeconds: 3,
              frameUrl: "/api/visual-evidence/observation-1",
              confidence: "medium",
              uncertainty: "Partly obscured",
              rationale: "A blue logo is visible",
            },
          ],
        },
      ],
    });
    vi.mocked(prepareVisualMomentReview).mockResolvedValue({
      proposalId: "proposal-1",
      searchResultId: "result-1",
      videoId: "video-1",
      reviewUrl: "/?video=video-1&visualProposal=proposal-1",
      input: { title: "blue logo", startSeconds: 2, endSeconds: 4, quality: "1080p" },
      evidence: {
        rationale: "Sampled visual match",
        sourceFrameIds: ["observation-1"],
        sourceRevision: "source-1",
      },
    });
    const user = userEvent.setup();
    const { onPrepared } = renderPanel();

    await user.type(screen.getByLabelText("What should Carpo look for?"), "blue logo");
    await user.click(screen.getByRole("button", { name: "Find moments" }));

    expect(await screen.findByText(/may be missed/i)).toBeTruthy();
    expect(screen.getByAltText(/sampled video frame at/i)).toBeTruthy();
    expect(screen.getByText(/Uncertainty: Partly obscured/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review timestamps" }));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledWith("proposal-1"));
    expect(prepareVisualMomentReview).toHaveBeenCalledWith(
      expect.objectContaining({
        resultId: "result-1",
        observationIds: ["observation-1"],
      }),
    );
  });
});
