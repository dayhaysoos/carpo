import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ClipProposalReview } from "./clip-proposal-review";
import { extractThinkClipProposals } from "./think-clip-proposals";

function messagesWith(part: Record<string, unknown>): UIMessage[] {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [part],
    },
  ] as UIMessage[];
}

describe("extractThinkClipProposals", () => {
  it("normalizes an approval request and translates rejection", async () => {
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const proposals = extractThinkClipProposals(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-1",
        state: "approval-requested",
        approval: { id: "approval-1" },
        input: {
          title: "Opening",
          startSeconds: 1,
          endSeconds: 4,
          quality: "1080p",
        },
      }),
      "video-1",
      { addToolApprovalResponse, addToolOutput },
    );

    expect(proposals).toMatchObject([
      {
        id: "think:video-1:approval-1",
        videoId: "video-1",
        idempotencyKey: "tool-1",
        input: { title: "Opening", startSeconds: 1, endSeconds: 4 },
      },
    ]);

    await proposals[0].settle({ status: "rejected" });

    expect(addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval-1",
      approved: false,
    });
    expect(addToolOutput).not.toHaveBeenCalled();
  });

  it("translates a created client proposal into Think tool output", async () => {
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const proposals = extractThinkClipProposals(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-client",
        state: "input-available",
        input: {
          title: "Editable",
          startSeconds: 11.5,
          endSeconds: 15,
          quality: "1080p",
        },
      }),
      "video-1",
      { addToolApprovalResponse, addToolOutput },
    );

    await proposals[0].settle({
      status: "created",
      clip: {
        id: "clip-1",
        title: "Editable",
        startSeconds: 11.5,
        endSeconds: 15,
        quality: "1080p",
        status: "queued",
      },
    });

    expect(addToolOutput).toHaveBeenCalledWith({
      toolCallId: "tool-client",
      output: {
        clipId: "clip-1",
        title: "Editable",
        startSeconds: 11.5,
        endSeconds: 15,
        quality: "1080p",
        status: "queued",
      },
    });
    expect(addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("keeps a created proposal retryable when async acknowledgement fails", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "clip-1",
      title: "Retry acknowledgement",
      startSeconds: 2,
      endSeconds: 6,
      quality: "1080p",
      status: "queued",
    });
    const acknowledgementError = new Error("Acknowledgement failed");
    const addToolOutput = vi
      .fn()
      .mockRejectedValueOnce(acknowledgementError)
      .mockResolvedValueOnce(undefined);
    const review = new ClipProposalReview({ create });
    const proposals = extractThinkClipProposals(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-retry",
        state: "input-available",
        input: {
          title: "Retry acknowledgement",
          startSeconds: 2,
          endSeconds: 6,
          quality: "1080p",
        },
      }),
      "video-1",
      { addToolApprovalResponse: vi.fn(), addToolOutput },
    );

    review.activate("video-1");
    review.synchronize("video-1", proposals);
    review.dispatch({
      type: "decide",
      proposalId: proposals[0].id,
      approved: true,
    });

    const firstResult = await review.finish();

    expect(firstResult.created).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot()).toMatchObject({
      items: [
        {
          proposalId: proposals[0].id,
          error: "Acknowledgement failed",
        },
      ],
      submitError: "1 clip proposal could not be completed. Review and retry it.",
    });

    const retryResult = await review.finish();

    expect(retryResult.created).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(addToolOutput).toHaveBeenCalledTimes(2);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("ignores malformed proposal input", () => {
    const proposals = extractThinkClipProposals(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-invalid",
        state: "input-available",
        input: { title: "Missing timestamps" },
      }),
      "video-1",
      { addToolApprovalResponse: vi.fn(), addToolOutput: vi.fn() },
    );

    expect(proposals).toEqual([]);
  });
});
