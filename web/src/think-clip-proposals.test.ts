import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ClipProposalReview } from "./clip-proposal-review";
import { extractThinkClipProposalSubmissions } from "./think-clip-proposals";

function messagesWith(...parts: Record<string, unknown>[]): UIMessage[] {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      parts,
    },
  ] as UIMessage[];
}

describe("extractThinkClipProposalSubmissions", () => {
  it("normalizes one assistant turn as a frozen batch and translates rejection", async () => {
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const submissions = extractThinkClipProposalSubmissions(
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

    expect(submissions).toMatchObject([
      {
        submission: {
          adapter: "think",
          requestId: "assistant-1",
          videoId: "video-1",
          proposals: [
            {
              proposalId: "approval-1",
              input: { title: "Opening", startSeconds: 1, endSeconds: 4 },
            },
          ],
        },
      },
    ]);

    await submissions[0].submission.proposals[0].settle({ status: "rejected" });

    expect(addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval-1",
      approved: false,
    });
    expect(addToolOutput).not.toHaveBeenCalled();
  });

  it("keeps proposals from the same assistant turn in one submission", () => {
    const submissions = extractThinkClipProposalSubmissions(
      messagesWith(
        {
          type: "tool-createClip",
          toolCallId: "tool-1",
          state: "input-available",
          input: { title: "First", startSeconds: 1, endSeconds: 4 },
        },
        {
          type: "tool-createClip",
          toolCallId: "tool-2",
          state: "input-available",
          input: { title: "Second", startSeconds: 8, endSeconds: 12 },
        },
      ),
      "video-1",
      { addToolApprovalResponse: vi.fn(), addToolOutput: vi.fn() },
    );

    expect(submissions).toHaveLength(1);
    expect(
      submissions[0].submission.proposals.map(({ proposalId }) => proposalId),
    ).toEqual(["tool-1", "tool-2"]);
  });

  it("translates a created client proposal into Think tool output", async () => {
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const submissions = extractThinkClipProposalSubmissions(
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

    await submissions[0].submission.proposals[0].settle({
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

  it("reports admission failures to Think without adding them to review", async () => {
    const addToolOutput = vi.fn();
    const review = new ClipProposalReview({ create: vi.fn() });
    review.activate({ id: "video-1", durationSeconds: 30 });
    const submissions = extractThinkClipProposalSubmissions(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-invalid-range",
        state: "input-available",
        input: {
          title: "Invalid range",
          startSeconds: 10,
          endSeconds: 5,
        },
      }),
      "video-1",
      { addToolApprovalResponse: vi.fn(), addToolOutput },
    );

    const admission = review.admit(submissions[0].submission);
    await submissions[0].reportAdmission(admission);

    expect(addToolOutput).toHaveBeenCalledWith({
      toolCallId: "tool-invalid-range",
      output: {
        status: "invalid",
        reason: expect.stringContaining("Clip range must be"),
      },
    });
    expect(review.getSnapshot().items).toEqual([]);
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
    const submissions = extractThinkClipProposalSubmissions(
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

    review.activate({ id: "video-1", durationSeconds: 30 });
    const admission = review.admit(submissions[0].submission);
    review.dispatch({
      type: "decide",
      proposalId: admission.items[0].canonicalId!,
      approved: true,
    });

    const firstResult = await review.finish();

    expect(firstResult.created).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot()).toMatchObject({
      items: [
        {
          proposalId: admission.items[0].canonicalId,
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

  it("ignores input that cannot be translated into a Clip Proposal", () => {
    const submissions = extractThinkClipProposalSubmissions(
      messagesWith({
        type: "tool-createClip",
        toolCallId: "tool-invalid",
        state: "input-available",
        input: { title: "Missing timestamps" },
      }),
      "video-1",
      { addToolApprovalResponse: vi.fn(), addToolOutput: vi.fn() },
    );

    expect(submissions).toEqual([]);
  });
});
