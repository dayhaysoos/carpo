import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClipProposalReview,
  MAX_QUEUED_CLIP_PROPOSAL_BATCHES,
  type ClipProposalDraft,
  type ClipProposalOutcome,
  type ClipProposalPersistence,
  type ClipProposalSubmission,
  type CreatedClipResult,
} from "./clip-proposal-review";

type CreateClip = ClipProposalPersistence["create"];

function canonical(
  requestId: string,
  proposalId: string,
  adapter: "think" | "webmcp" = "think",
  videoId = "video-1",
): string {
  return `${adapter}:${videoId}:${requestId}:${proposalId}`;
}

function proposal(
  proposalId: string,
  startSeconds: number,
  settle = vi.fn<(outcome: ClipProposalOutcome) => void>(),
): ClipProposalDraft {
  return {
    proposalId,
    input: {
      title: `Clip ${proposalId}`,
      startSeconds,
      endSeconds: startSeconds + 3,
      quality: "1080p",
    },
    settle,
  };
}

function submission(
  requestId: string,
  proposals: ClipProposalDraft[],
  options: Partial<Pick<ClipProposalSubmission, "adapter" | "atomic" | "videoId">> = {},
): ClipProposalSubmission {
  return {
    adapter: options.adapter ?? "think",
    requestId,
    videoId: options.videoId ?? "video-1",
    ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
    proposals,
  };
}

function createdClip(id: string, startSeconds: number): CreatedClipResult {
  return {
    id: `clip-${id}`,
    title: `Clip ${id}`,
    startSeconds,
    endSeconds: startSeconds + 3,
    quality: "1080p",
    status: "queued",
  };
}

