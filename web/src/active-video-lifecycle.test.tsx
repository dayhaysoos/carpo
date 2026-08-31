import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import {
  type ActiveVideoGateway,
  type ActiveVideoLifecycle,
  useActiveVideoLifecycle,
} from "./active-video-lifecycle";
import { sourceVideoQueryKey } from "./queries";
import type {
  ClipResponse,
  ClipSource,
  SourceVideoDetailResponse,
  SourceVideoResponse,
} from "./types";

function video(
  id: string,
  source: ClipSource = { type: "upload", key: `uploads/${id}.mp4` },
): SourceVideoResponse {
  return {
    id,
    title: `Video ${id}`,
    source,
    clipCount: 0,
    activeClipCount: 0,
    failedClipCount: 0,
    thumbnail: null,
    durationSeconds: 90,
    retainedSourceReady: source.type === "upload",
    transcriptStatus: "available",
    transcriptCheckedAt: "2026-08-30T01:00:00.000Z",
    transcriptCheckError: null,
    transcriptRetryAt: null,
    archivedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T01:00:00.000Z",
  };
}

function failedIngestionVideo(id: string): SourceVideoResponse {
  return {
    ...video(id, {
      type: "youtube",
      url: "https://www.youtube.com/watch?v=failedVideo",
    }),
    retainedSourceReady: false,
    remoteIngestion: {
      provider: "youtube",
      status: "failed",
      failure: {
        provider: "youtube",
        code: "rate_limited",
        message: "Import failed",
        retryable: true,
        recovery: {
          type: "upload",
          href: "/?source=upload",
          label: "Upload instead",
        },
      },
    },
  };
}

