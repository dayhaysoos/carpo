import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoAgentChat } from "./VideoAgentChat";

const chat = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("agents/react", () => ({
  useAgent: (options: { onOpen?: () => void }) => {
    useEffect(() => options.onOpen?.(), [options.onOpen]);
    return {};
  },
}));

vi.mock("@cloudflare/think/react", () => ({
  useAgentChat: () => ({
    messages: chat.messages,
    sendMessage: vi.fn(),
    addToolApprovalResponse: chat.addToolApprovalResponse,
    status: "ready",
    error: undefined,
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

describe("VideoAgentChat", () => {
  beforeEach(() => {
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
        source={{
          type: "youtube",
          url: "https://www.youtube.com/watch?v=434cG4g5KLE",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Review clips" })).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Opening clip" })).toBeTruthy();
    expect(screen.getByText("0:03.000–0:06.000")).toBeTruthy();
    expect(
      screen.getByTitle("Preview Opening clip").getAttribute("src"),
    ).toContain("start=3&end=6");
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Next clip" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Middle clip" })).toBeTruthy();
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close clip review" }));
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
    expect(screen.getByText("3 clips ready to review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review clips" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Second clip" })).toBeTruthy();
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reject clip" }));
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Create 1 approved clip" }),
    );
    expect(chat.addToolApprovalResponse.mock.calls).toEqual([
      [{ id: "approval-first", approved: true }],
      [{ id: "approval-second", approved: false }],
    ]);
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

    expect(chat.addToolApprovalResponse.mock.calls).toEqual([
      [{ id: "approval-first", approved: true }],
      [{ id: "approval-second", approved: true }],
    ]);
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

    expect(chat.addToolApprovalResponse.mock.calls).toEqual([
      [{ id: "approval-first", approved: false }],
      [{ id: "approval-second", approved: false }],
    ]);
    expect(
      screen.queryByRole("heading", { name: "Review clips" }),
    ).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "Use 30 second clips" }));
    expect(onTimestampSelect).toHaveBeenLastCalledWith({
      label: "10:23 → 10:53",
      startSeconds: 623,
      endSeconds: 653,
    });

    const timestamp = screen.getByRole("button", {
      name: "Set editor to 10:23 through 10:53",
    });

    expect(timestamp.closest(".agent-composer-input")).toBeTruthy();
    expect(screen.queryByText("Move editor")).toBeNull();
    onTimestampSelect.mockClear();
    await user.click(timestamp);

    expect(onTimestampSelect).toHaveBeenCalledWith({
      label: "10:23 → 10:53",
      startSeconds: 623,
      endSeconds: 653,
    });
  });
});