describe("ClipProposalReview", () => {
  let create: ReturnType<typeof vi.fn<CreateClip>>;
  let review: ClipProposalReview;

  beforeEach(() => {
    create = vi.fn<CreateClip>(async (item, input) =>
      createdClip(item.id, input.startSeconds),
    );
    review = new ClipProposalReview({ create });
    review.activate({ id: "video-1", durationSeconds: 90 });
  });

  it("freezes chronological batches and preserves manual edits across retries", async () => {
    review.admit(
      submission("batch-1", [proposal("late", 40), proposal("first", 2)]),
    );

    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      canonical("batch-1", "first"),
      canonical("batch-1", "late"),
    ]);
    review.dispatch({
      type: "edit",
      proposalId: canonical("batch-1", "first"),
      input: {
        ...review.getSnapshot().items[0].input,
        startSeconds: 2.5,
        endSeconds: 6,
      },
    });

    const replay = review.admit(
      submission("batch-1", [
        { ...proposal("first", 20), input: { ...proposal("first", 20).input } },
        proposal("late", 40),
      ]),
    );
    const queued = review.admit(submission("batch-2", [proposal("next", 1)]));

    expect(replay.items.every(({ replayed }) => replayed)).toBe(true);
    expect(queued.items).toMatchObject([{ state: "queued" }]);
    expect(review.getSnapshot().items[0].input.startSeconds).toBe(2.5);

    review.dispatch({ type: "decide-all", approved: false });
    await review.finish();

    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      canonical("batch-2", "next"),
    ]);
  });

  it("intakes prepared Library and Visual handoffs through one review-owned path", () => {
    const library = review.intakePrepared(
      { id: "video-1", durationSeconds: 90 },
      {
        adapter: "library",
        requestId: "library-handoff",
        videoId: "video-1",
        proposalId: "library-result",
        input: proposal("library-result", 2).input,
        evidence: {
          rationale: "A grounded transcript result.",
          sourceBlockIds: ["block-1"],
          workspaceRevision: "workspace-1",
        },
      },
    );
    const visual = review.intakePrepared(
      { id: "video-1", durationSeconds: 90 },
      {
        adapter: "visual",
        requestId: "visual-handoff",
        videoId: "video-1",
        proposalId: "visual-result",
        input: proposal("visual-result", 8).input,
        evidence: {
          rationale: "A grounded sampled-frame result.",
          sourceFrameIds: ["frame-1"],
          sourceRevision: "source-1",
        },
      },
    );
    const replay = review.intakePrepared(
      { id: "video-1", durationSeconds: 90 },
      {
        adapter: "library",
        requestId: "library-handoff",
        videoId: "video-1",
        proposalId: "library-result",
        input: proposal("library-result", 2).input,
      },
    );

    expect(library).toMatchObject({
      status: "accepted",
      consumable: true,
      issues: [],
    });
    expect(visual).toMatchObject({
      status: "queued",
      consumable: true,
      issues: [],
    });
    expect(replay).toMatchObject({
      status: "replayed",
      consumable: true,
      issues: [],
    });
    expect(review.getSnapshot().items).toMatchObject([
      {
        provenance: {
          adapter: "library",
          sourceBlockIds: ["block-1"],
          workspaceRevision: "workspace-1",
        },
      },
    ]);
  });

  it("rejects a prepared handoff for a different active Video", () => {
    const result = review.intakePrepared(
      { id: "video-1", durationSeconds: 90 },
      {
        adapter: "visual",
        requestId: "wrong-video-handoff",
        videoId: "video-2",
        proposalId: "visual-result",
        input: proposal("visual-result", 8).input,
      },
    );

    expect(result).toMatchObject({
      status: "rejected",
      consumable: false,
      issues: [{ code: "VIDEO_MISMATCH" }],
    });
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("refreshes adapter callbacks without publishing an unchanged snapshot", async () => {
    const originalSettle = vi.fn();
    const refreshedSettle = vi.fn();
    review.admit(
      submission("stable-batch", [proposal("stable", 2, originalSettle)]),
    );
    const listener = vi.fn();
    review.subscribe(listener);

    review.admit(
      submission("stable-batch", [proposal("stable", 2, refreshedSettle)]),
    );

    expect(listener).not.toHaveBeenCalled();
    review.dispatch({ type: "decide-all", approved: false });
    await review.finish();
    expect(originalSettle).not.toHaveBeenCalled();
    expect(refreshedSettle).toHaveBeenCalledWith({ status: "rejected" });
  });

  it("preserves edits and reversible decisions when dismissed or switching Videos", () => {
    review.admit(submission("editable-batch", [proposal("editable", 10)]));
    const edited = {
      ...review.getSnapshot().items[0].input,
      startSeconds: 11.5,
      endSeconds: 15,
    };
    review.dispatch({
      type: "edit",
      proposalId: canonical("editable-batch", "editable"),
      input: edited,
    });
    review.dispatch({
      type: "decide",
      proposalId: canonical("editable-batch", "editable"),
      approved: true,
    });
    review.dispatch({
      type: "decide",
      proposalId: canonical("editable-batch", "editable"),
      approved: false,
    });
    review.dispatch({ type: "dismiss" });

    review.activate({ id: "video-2", durationSeconds: 60 });
    expect(review.getSnapshot().items).toEqual([]);
    review.activate({ id: "video-1", durationSeconds: 90 });

    expect(review.getSnapshot()).toMatchObject({
      isOpen: false,
      items: [
        {
          proposalId: canonical("editable-batch", "editable"),
          input: edited,
          decision: false,
        },
      ],
    });
  });

  it("admits clips longer than 60 seconds and rejects only ranges past the Video duration", () => {
    const longProposal = proposal("long", 0);
    longProposal.input.endSeconds = 75;
    const result = review.admit(
      submission("partial", [
        proposal("valid", 2),
        longProposal,
        {
          ...proposal("invalid", 5),
          input: { ...proposal("invalid", 5).input, endSeconds: 91 },
        },
      ]),
    );

    expect(result.items).toMatchObject([
      { proposalId: "valid", state: "ready-for-review", issues: [] },
      { proposalId: "long", state: "ready-for-review", issues: [] },
      {
        proposalId: "invalid",
        state: "rejected",
        issues: [{ code: "INVALID_RANGE" }],
      },
    ]);
    expect(review.getSnapshot().items).toHaveLength(2);
    expect(review.getSnapshot().items[0].input).toMatchObject({
      startSeconds: 0,
      endSeconds: 75,
    });
  });

  it("owns title, quality, and Overlay Text validation for every adapter", () => {
    const invalidTitle = proposal("title", 2);
    invalidTitle.input.title = "   ";
    const invalidQuality = proposal("quality", 8);
    invalidQuality.input.quality = "4k" as never;
    const invalidOverlay = proposal("overlay", 14);
    invalidOverlay.input.caption = "x".repeat(501);

    const result = review.admit(
      submission("shared-rules", [
        invalidTitle,
        invalidQuality,
        invalidOverlay,
      ]),
    );

    expect(result.items.map(({ issues }) => issues[0].code)).toEqual([
      "INVALID_TITLE",
      "INVALID_QUALITY",
      "INVALID_OVERLAY_TEXT",
    ]);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("keeps atomic submissions out of review when any proposal is invalid", () => {
    const result = review.admit(
      submission(
        "atomic",
        [
          proposal("valid", 2),
          {
            ...proposal("invalid", 5),
            input: { ...proposal("invalid", 5).input, endSeconds: 91 },
          },
        ],
        { adapter: "webmcp", atomic: true },
      ),
    );

    expect(result.items.map(({ state }) => state)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(result.items[0].issues[0].code).toBe("ATOMIC_SUBMISSION_REJECTED");
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("derives canonical identity and normalizes provenance", () => {
    const result = review.admit({
      adapter: "webmcp",
      requestId: "agent-run",
      videoId: "video-1",
      proposals: [
        {
          ...proposal("opening", 4),
          evidence: {
            rationale: "A grounded opening.",
            sourceBlockIds: ["block-1"],
            workspaceRevision: "revision-1",
            contractVersion: "contract-1",
          },
        },
      ],
    });

    expect(result.items).toMatchObject([
      {
        canonicalId: canonical("agent-run", "opening", "webmcp"),
        state: "ready-for-review",
      },
    ]);
    expect(review.getSnapshot().items).toMatchObject([
      {
        provenance: {
          adapter: "webmcp",
          label: "WebMCP",
          rationale: "A grounded opening.",
          sourceBlockIds: ["block-1"],
          workspaceRevision: "revision-1",
          contractVersion: "contract-1",
          proposedAt: expect.any(String),
        },
      },
    ]);
  });

  it("keeps an admitted batch frozen when a retry introduces a new proposal", () => {
    review.admit(submission("frozen", [proposal("original", 2)]));

    const retry = review.admit(
      submission("frozen", [
        proposal("original", 2),
        proposal("unexpected", 8),
      ]),
    );

    expect(retry.items).toMatchObject([
      { proposalId: "original", replayed: true, state: "ready-for-review" },
      {
        proposalId: "unexpected",
        state: "rejected",
        issues: [{ code: "BATCH_FROZEN" }],
      },
    ]);
    expect(review.getSnapshot().items).toHaveLength(1);
  });

  it("rejects batches containing more than ten proposals", () => {
    const result = review.admit(
      submission(
        "too-large",
        Array.from({ length: 11 }, (_, index) =>
          proposal(`proposal-${index}`, index * 4),
        ),
      ),
    );

    expect(result.items).toHaveLength(11);
    expect(result.items.every(({ state }) => state === "rejected")).toBe(true);
    expect(result.items[0].issues[0].code).toBe("BATCH_TOO_LARGE");
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("returns a structured submission issue for an empty batch", () => {
    const result = review.admit(submission("empty", []));

    expect(result.items).toEqual([]);
    expect(result.issues).toMatchObject([{ code: "BATCH_TOO_LARGE" }]);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("keeps queued batches separate and rejects submissions beyond the queue limit", async () => {
    review.admit(submission("active", [proposal("active", 0)]));
    for (let index = 0; index < MAX_QUEUED_CLIP_PROPOSAL_BATCHES; index += 1) {
      const result = review.admit(
        submission(`queued-${index}`, [proposal(`queued-${index}`, index + 5)]),
      );
      expect(result.items[0].state).toBe("queued");
    }

    const overflow = review.admit(
      submission("overflow", [proposal("overflow", 30)]),
    );
    expect(overflow.items).toMatchObject([
      { state: "rejected", issues: [{ code: "QUEUE_FULL" }] },
    ]);

    review.dispatch({ type: "decide-all", approved: false });
    await review.finish();
    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      canonical("queued-0", "queued-0"),
    ]);
  });

  it("continues after a persistence failure and retries only the failed proposal", async () => {
    let failMiddle = true;
    create.mockImplementation(async (item, input) => {
      if (item.id === canonical("retry-batch", "middle") && failMiddle) {
        failMiddle = false;
        throw new Error("temporary persistence failure");
      }
      return createdClip(item.id, input.startSeconds);
    });
    const first = proposal("first", 0);
    const middle = proposal("middle", 10);
    const last = proposal("last", 20);
    review.admit(submission("retry-batch", [first, middle, last]));
    review.dispatch({ type: "decide-all", approved: true });

    const firstResult = await review.finish();

    expect(firstResult.created).toHaveLength(2);
    expect(create.mock.calls.map(([item]) => item.id)).toEqual([
      canonical("retry-batch", "first"),
      canonical("retry-batch", "middle"),
      canonical("retry-batch", "last"),
    ]);
    expect(first.settle).toHaveBeenCalledTimes(1);
    expect(middle.settle).not.toHaveBeenCalled();
    expect(last.settle).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot()).toMatchObject({
      isOpen: true,
      approvedCount: 1,
      allReviewed: true,
      items: [
        {
          proposalId: canonical("retry-batch", "middle"),
          decision: true,
          error: "temporary persistence failure",
        },
      ],
    });

    const retryResult = await review.finish();

    expect(retryResult.created).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(4);
    expect(middle.settle).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("persists approved proposals one at a time", async () => {
    const started: string[] = [];
    let releaseFirst = () => {};
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    create.mockImplementation(async (item, input) => {
      started.push(item.id);
      if (item.id === canonical("sequential", "first")) await firstFinished;
      return createdClip(item.id, input.startSeconds);
    });
    review.admit(
      submission("sequential", [proposal("first", 0), proposal("second", 10)]),
    );
    review.dispatch({ type: "decide-all", approved: true });

    const finishing = review.finish();
    await vi.waitFor(() =>
      expect(started).toEqual([canonical("sequential", "first")]),
    );
    releaseFirst();
    await finishing;

    expect(started).toEqual([
      canonical("sequential", "first"),
      canonical("sequential", "second"),
    ]);
  });

  it("retries acknowledgement without recreating a persisted Clip", async () => {
    let rejectAcknowledgement = true;
    const settle = vi.fn(() => {
      if (rejectAcknowledgement) {
        rejectAcknowledgement = false;
        throw new Error("acknowledgement interrupted");
      }
    });
    review.admit(submission("ack", [proposal("once", 4, settle)]));
    review.dispatch({ type: "decide-all", approved: true });

    const firstResult = await review.finish();
    expect(firstResult.created).toHaveLength(1);
    expect(review.getSnapshot().items).toHaveLength(1);

    const retryResult = await review.finish();
    expect(retryResult.created).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("revalidates edited ranges against the latest Video context", async () => {
    review.admit(submission("revalidate", [proposal("range", 20)]));
    review.dispatch({ type: "decide-all", approved: true });
    review.activate({ id: "video-1", durationSeconds: 21 });

    await review.finish();

    expect(create).not.toHaveBeenCalled();
    expect(review.getSnapshot().items).toMatchObject([
      { error: "Clip range exceeds the 21-second Video duration." },
    ]);
  });

  it("settles rejected proposals without invoking persistence", async () => {
    const first = proposal("first", 0);
    const second = proposal("second", 10);
    review.admit(submission("reject", [first, second]));
    review.dispatch({ type: "decide-all", approved: false });

    await review.finish();

    expect(create).not.toHaveBeenCalled();
    expect(first.settle).toHaveBeenCalledWith({ status: "rejected" });
    expect(second.settle).toHaveBeenCalledWith({ status: "rejected" });
  });

  it("attempts rejection acknowledgement only once", async () => {
    const settle = vi.fn(() => {
      throw new Error("provider acknowledgement failed");
    });
    review.admit(
      submission("reject-once", [proposal("rejected-once", 0, settle)]),
    );
    review.dispatch({ type: "decide-all", approved: false });

    await review.finish();
    await review.finish();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("cancels active and queued batches for an explicitly discarded Video", async () => {
    const active = proposal("active", 0);
    const queued = proposal("queued", 10);
    review.admit(submission("active-batch", [active]));
    review.admit(submission("queued-batch", [queued]));

    await review.cancel("video-1");

    expect(active.settle).toHaveBeenCalledWith({ status: "cancelled" });
    expect(queued.settle).toHaveBeenCalledWith({ status: "cancelled" });
    expect(review.getSnapshot()).toMatchObject({ videoId: "", items: [] });
  });
});