function clip(
  id: string,
  status: ClipResponse["status"],
): ClipResponse {
  return {
    id,
    videoId: "active-video",
    title: `Clip ${id}`,
    source: { type: "upload", key: "uploads/active-video.mp4" },
    trimStart: 0,
    trimEnd: 5,
    quality: "1080p",
    caption: null,
    filters: [],
    status,
    errorMessage: null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: { mp4: null, thumbnail: null, gif: null },
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
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

function createGateway(
  overrides: Partial<ActiveVideoGateway> = {},
): ActiveVideoGateway {
  return {
    load: vi.fn(async (videoId: string) => ({
      video: video(videoId),
      clips: [],
    })),
    create: vi.fn(async (request) => video("created-video", request.source)),
    requestUpload: vi.fn(async ({ filename }) => ({
      key: `uploads/${filename}`,
      uploadUrl: `/uploads/${filename}`,
      maxSizeBytes: 100_000,
      contentType: "video/mp4",
      method: "PUT" as const,
    })),
    upload: vi.fn(async (_url, file, _contentType, onProgress) => {
      onProgress(file.size, file.size);
    }),
    retryIngestion: vi.fn(async (videoId: string) => video(videoId)),
    updateDuration: vi.fn(async (videoId: string, durationSeconds: number) => ({
      ...video(videoId),
      durationSeconds,
    })),
    ...overrides,
  };
}

let lifecycle: ActiveVideoLifecycle;
let locationSearch = "";
let navigate: ReturnType<typeof useNavigate>;

function Harness({
  gateway,
  settleMs,
}: {
  gateway: ActiveVideoGateway;
  settleMs: number;
}) {
  lifecycle = useActiveVideoLifecycle({ gateway, settleMs });
  const location = useLocation();
  navigate = useNavigate();
  locationSearch = location.search;
  return null;
}

function renderLifecycle(
  gateway: ActiveVideoGateway,
  initialEntry = "/",
  settleMs = 1,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Harness gateway={gateway} settleMs={settleMs} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

describe("Active Video lifecycle", () => {
  beforeEach(() => {
    locationSearch = "";
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:active-video-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the route-authoritative Video and narrowly clears Video state", async () => {
    const gateway = createGateway();
    renderLifecycle(
      gateway,
      "/?video=deep-link&source=upload&libraryProposal=library&visualProposal=visual&keep=yes",
    );

    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));
    expect(gateway.load).toHaveBeenCalledWith("deep-link");

    await act(async () => {
      await lifecycle.perform({ type: "clear" });
    });

    expect(lifecycle.view.active.status).toBe("none");
    expect(locationSearch).toBe(
      "?libraryProposal=library&visualProposal=visual&keep=yes",
    );
  });

  it("never publishes a load result for a different Video ID", async () => {
    const gateway = createGateway({
      load: vi.fn(async () => ({ video: video("wrong-video"), clips: [] })),
    });
    renderLifecycle(gateway, "/?video=requested-video");

    await waitFor(() => expect(lifecycle.view.active.status).toBe("failed"));
    expect(lifecycle.view.active).toMatchObject({
      status: "failed",
      id: "requested-video",
      issue: { area: "load", code: "video_mismatch" },
    });
    expect(locationSearch).toBe("?video=requested-video");
  });

  it("returns a typed load failure for the authoritative route", async () => {
    const gateway = createGateway({
      load: vi.fn(async () => {
        throw new Error("Video unavailable");
      }),
    });
    renderLifecycle(gateway, "/?video=missing-video");

    await waitFor(() => expect(lifecycle.view.active.status).toBe("failed"));
    expect(lifecycle.view.active).toMatchObject({
      status: "failed",
      id: "missing-video",
      issue: { area: "load", message: "Video unavailable" },
    });
  });

  it("exposes a valid pending YouTube identity before activating once", async () => {
    const gateway = createGateway({
      create: vi.fn(async (request) =>
        video("youtube-active", request.source),
      ),
    });
    renderLifecycle(gateway, "/?source=upload&keep=yes", 20);

    await act(async () => {
      await lifecycle.perform({
        type: "source-mode-changed",
        mode: "youtube",
      });
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://www.youtube.com/watch?v=pendingThink1",
      });
    });

    expect(lifecycle.view.pendingYoutubeVideoId).toBe("pendingThink1");
    expect(gateway.create).not.toHaveBeenCalled();

    await waitFor(() => expect(gateway.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(locationSearch).toContain("video=youtube-active"));
    const activatedSearch = new URLSearchParams(locationSearch);
    expect(activatedSearch.get("video")).toBe("youtube-active");
    expect(activatedSearch.get("keep")).toBe("yes");
    expect(activatedSearch.has("source")).toBe(false);
    expect(gateway.create).toHaveBeenCalledWith({
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=pendingThink1",
      },
      title: "YouTube video pendingThink1",
    });
  });

  it("does not schedule activation for an invalid YouTube URL", async () => {
    const gateway = createGateway();
    renderLifecycle(gateway, "/", 5);

    await act(async () => {
      await lifecycle.perform({ type: "source-mode-changed", mode: "youtube" });
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://example.com/not-youtube",
      });
    });

    expect(lifecycle.view.manualSource.youtubeValidity).toBe("invalid");
    expect(lifecycle.view.pendingYoutubeVideoId).toBeNull();
    expect(lifecycle.view.manualSource.phase).toBe("idle");
    await new Promise((resolve) => window.setTimeout(resolve, 15));
    expect(gateway.create).not.toHaveBeenCalled();
  });

  it("prevents a stale YouTube completion from replacing the latest intent", async () => {
    const first = deferred<SourceVideoResponse>();
    const second = deferred<SourceVideoResponse>();
    const gateway = createGateway({
      create: vi.fn((request) =>
        request.source.type === "youtube" &&
        request.source.url.includes("firstVideo1")
          ? first.promise
          : second.promise,
      ),
    });
    renderLifecycle(gateway, "/", 0);

    await act(async () => {
      await lifecycle.perform({ type: "source-mode-changed", mode: "youtube" });
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://www.youtube.com/watch?v=firstVideo1",
      });
    });
    await waitFor(() => expect(gateway.create).toHaveBeenCalledTimes(1));

    await act(async () => {
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://www.youtube.com/watch?v=secondVideo",
      });
    });
    await waitFor(() => expect(gateway.create).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(
        video("second-active", {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=secondVideo",
        }),
      );
      await second.promise;
    });
    await waitFor(() => expect(locationSearch).toContain("video=second-active"));

    await act(async () => {
      first.resolve(
        video("first-stale", {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=firstVideo1",
        }),
      );
      await first.promise;
    });
    expect(locationSearch).toContain("video=second-active");
    expect(locationSearch).not.toContain("first-stale");
  });

  it("lets an external route change supersede a pending activation", async () => {
    const activation = deferred<SourceVideoResponse>();
    const gateway = createGateway({
      create: vi.fn(() => activation.promise),
    });
    renderLifecycle(gateway, "/?keep=yes", 0);

    await act(async () => {
      await lifecycle.perform({ type: "source-mode-changed", mode: "youtube" });
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://www.youtube.com/watch?v=pendingRoute1",
      });
    });
    await waitFor(() => expect(gateway.create).toHaveBeenCalledOnce());

    act(() => navigate("/?video=deep-link&keep=yes"));
    await waitFor(() => expect(gateway.load).toHaveBeenCalledWith("deep-link"));

    await act(async () => {
      activation.resolve(
        video("stale-activation", {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=pendingRoute1",
        }),
      );
      await activation.promise;
    });

    expect(locationSearch).toBe("?video=deep-link&keep=yes");
    expect(lifecycle.view.active.id).toBe("deep-link");
  });

  it("keeps only the latest upload eligible to activate", async () => {
    const firstUpload = deferred<void>();
    const gateway = createGateway({
      upload: vi.fn(async (_url, file, _contentType, onProgress) => {
        onProgress(file.size, file.size);
        if (file.name === "first.mp4") await firstUpload.promise;
      }),
      create: vi.fn(async (request) => {
        const id =
          request.source.type === "upload" && request.source.key.includes("second")
            ? "second-upload"
            : "first-upload";
        return video(id, request.source);
      }),
    });
    renderLifecycle(gateway);

    let firstResult!: Promise<unknown>;
    act(() => {
      firstResult = lifecycle.perform({
        type: "upload-selected",
        file: new File(["first"], "first.mp4", { type: "video/mp4" }),
      });
    });
    await waitFor(() => expect(gateway.upload).toHaveBeenCalledTimes(1));

    await act(async () => {
      await lifecycle.perform({
        type: "upload-selected",
        file: new File(["second"], "second.mp4", { type: "video/mp4" }),
      });
    });
    await waitFor(() => expect(locationSearch).toContain("video=second-upload"));

    await act(async () => {
      firstUpload.resolve();
      await firstResult;
    });
    expect(locationSearch).toContain("video=second-upload");
    expect(gateway.create).not.toHaveBeenCalledWith({
      source: { type: "upload", key: "uploads/first.mp4" },
      title: "first",
    });
  });

  it("rejects an invalid upload without exposing it as a playable preview", async () => {
    const gateway = createGateway();
    renderLifecycle(gateway);

    let result;
    await act(async () => {
      result = await lifecycle.perform({
        type: "upload-selected",
        file: new File(["not video"], "notes.txt", { type: "text/plain" }),
      });
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      issue: { area: "upload", retryable: false },
    });
    expect(lifecycle.view.manualSource.upload?.previewUrl).toBeNull();
    expect(lifecycle.view.preview.type).toBe("none");
    expect(gateway.requestUpload).not.toHaveBeenCalled();
    expect(gateway.upload).not.toHaveBeenCalled();
  });

  it("reports typed activation failures without changing the route", async () => {
    const gateway = createGateway({
      create: vi.fn(async () => {
        throw new Error("Activation unavailable");
      }),
    });
    renderLifecycle(gateway, "/", 0);

    await act(async () => {
      await lifecycle.perform({ type: "source-mode-changed", mode: "youtube" });
      await lifecycle.perform({
        type: "youtube-url-changed",
        value: "https://www.youtube.com/watch?v=brokenVideo1",
      });
    });

    await waitFor(() => expect(lifecycle.view.manualSource.phase).toBe("failed"));
    expect(lifecycle.view.manualSource.issue).toMatchObject({
      area: "activation",
      message: "Activation unavailable",
      retryable: true,
    });
    expect(locationSearch).toBe("");
  });

  it("ignores Clip completions that belong to another Video", async () => {
    const gateway = createGateway();
    renderLifecycle(gateway, "/?video=active-video");
    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));

    await act(async () => {
      await lifecycle.perform({
        type: "clip-created",
        videoId: "other-video",
        clip: { id: "other-clip", status: "queued" },
      });
    });

    expect(lifecycle.view.refresh).toBe("idle");
    expect(gateway.load).toHaveBeenCalledOnce();
  });

  it("keeps cached Active Video data usable after a refresh failure", async () => {
    const gateway = createGateway({
      load: vi
        .fn()
        .mockResolvedValueOnce({ video: video("active-video"), clips: [] })
        .mockRejectedValueOnce(new Error("Refresh unavailable")),
    });
    renderLifecycle(gateway, "/?video=active-video");
    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));

    await act(async () => {
      await lifecycle.perform({
        type: "clip-created",
        videoId: "active-video",
        clip: { id: "complete-clip", status: "complete" },
      });
    });
    await waitFor(() => expect(gateway.load).toHaveBeenCalledTimes(2));

    expect(lifecycle.view.active.status).toBe("ready");
    expect(lifecycle.view.refreshIssue?.message).toBe("Refresh unavailable");
  });

  it("guards an in-flight ingestion retry and exposes its state", async () => {
    const retry = deferred<SourceVideoResponse>();
    const failedVideo = failedIngestionVideo("failed-video");
    const gateway = createGateway({
      load: vi.fn(async () => ({ video: failedVideo, clips: [] })),
      retryIngestion: vi.fn(() => retry.promise),
    });
    const { queryClient } = renderLifecycle(
      gateway,
      "/?video=failed-video",
    );
    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));

    let pending!: Promise<unknown>;
    act(() => {
      pending = lifecycle.perform({ type: "retry-ingestion" });
    });
    await waitFor(() => expect(gateway.retryIngestion).toHaveBeenCalledOnce());
    expect(lifecycle.view.manualSource.phase).toBe("activating");

    let duplicate;
    await act(async () => {
      duplicate = await lifecycle.perform({ type: "retry-ingestion" });
    });
    expect(duplicate).toEqual({ ok: true, outcome: "noop" });
    expect(gateway.retryIngestion).toHaveBeenCalledOnce();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: sourceVideoQueryKey("failed-video"),
      });
    });
    expect(gateway.load).toHaveBeenCalledTimes(2);
    expect(lifecycle.view.manualSource.phase).toBe("activating");

    await act(async () => {
      retry.resolve(failedVideo);
      await pending;
    });
    expect(lifecycle.view.manualSource.phase).toBe("idle");
  });

  it("keeps a same-Video ingestion retry failure visible across refetches", async () => {
    let currentVideo = failedIngestionVideo("failed-video");
    const gateway = createGateway({
      load: vi.fn(async () => ({ video: currentVideo, clips: [] })),
      retryIngestion: vi.fn(async () => {
        throw new Error("Retry unavailable");
      }),
    });
    const { queryClient } = renderLifecycle(
      gateway,
      "/?video=failed-video",
    );
    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));

    let result;
    await act(async () => {
      result = await lifecycle.perform({ type: "retry-ingestion" });
    });
    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      issue: { area: "ingestion-retry", message: "Retry unavailable" },
    });
    expect(lifecycle.view.manualSource.phase).toBe("failed");

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: sourceVideoQueryKey("failed-video"),
      });
    });
    expect(gateway.load).toHaveBeenCalledTimes(2);
    expect(lifecycle.view.manualSource).toMatchObject({
      phase: "failed",
      issue: { area: "ingestion-retry", message: "Retry unavailable" },
    });

    currentVideo = {
      ...currentVideo,
      remoteIngestion: {
        provider: "youtube",
        status: "importing",
        failure: null,
      },
    };
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: sourceVideoQueryKey("failed-video"),
      });
    });
    expect(gateway.load).toHaveBeenCalledTimes(3);
    await waitFor(() =>
      expect(lifecycle.view.manualSource).toMatchObject({
        phase: "idle",
        issue: null,
      }),
    );
  });

  it("supersedes a failed ingestion retry after the active Video changes", async () => {
    const retry = deferred<SourceVideoResponse>();
    const gateway = createGateway({
      load: vi.fn(async (videoId: string) => ({
        video:
          videoId === "failed-video"
            ? failedIngestionVideo(videoId)
            : video(videoId),
        clips: [],
      })),
      retryIngestion: vi.fn(() => retry.promise),
    });
    renderLifecycle(gateway, "/?video=failed-video");
    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));

    let pending!: ReturnType<ActiveVideoLifecycle["perform"]>;
    act(() => {
      pending = lifecycle.perform({ type: "retry-ingestion" });
    });
    await waitFor(() => expect(gateway.retryIngestion).toHaveBeenCalledOnce());

    act(() => navigate("/?video=next-video"));
    await waitFor(() =>
      expect(lifecycle.view.active).toMatchObject({
        status: "ready",
        id: "next-video",
      }),
    );

    let result;
    await act(async () => {
      retry.reject(new Error("Obsolete retry failure"));
      result = await pending;
    });

    expect(result).toEqual({ ok: false, outcome: "superseded" });
    expect(lifecycle.view.manualSource).toMatchObject({
      phase: "idle",
      issue: null,
    });
  });

  it("keeps polling visible for ingestion and newly created Clip work", async () => {
    let detail: SourceVideoDetailResponse = {
      video: {
        ...video("active-video", {
          type: "youtube",
          url: "https://www.youtube.com/watch?v=activeVideo1",
        }),
        retainedSourceReady: false,
        remoteIngestion: {
          provider: "youtube",
          status: "importing",
          failure: null,
        },
      },
      clips: [],
    };
    const gateway = createGateway({
      load: vi.fn(async () => detail),
    });
    renderLifecycle(gateway, "/?video=active-video");

    await waitFor(() => expect(lifecycle.view.active.status).toBe("ready"));
    expect(lifecycle.view.refresh).toBe("polling");

    detail = {
      video: {
        ...detail.video,
        retainedSourceReady: true,
        remoteIngestion: {
          provider: "youtube",
          status: "ready",
          failure: null,
        },
      },
      clips: [],
    };
    await act(async () => {
      await lifecycle.perform({
        type: "clip-created",
        videoId: "active-video",
        clip: { id: "new-clip", status: "queued" },
      });
    });
    await waitFor(() => expect(gateway.load).toHaveBeenCalledTimes(2));
    expect(lifecycle.view.refresh).toBe("polling");

    detail = { ...detail, clips: [clip("new-clip", "complete")] };
    await waitFor(() => expect(gateway.load).toHaveBeenCalledTimes(3), {
      timeout: 2_000,
    });
    await waitFor(() => expect(lifecycle.view.refresh).toBe("idle"));
  });
});
