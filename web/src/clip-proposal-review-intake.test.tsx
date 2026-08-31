import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import {
  createUseClipProposalReviewIntake,
  type ClipProposalReviewIntake,
  type ClipProposalReviewIntakeLoader,
} from "./clip-proposal-review-intake";
import {
  ClipProposalReview,
  type ClipProposalPersistence,
  type ClipProposalVideoContext,
  type PreparedClipProposalHandoff,
} from "./clip-proposal-review";

const VIDEO_A: ClipProposalVideoContext = {
  id: "video-a",
  durationSeconds: 90,
};

function preparedHandoff(
  adapter: "library" | "visual",
  requestId: string,
  videoId = VIDEO_A.id,
): PreparedClipProposalHandoff {
  return {
    adapter,
    requestId,
    videoId,
    proposalId: `${adapter}-result-${requestId}`,
    input: {
      title: `${adapter} proposal ${requestId}`,
      startSeconds: adapter === "library" ? 4 : 12,
      endSeconds: adapter === "library" ? 9 : 17,
      quality: "1080p",
    },
    evidence:
      adapter === "library"
        ? {
            sourceBlockIds: ["block-1"],
            workspaceRevision: "workspace-1",
          }
        : {
            sourceFrameIds: ["frame-1"],
            sourceRevision: "source-1",
          },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createReview() {
  const create = vi.fn<ClipProposalPersistence["create"]>(
    async (proposal, input) => ({
      id: `clip-${proposal.id}`,
      title: input.title,
      startSeconds: input.startSeconds,
      endSeconds: input.endSeconds,
      quality: input.quality ?? "1080p",
      status: "queued",
    }),
  );
  return new ClipProposalReview({ create });
}

function defaultLoader(): ClipProposalReviewIntakeLoader {
  return {
    loadLibrary: vi.fn(async (proposalId) =>
      preparedHandoff("library", proposalId),
    ),
    loadVisual: vi.fn(async (proposalId) =>
      preparedHandoff("visual", proposalId),
    ),
  };
}

function renderIntake({
  loader = defaultLoader(),
  review = createReview(),
  activeVideo,
  initialEntry = "/",
  syncActiveVideoWithRoute = false,
}: {
  loader?: ClipProposalReviewIntakeLoader;
  review?: ClipProposalReview;
  activeVideo: ClipProposalVideoContext | null;
  initialEntry?: string;
  syncActiveVideoWithRoute?: boolean;
}) {
  const useIntake = createUseClipProposalReviewIntake(loader);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let observedIntake: ClipProposalReviewIntake | null = null;
  let observedSearch = "";
  let observedNavigationType = "";
  let navigate: ReturnType<typeof useNavigate> | null = null;

  function Harness({
    selectedVideo,
  }: {
    selectedVideo: ClipProposalVideoContext | null;
  }) {
    const location = useLocation();
    const routeVideoId = new URLSearchParams(location.search).get("video");
    const resolvedVideo = syncActiveVideoWithRoute
      ? routeVideoId
        ? { id: routeVideoId, durationSeconds: 90 }
        : null
      : selectedVideo;
    observedIntake = useIntake({ activeVideo: resolvedVideo, review });
    observedSearch = location.search;
    observedNavigationType = useNavigationType();
    navigate = useNavigate();
    return null;
  }

  function App({
    selectedVideo,
  }: {
    selectedVideo: ClipProposalVideoContext | null;
  }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Harness selectedVideo={selectedVideo} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  const rendered = render(<App selectedVideo={activeVideo} />);

  return {
    review,
    get intake() {
      if (!observedIntake) throw new Error("The intake hook has not rendered.");
      return observedIntake;
    },
    get search() {
      return observedSearch;
    },
    get navigationType() {
      return observedNavigationType;
    },
    navigateTo(path: string, options?: { replace?: boolean }) {
      if (!navigate) throw new Error("The router has not rendered.");
      act(() => navigate?.(path, options));
    },
    rerenderActive(selectedVideo: ClipProposalVideoContext | null) {
      rendered.rerender(<App selectedVideo={selectedVideo} />);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Clip Proposal Review intake", () => {
  it("presents a Visual proposal with push, then admits and consumes it with replace", async () => {
    const visual = deferred<PreparedClipProposalHandoff>();
    const loadVisual = vi.fn(() => visual.promise);
    const harness = renderIntake({
      loader: { ...defaultLoader(), loadVisual },
      activeVideo: VIDEO_A,
      initialEntry: "/?video=video-a&keep=clips",
    });

    act(() => harness.intake.presentVisual("visual-1"));
    act(() => harness.intake.presentVisual("visual-1"));

    await waitFor(() => {
      expect(new URLSearchParams(harness.search).get("visualProposal")).toBe(
        "visual-1",
      );
      expect(harness.navigationType).toBe("PUSH");
    });
    expect(loadVisual).toHaveBeenCalledTimes(1);

    await act(async () => {
      visual.resolve(preparedHandoff("visual", "visual-1"));
      await visual.promise;
    });

    await waitFor(() => {
      const params = new URLSearchParams(harness.search);
      expect(params.has("visualProposal")).toBe(false);
      expect(params.get("video")).toBe("video-a");
      expect(params.get("keep")).toBe("clips");
      expect(harness.navigationType).toBe("REPLACE");
    });
    expect(harness.review.getSnapshot()).toMatchObject({
      videoId: VIDEO_A.id,
      isOpen: true,
      items: [{ provenance: { adapter: "visual" } }],
    });
  });

  it("retains a mismatched proposal route and exposes a structured issue", async () => {
    const loadVisual = vi.fn(async (proposalId: string) =>
      preparedHandoff("visual", proposalId, "video-b"),
    );
    const harness = renderIntake({
      loader: { ...defaultLoader(), loadVisual },
      activeVideo: VIDEO_A,
      initialEntry: "/?visualProposal=wrong-video&keep=1",
    });

    await waitFor(() => {
      expect(harness.intake.view.issues).toMatchObject([
        {
          adapter: "visual",
          proposalId: "wrong-video",
          phase: "admission",
          code: "VIDEO_MISMATCH",
          retryable: false,
        },
      ]);
    });
    expect(new URLSearchParams(harness.search).get("visualProposal")).toBe(
      "wrong-video",
    );
    expect(new URLSearchParams(harness.search).get("keep")).toBe("1");
    expect(loadVisual).toHaveBeenCalledTimes(1);
    expect(harness.review.getSnapshot().items).toEqual([]);
  });

  it("admits Library before Visual even when Visual loads first", async () => {
    const library = deferred<PreparedClipProposalHandoff>();
    const visual = deferred<PreparedClipProposalHandoff>();
    const loader: ClipProposalReviewIntakeLoader = {
      loadLibrary: vi.fn(() => library.promise),
      loadVisual: vi.fn(() => visual.promise),
    };
    const review = createReview();
    const intakePrepared = vi.spyOn(review, "intakePrepared");
    const harness = renderIntake({
      loader,
      review,
      activeVideo: VIDEO_A,
      initialEntry: "/?libraryProposal=library-1&visualProposal=visual-1",
    });

    await act(async () => {
      visual.resolve(preparedHandoff("visual", "visual-1"));
      await visual.promise;
    });
    expect(intakePrepared).not.toHaveBeenCalled();

    await act(async () => {
      library.resolve(preparedHandoff("library", "library-1"));
      await library.promise;
    });

    await waitFor(() => expect(intakePrepared).toHaveBeenCalledTimes(2));
    expect(intakePrepared.mock.calls.map(([, handoff]) => handoff.adapter)).toEqual(
      ["library", "visual"],
    );
    await waitFor(() => {
      const params = new URLSearchParams(harness.search);
      expect(params.has("libraryProposal")).toBe(false);
      expect(params.has("visualProposal")).toBe(false);
    });
    expect(review.getSnapshot().items[0]?.provenance.adapter).toBe("library");
  });

  it("keeps a failed Library route while admitting and consuming Visual", async () => {
    const loadLibrary = vi.fn(async () => {
      throw new Error("Library is temporarily unavailable.");
    });
    const harness = renderIntake({
      loader: { ...defaultLoader(), loadLibrary },
      activeVideo: VIDEO_A,
      initialEntry:
        "/?libraryProposal=library-down&visualProposal=visual-ok&keep=1",
    });

    await waitFor(() => {
      expect(harness.review.getSnapshot().items[0]?.provenance.adapter).toBe(
        "visual",
      );
      expect(harness.intake.view.issues).toMatchObject([
        {
          adapter: "library",
          proposalId: "library-down",
          phase: "load",
          code: "LOAD_FAILED",
          message: "Library is temporarily unavailable.",
          retryable: true,
        },
      ]);
    });
    const params = new URLSearchParams(harness.search);
    expect(params.get("libraryProposal")).toBe("library-down");
    expect(params.has("visualProposal")).toBe(false);
    expect(params.get("keep")).toBe("1");
  });

  it("orders Library load issues before Visual admission issues", async () => {
    const loadLibrary = vi.fn(async () => {
      throw new Error("Library failed.");
    });
    const loadVisual = vi.fn(async (proposalId: string) =>
      preparedHandoff("visual", proposalId, "video-b"),
    );
    const review = createReview();
    const intakePrepared = vi.spyOn(review, "intakePrepared");
    const harness = renderIntake({
      loader: { loadLibrary, loadVisual },
      review,
      activeVideo: VIDEO_A,
      initialEntry: "/?libraryProposal=library-bad&visualProposal=visual-bad",
    });

    await waitFor(() => {
      expect(
        harness.intake.view.issues.map(({ adapter, phase, code }) => ({
          adapter,
          phase,
          code,
        })),
      ).toEqual([
        { adapter: "library", phase: "load", code: "LOAD_FAILED" },
        {
          adapter: "visual",
          phase: "admission",
          code: "VIDEO_MISMATCH",
        },
      ]);
    });
    expect(intakePrepared).toHaveBeenCalledTimes(1);
    expect(intakePrepared.mock.calls[0]?.[1].adapter).toBe("visual");
  });

  it("abandons unread handoffs after A to null and ignores late results", async () => {
    const library = deferred<PreparedClipProposalHandoff>();
    const visual = deferred<PreparedClipProposalHandoff>();
    const harness = renderIntake({
      loader: {
        loadLibrary: vi.fn(() => library.promise),
        loadVisual: vi.fn(() => visual.promise),
      },
      activeVideo: VIDEO_A,
      initialEntry:
        "/?video=video-a&libraryProposal=library-late&visualProposal=visual-late&keep=1",
    });

    harness.navigateTo(
      "/?libraryProposal=library-late&visualProposal=visual-late&keep=1",
      { replace: true },
    );
    await waitFor(() =>
      expect(new URLSearchParams(harness.search).has("video")).toBe(false),
    );
    harness.rerenderActive(null);

    await waitFor(() => {
      const params = new URLSearchParams(harness.search);
      expect(params.has("libraryProposal")).toBe(false);
      expect(params.has("visualProposal")).toBe(false);
      expect(params.get("keep")).toBe("1");
      expect(harness.navigationType).toBe("REPLACE");
    });

    await act(async () => {
      library.resolve(preparedHandoff("library", "library-late"));
      visual.resolve(preparedHandoff("visual", "visual-late"));
      await Promise.all([library.promise, visual.promise]);
    });
    expect(harness.review.getSnapshot().items).toEqual([]);
  });

  it("preserves a handoff across the initial null to A transition and then processes it", async () => {
    const visual = deferred<PreparedClipProposalHandoff>();
    const harness = renderIntake({
      loader: {
        ...defaultLoader(),
        loadVisual: vi.fn(() => visual.promise),
      },
      activeVideo: null,
      initialEntry: "/?video=video-a&visualProposal=visual-1&keep=1",
    });

    await act(async () => {
      visual.resolve(preparedHandoff("visual", "visual-1"));
      await visual.promise;
    });
    expect(new URLSearchParams(harness.search).get("visualProposal")).toBe(
      "visual-1",
    );
    expect(harness.review.getSnapshot().items).toEqual([]);

    harness.rerenderActive(VIDEO_A);

    await waitFor(() => {
      expect(
        new URLSearchParams(harness.search).has("visualProposal"),
      ).toBe(false);
      expect(harness.review.getSnapshot().items[0]?.provenance.adapter).toBe(
        "visual",
      );
    });
    expect(new URLSearchParams(harness.search).get("keep")).toBe("1");
  });

  it("admits only the latest proposal ID when an older load completes late", async () => {
    const first = deferred<PreparedClipProposalHandoff>();
    const second = deferred<PreparedClipProposalHandoff>();
    const loadVisual = vi.fn((proposalId: string) =>
      proposalId === "visual-first" ? first.promise : second.promise,
    );
    const review = createReview();
    const intakePrepared = vi.spyOn(review, "intakePrepared");
    const harness = renderIntake({
      loader: { ...defaultLoader(), loadVisual },
      review,
      activeVideo: VIDEO_A,
      initialEntry: "/?video=video-a&visualProposal=visual-first",
    });

    await waitFor(() => expect(loadVisual).toHaveBeenCalledWith("visual-first", expect.any(AbortSignal)));
    harness.navigateTo("/?video=video-a&visualProposal=visual-second");
    await waitFor(() => expect(loadVisual).toHaveBeenCalledWith("visual-second", expect.any(AbortSignal)));

    await act(async () => {
      second.resolve(preparedHandoff("visual", "visual-second"));
      await second.promise;
    });
    await waitFor(() => expect(intakePrepared).toHaveBeenCalledTimes(1));
    expect(intakePrepared.mock.calls[0]?.[1].requestId).toBe("visual-second");

    await act(async () => {
      first.resolve(preparedHandoff("visual", "visual-first"));
      await first.promise;
    });
    expect(intakePrepared).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot().items).toHaveLength(1);
  });

  it("preserves and admits a new Video's handoff during a direct cached A to B transition", async () => {
    const first = deferred<PreparedClipProposalHandoff>();
    const loadVisual = vi.fn((proposalId: string) =>
      proposalId === "visual-a"
        ? first.promise
        : Promise.resolve(preparedHandoff("visual", proposalId, "video-b")),
    );
    const harness = renderIntake({
      loader: { ...defaultLoader(), loadVisual },
      activeVideo: VIDEO_A,
      initialEntry: "/?video=video-a&visualProposal=visual-a&keep=1",
      syncActiveVideoWithRoute: true,
    });

    harness.navigateTo("/?video=video-b&visualProposal=visual-b&keep=1");
    await waitFor(() => {
      expect(
        new URLSearchParams(harness.search).has("visualProposal"),
      ).toBe(false);
      expect(harness.review.getSnapshot()).toMatchObject({
        videoId: "video-b",
        items: [{ provenance: { adapter: "visual" } }],
      });
    });

    await act(async () => {
      first.resolve(preparedHandoff("visual", "visual-a"));
      await first.promise;
    });
    expect(harness.review.getSnapshot().items).toHaveLength(1);
  });

  it("abandons the prior unread ID during a direct A to B transition", async () => {
    const pending = deferred<PreparedClipProposalHandoff>();
    const review = createReview();
    const intakePrepared = vi.spyOn(review, "intakePrepared");
    const harness = renderIntake({
      loader: {
        ...defaultLoader(),
        loadVisual: vi.fn(() => pending.promise),
      },
      review,
      activeVideo: VIDEO_A,
      initialEntry: "/?video=video-a&visualProposal=visual-a&keep=1",
      syncActiveVideoWithRoute: true,
    });

    harness.navigateTo("/?video=video-b&visualProposal=visual-a&keep=1");

    await waitFor(() => {
      const params = new URLSearchParams(harness.search);
      expect(params.get("video")).toBe("video-b");
      expect(params.has("visualProposal")).toBe(false);
      expect(params.get("keep")).toBe("1");
      expect(harness.navigationType).toBe("REPLACE");
    });

    await act(async () => {
      pending.resolve(preparedHandoff("visual", "visual-a"));
      await pending.promise;
    });
    expect(intakePrepared).not.toHaveBeenCalled();
  });

  it("does not close or settle an open review when unread route handoffs are abandoned", async () => {
    const review = createReview();
    const settle = vi.fn();
    review.activate(VIDEO_A);
    review.admit({
      adapter: "library",
      requestId: "already-open",
      videoId: VIDEO_A.id,
      proposals: [
        {
          proposalId: "library-result-already-open",
          input: preparedHandoff("library", "already-open").input,
          settle,
        },
      ],
    });
    const unread = deferred<PreparedClipProposalHandoff>();
    const harness = renderIntake({
      loader: {
        ...defaultLoader(),
        loadVisual: vi.fn(() => unread.promise),
      },
      review,
      activeVideo: VIDEO_A,
      initialEntry: "/?video=video-a&visualProposal=unread&keep=1",
    });

    harness.navigateTo("/?visualProposal=unread&keep=1", { replace: true });
    await waitFor(() =>
      expect(new URLSearchParams(harness.search).has("video")).toBe(false),
    );
    harness.rerenderActive(null);
    await waitFor(() =>
      expect(new URLSearchParams(harness.search).has("visualProposal")).toBe(
        false,
      ),
    );

    await act(async () => {
      unread.resolve(preparedHandoff("visual", "unread"));
      await unread.promise;
    });

    expect(review.getSnapshot()).toMatchObject({
      videoId: VIDEO_A.id,
      isOpen: true,
      submitting: false,
      items: [
        {
          decision: null,
          provenance: { adapter: "library" },
        },
      ],
    });
    expect(settle).not.toHaveBeenCalled();
  });
});
