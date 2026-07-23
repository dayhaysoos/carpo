import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoAgentChat } from "./VideoAgentChat";

const chat = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
}));

vi.mock("agents/react", () => ({
  useAgent: (options: { onOpen?: () => void }) => {
    useEffect(() => options.onOpen?.(), [options.onOpen]);
    return {};
  },
}));

vi.mock("@cloudflare/think/react", () => ({
  useAgentChat: () => ({
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-createClip",
            toolCallId: "tool-1",
            state: "approval-requested",
            input: {
              title: "Manual range",
              startSeconds: 60,
              endSeconds: 64,
              quality: "1080p",
            },
            approval: { id: "approval-1" },
          },
        ],
      },
    ],
    sendMessage: vi.fn(),
    addToolApprovalResponse: chat.addToolApprovalResponse,
    status: "ready",
    error: undefined,
  }),
}));

describe("VideoAgentChat", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends the user's explicit preview decision to Think", async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <VideoAgentChat
        videoId="video-1"
        onClipCreated={vi.fn()}
        onTimestampSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("1:00.000–1:04.000")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create clip" }));

    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval-1",
      approved: true,
    });
  });

  it("turns typed timestamps into clickable editor windows", async () => {
    const user = userEvent.setup();
    const onTimestampSelect = vi.fn();
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
    await user.click(screen.getByRole("button", { name: "Use 30 second clips" }));
    await user.click(
      screen.getByRole("button", { name: "Set editor to 10:23 through 10:53" }),
    );

    expect(onTimestampSelect).toHaveBeenCalledWith({
      label: "10:23 → 10:53",
      startSeconds: 623,
      endSeconds: 653,
    });
  });
});
