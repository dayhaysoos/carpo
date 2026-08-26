import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClipProposalReview,
  type ClipProposalEnvelope,
  type ClipProposalOutcome,
  type ClipProposalPersistence,
  type CreatedClipResult,
} from "./clip-proposal-review";

type CreateClip = ClipProposalPersistence["create"];

function proposal(
  id: string,
  startSeconds: number,
  settle = vi.fn<(outcome: ClipProposalOutcome) => void>(),
): ClipProposalEnvelope {
  return {
    id,
    videoId: "video-1",
    idempotencyKey: `tool-${id}`,
    input: {
      title: `Clip ${id}`,
      startSeconds,
      endSeconds: startSeconds + 3,
      quality: "1080p",
    },
    settle,
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
    review.activate("video-1");
  });

  it("freezes a chronological batch and queues proposals that arrive later", async () => {
    review.synchronize("video-1", [proposal("late", 40), proposal("first", 2)]);

    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      "first",
      "late",
    ]);
    review.dispatch({
      type: "edit",
      proposalId: "first",
      input: {
        ...review.getSnapshot().items[0].input,
        startSeconds: 2.5,
        endSeconds: 6,
      },
    });

    review.synchronize("video-1", [
      { ...proposal("first", 20), input: { ...proposal("first", 20).input } },
      proposal("next", 1),
    ]);

    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      "first",
      "late",
    ]);
    expect(review.getSnapshot().items[0].input.startSeconds).toBe(2.5);

    review.dispatch({ type: "decide-all", approved: false });
    await review.finish();

    expect(review.getSnapshot().items.map(({ proposalId }) => proposalId)).toEqual([
      "next",
    ]);
  });

  it("refreshes adapter callbacks without publishing an unchanged snapshot", async () => {
    const originalSettle = vi.fn();
    const refreshedSettle = vi.fn();
    review.synchronize("video-1", [proposal("stable", 2, originalSettle)]);
    const listener = vi.fn();
    review.subscribe(listener);

    review.synchronize("video-1", [proposal("stable", 2, refreshedSettle)]);

    expect(listener).not.toHaveBeenCalled();
    review.dispatch({ type: "decide-all", approved: false });
    await review.finish();
    expect(originalSettle).not.toHaveBeenCalled();
    expect(refreshedSettle).toHaveBeenCalledWith({ status: "rejected" });
  });

  it("preserves edits and reversible decisions when dismissed or switching videos", () => {
    review.synchronize("video-1", [proposal("editable", 10)]);
    const edited = {
      ...review.getSnapshot().items[0].input,
      startSeconds: 11.5,
      endSeconds: 15,
    };
    review.dispatch({ type: "edit", proposalId: "editable", input: edited });
    review.dispatch({ type: "decide", proposalId: "editable", approved: true });
    review.dispatch({ type: "decide", proposalId: "editable", approved: false });
    review.dispatch({ type: "dismiss" });

    review.activate("video-2");
    expect(review.getSnapshot().items).toEqual([]);
    review.activate("video-1");

    expect(review.getSnapshot()).toMatchObject({
      isOpen: false,
      items: [
        {
          proposalId: "editable",
          input: edited,
          decision: false,
        },
      ],
    });
  });

  it("continues after a persistence failure and retries only the failed proposal", async () => {
    let failMiddle = true;
    create.mockImplementation(async (item: { id: string }, input) => {
      if (item.id === "middle" && failMiddle) {
        failMiddle = false;
        throw new Error("temporary persistence failure");
      }
      return createdClip(item.id, input.startSeconds);
    });
    const first = proposal("first", 0);
    const middle = proposal("middle", 10);
    const last = proposal("last", 20);
    review.synchronize("video-1", [first, middle, last]);
    review.dispatch({ type: "decide-all", approved: true });

    const firstResult = await review.finish();

    expect(firstResult.created.map(({ id }) => id)).toEqual([
      "clip-first",
      "clip-last",
    ]);
    expect(firstResult.created).toHaveLength(2);
    expect(create.mock.calls.map(([item]) => item.id)).toEqual([
      "first",
      "middle",
      "last",
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
          proposalId: "middle",
          decision: true,
          error: "temporary persistence failure",
        },
      ],
    });

    const retryResult = await review.finish();

    expect(retryResult.created.map(({ id }) => id)).toEqual(["clip-middle"]);
    expect(create.mock.calls.map(([item]) => item.id)).toEqual([
      "first",
      "middle",
      "last",
      "middle",
    ]);
    expect(middle.settle).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("persists approved proposals one at a time", async () => {
    const started: string[] = [];
    let releaseFirst = () => {};
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    create.mockImplementation(async (item: { id: string }, input) => {
      started.push(item.id);
      if (item.id === "first") await firstFinished;
      return createdClip(item.id, input.startSeconds);
    });
    review.synchronize("video-1", [
      proposal("first", 0),
      proposal("second", 10),
    ]);
    review.dispatch({ type: "decide-all", approved: true });

    const finishing = review.finish();
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    releaseFirst();
    await finishing;

    expect(started).toEqual(["first", "second"]);
  });

  it("retries acknowledgement without recreating a persisted clip", async () => {
    let rejectAcknowledgement = true;
    const settle = vi.fn(() => {
      if (rejectAcknowledgement) {
        rejectAcknowledgement = false;
        throw new Error("acknowledgement interrupted");
      }
    });
    review.synchronize("video-1", [proposal("once", 4, settle)]);
    review.dispatch({ type: "decide-all", approved: true });

    const firstResult = await review.finish();
    expect(firstResult.created).toHaveLength(1);
    expect(review.getSnapshot().items).toMatchObject([
      { proposalId: "once", decision: true },
    ]);

    const retryResult = await review.finish();
    expect(retryResult.created).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("settles rejected proposals without invoking persistence", async () => {
    const first = proposal("first", 0);
    const second = proposal("second", 10);
    review.synchronize("video-1", [first, second]);
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
    review.synchronize("video-1", [proposal("rejected-once", 0, settle)]);
    review.dispatch({ type: "decide-all", approved: false });

    await review.finish();
    await review.finish();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(review.getSnapshot().items).toEqual([]);
  });
});
