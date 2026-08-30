import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoAgentChat } from "./VideoAgentChat";

const chat = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
  addToolOutput: vi.fn(),
  messages: [] as Array<Record<string, unknown>>,
}));
const api = vi.hoisted(() => ({
  createClipFromSourceVideo: vi.fn(),
}));
const player = vi.hoisted(() => ({
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
}));
const agentConnections = vi.hoisted(() => ({
  nextId: 1,
  namesByConnection: new Map<number, Set<string>>(),
  closed: [] as number[],
}));

vi.mock("agents/react", () => ({
  useAgent: (options: { name: string; onOpen?: () => void }) => {
    const connectionId = useRef<number | null>(null);
    if (connectionId.current === null) {
      connectionId.current = agentConnections.nextId++;
      agentConnections.namesByConnection.set(connectionId.current, new Set());
    }
    agentConnections.namesByConnection
      .get(connectionId.current)
      ?.add(options.name);

    useEffect(() => options.onOpen?.(), [options.onOpen]);
    useEffect(
      () => () => {
        if (connectionId.current !== null) {
          agentConnections.closed.push(connectionId.current);
        }
      },
      [],
    );
    return { connectionId: connectionId.current };
  },
}));

vi.mock("@cloudflare/think/react", () => ({
  useAgentChat: () => ({
    messages: chat.messages,
    sendMessage: vi.fn(),
    addToolApprovalResponse: chat.addToolApprovalResponse,
    addToolOutput: chat.addToolOutput,
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    createClipFromSourceVideo: api.createClipFromSourceVideo,
  };
});

vi.mock("../hooks/useYoutubePlayer", () => ({
  useYoutubePlayer: () => ({
    containerId: "youtube-review-player",
    ready: true,
    currentTime: 0,
    duration: 1451,
    seekTo: player.seekTo,
    pauseVideo: player.pauseVideo,
  }),
}));

function proposal(
  approvalId: string,
  title: string,
  startSeconds: number,
  endSeconds: number,
) {
  return {
    type: "tool-createClip",
    toolCallId: `tool-${approvalId}`,
    state: "approval-requested",
    input: {
      title,
      startSeconds,
      endSeconds,
      quality: "1080p",
    },
    approval: { id: approvalId },
  };
}

function clientProposal(
  toolCallId: string,
  title: string,
  startSeconds: number,
  endSeconds: number,
) {
  return {
    type: "tool-createClip",
    toolCallId,
    state: "input-available",
    input: {
      title,
      startSeconds,
      endSeconds,
      quality: "1080p",
    },
  };
}

describe("VideoAgentChat", () => {
  beforeEach(() => {
    api.createClipFromSourceVideo.mockResolvedValue({
      id: "created-clip",
      title: "Manual range",
      trimStart: 60,
      trimEnd: 64,
      quality: "1080p",
      status: "queued",
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [proposal("approval-1", "Manual range", 60, 64)],
      },
    ];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    agentConnections.nextId = 1;
    agentConnections.namesByConnection.clear();
    agentConnections.closed = [];
  });

  it("stays visible while waiting for a source video", () => {
    chat.messages = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <VideoAgentChat
        videoId=""
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Clip with Think" })).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(
      screen.getByText("Choose a YouTube video or upload a file to start clipping."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: "Clip instruction" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("preserves a YouTube draft while the source becomes ready", async () => {
    const user = userEvent.setup();
    chat.messages = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const { rerender } = render(
      <VideoAgentChat
        videoId=""
        pendingYoutubeVideoId="draftVideo1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    const pendingComposer = screen.getByRole("textbox", {
      name: "Clip instruction",
    }) as HTMLTextAreaElement;
    expect(pendingComposer.disabled).toBe(false);
    await user.type(pendingComposer, "Find the strongest opening line");
    expect(
      screen.getByRole("button", { name: "Preparing video…" }),
    ).toHaveProperty("disabled", true);

    rerender(
      <VideoAgentChat
        videoId="video-1"
        pendingYoutubeVideoId={null}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=draftVideo1",
        }}
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Clip instruction" }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      (screen.getByRole("textbox", {
        name: "Clip instruction",
      }) as HTMLTextAreaElement).value,
    ).toBe("Find the strongest opening line");
  });

  it("offers transcript clipping for YouTube and uploaded sources", () => {
    chat.messages = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { rerender } = render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    expect(
      screen.getByText(
        "Describe clips by timestamp, spoken phrase, or idea. You approve them before creation.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("“Clip every time ‘code’ is said.”")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Clip by time, phrase, or idea…"),
    ).toBeTruthy();

    rerender(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{ type: "upload", key: "uploads/source.mp4" }}
      />,
    );

    expect(
      screen.getByText(
        "Describe clips by timestamp, spoken phrase, or idea. You approve them before creation.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("“Clip every time ‘code’ is said.”")).toBeTruthy();
    expect(
      screen.getByText("“Find the strongest explanation of the main idea.”"),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Clip by time, phrase, or idea…"),
    ).toBeTruthy();
  });

  it("groups proposed clips into one chronological review flow", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          proposal("approval-late", "Late clip", 60, 64),
          proposal("approval-first", "Opening clip", 3, 6),
          proposal("approval-middle", "Middle clip", 30, 33),
        ],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        existingClips={[
          {
            id: "existing-opening",
            title: "Existing opening",
            startSeconds: 4,
            endSeconds: 5,
          },
        ]}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Review clips" })).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByText("From Stop Reading Every Line of Code")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Opening clip" })).toBeNull();
    expect(screen.queryByText("0:03.000–0:06.000")).toBeNull();
    expect(screen.getByText("3 seconds")).toBeTruthy();
    expect(screen.getByText("1080p")).toBeTruthy();
    expect(screen.getByText("Overlaps 1 existing clip")).toBeTruthy();
    expect(screen.getByLabelText("Preview Opening clip")).toBeTruthy();
    await waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(3));
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Next clip" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Preview Middle clip")).toBeTruthy();
    expect(document.querySelector(".clip-review-step-forward")).toBeNull();
    expect(document.querySelector(".clip-review-details-advance")).toBeTruthy();
    expect(document.querySelector(".clip-review-progress-advance")).toBeTruthy();
    await waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(30));
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close clip review" }));
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
    expect(screen.getByText("3 clips ready to review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review clips" })).toBeTruthy();
  });

  it("keeps an unfinished review scoped to its originating video", async () => {
    const originalMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [proposal("approval-video-1", "Video one clip", 3, 6)],
      },
    ];
    chat.messages = originalMessages;
    const view = render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Review clips" })).toBeTruthy();

    chat.messages = [];
    view.rerender(
      <VideoAgentChat
        videoId="video-2"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Review clips" }),
      ).toBeNull(),
    );
    expect(screen.queryByText("1 clip ready to review")).toBeNull();

    chat.messages = originalMessages;
    view.rerender(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Review clips" })).toBeTruthy(),
    );
  });

  it("opens a fresh agent connection when the video identity changes", () => {
    chat.messages = [];
    const view = render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    view.rerender(
      <VideoAgentChat
        videoId="video-2"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    expect(
      [...agentConnections.namesByConnection.values()].map((names) => [
        ...names,
      ]),
    ).toEqual([["video-1"], ["video-2"]]);
    expect(agentConnections.closed).toContain(1);
  });

  it("does not carry a Think draft into a different active video", async () => {
    const user = userEvent.setup();
    chat.messages = [];
    const view = render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );
    const composer = screen.getByRole("textbox", {
      name: "Clip instruction",
    });
    await user.type(composer, "Only for video one");

    view.rerender(
      <VideoAgentChat
        videoId="video-2"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Clip instruction" }),
      ).toHaveProperty("value", ""),
    );
  });

  it("keeps an uploaded preview mounted while advancing clips", async () => {
    const user = userEvent.setup();
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          proposal("approval-first", "First clip", 0, 3),
          proposal("approval-second", "Second clip", 10, 13),
        ],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "upload",
          key: "uploads/source.mp4",
        }}
      />,
    );

    const firstPreview = screen.getByTitle(
      "Preview First clip",
    ) as HTMLVideoElement;
    expect(firstPreview.getAttribute("src")).toBe(
      "/api/videos/video-1/source",
    );

    await user.click(screen.getByRole("button", { name: "Next clip" }));

    const secondPreview = screen.getByTitle(
      "Preview Second clip",
    ) as HTMLVideoElement;
    expect(secondPreview).toBe(firstPreview);
    expect(secondPreview.getAttribute("src")).toBe(
      "/api/videos/video-1/source",
    );
  });

  it("previews retained YouTube sources at the proposed timestamp", () => {
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [proposal("approval-retained", "Retained clip", 325, 335)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        retainedSourceReady
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    const preview = screen.getByTitle(
      "Preview Retained clip",
    ) as HTMLVideoElement;
    expect(preview.tagName).toBe("VIDEO");
    expect(preview.getAttribute("src")).toBe("/api/videos/video-1/source");
    expect(preview.currentTime).toBe(325);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("keeps clip decisions reversible until the completed review is submitted", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          proposal("approval-second", "Second clip", 10, 13),
          proposal("approval-first", "First clip", 0, 3),
        ],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve and next" }));
    expect(screen.getByLabelText("Preview Second clip")).toBeTruthy();
    expect(document.querySelector(".clip-review-step-forward")).toBeNull();
    expect(document.querySelector(".clip-review-details-advance")).toBeTruthy();
    expect(document.querySelector(".clip-review-progress-advance")).toBeTruthy();
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reject clip" }));
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    );
    await waitFor(() =>
      expect(api.createClipFromSourceVideo).toHaveBeenCalledWith(
        "video-1",
        {
          title: "First clip",
          trimStart: 0,
          trimEnd: 3,
          quality: "1080p",
          filters: [],
        },
        "think:video-1:assistant-1:approval-first",
      ),
    );
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval-second",
      approved: false,
    });
    expect(chat.addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool-approval-first" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
  });

  it("approves an entire proposal batch without reviewing every clip", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          proposal("approval-second", "Second clip", 10, 13),
          proposal("approval-first", "First clip", 0, 3),
        ],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve all" }));
    expect(api.createClipFromSourceVideo).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Create 2 approved clips" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Create 2 approved clips" }),
    );

    await waitFor(() =>
      expect(api.createClipFromSourceVideo).toHaveBeenCalledTimes(2),
    );
    expect(chat.addToolOutput.mock.calls.map(([result]) => result.toolCallId))
      .toEqual(["tool-approval-first", "tool-approval-second"]);
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
  });

  it("rejects an entire proposal batch without creating anything", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          proposal("approval-second", "Second clip", 10, 13),
          proposal("approval-first", "First clip", 0, 3),
        ],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject all" }));

    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Finish review" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Finish review" }));

    await waitFor(() =>
      expect(chat.addToolApprovalResponse.mock.calls).toEqual([
        [{ id: "approval-first", approved: false }],
        [{ id: "approval-second", approved: false }],
      ]),
    );
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
  });

  it("reports a failed proposal and retries only that clip", async () => {
    const user = userEvent.setup();
    api.createClipFromSourceVideo.mockRejectedValueOnce(
      new Error("temporary clip failure"),
    );
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [clientProposal("tool-retry", "Retry clip", 20, 24)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve clip" }));
    await user.click(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes("Retry clip: temporary clip failure"),
          ),
      ).toBe(true),
    );
    expect(api.createClipFromSourceVideo).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Review clips" }),
      ).toBeNull(),
    );
    expect(api.createClipFromSourceVideo).toHaveBeenCalledTimes(2);
  });

  it("seeks YouTube previews to fractional proposal timestamps", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [proposal("approval-precise", "Precise clip", 10.75, 13.1)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    await waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.75));
    expect(screen.getByText("2.35 seconds")).toBeTruthy();
  });

  it("previews uploaded sources at the proposed range", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [proposal("approval-upload", "Uploaded clip", 12.25, 15.5)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{ type: "upload", key: "uploads/source.mp4" }}
      />,
    );

    const preview = screen.getByTitle(
      "Preview Uploaded clip",
    ) as HTMLVideoElement;
    expect(preview.getAttribute("src")).toBe("/api/videos/video-1/source");
    expect(preview.currentTime).toBe(12.25);
  });

  it("automatically applies typed timestamps and keeps them clickable", async () => {
    const user = userEvent.setup();
    const onTimestampSelect = vi.fn();
    chat.messages = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={onTimestampSelect}
      />,
    );

    const instruction = await screen.findByRole("textbox", {
      name: "Clip instruction",
    });
    await user.type(instruction, "Start at 10:23");

    expect(onTimestampSelect).toHaveBeenLastCalledWith({
      label: "10:23 → 10:33",
      startSeconds: 623,
      endSeconds: 633,
    });

    const timestamp = screen.getByRole("button", {
      name: "Set editor to 10:23 through 10:33",
    });

    expect(timestamp.closest(".agent-composer-input")).toBeTruthy();
    expect(screen.queryByText("Clip length")).toBeNull();
    expect(screen.queryByText("Move editor")).toBeNull();
    onTimestampSelect.mockClear();
    await user.click(timestamp);

    expect(onTimestampSelect).toHaveBeenCalledWith({
      label: "10:23 → 10:33",
      startSeconds: 623,
      endSeconds: 633,
    });
  });

  it("creates a client-side proposal with the timestamps edited in review", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [clientProposal("tool-editable", "Editable clip", 10, 13)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "Trim start" }), {
      target: { value: "11.5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Trim end" }), {
      target: { value: "15" },
    });
    await user.click(screen.getByRole("button", { name: "Approve clip" }));
    await user.click(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    );

    await waitFor(() =>
      expect(api.createClipFromSourceVideo).toHaveBeenCalledWith(
        "video-1",
        {
          title: "Editable clip",
          trimStart: 11.5,
          trimEnd: 15,
          quality: "1080p",
          filters: [],
        },
        "think:video-1:assistant-1:tool-editable",
      ),
    );
    expect(chat.addToolOutput).toHaveBeenCalledWith({
      toolCallId: "tool-editable",
      output: {
        clipId: "created-clip",
        title: "Manual range",
        startSeconds: 60,
        endSeconds: 64,
        quality: "1080p",
        status: "queued",
      },
    });
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("resolves a rejected client proposal without treating it as a failure", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [clientProposal("tool-rejected", "Skip this clip", 20, 23)],
      },
    ];

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject clip" }));
    await user.click(screen.getByRole("button", { name: "Finish review" }));

    expect(chat.addToolOutput).toHaveBeenCalledWith({
      toolCallId: "tool-rejected",
      output: {
        status: "rejected",
        reason: "User rejected this proposed clip.",
      },
    });
    expect(api.createClipFromSourceVideo).not.toHaveBeenCalled();
  });
});
