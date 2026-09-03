import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoTranscript } from "../api";
import { useTrimRange } from "../hooks/useTrimRange";
import { TranscriptPanel } from "./TranscriptPanel";

vi.mock("../api", () => ({
  getVideoTranscript: vi.fn(),
}));

const transcript = {
  transcriptStatus: "available" as const,
  language: "en",
  automatic: true,
  cached: true,
  blocks: [
    {
      id: "cue-0-2",
      startCueId: "cue-0",
      endCueId: "cue-2",
      startSeconds: 10,
      endSeconds: 13,
      text: "Reading every line slows reviews",
    },
    {
      id: "cue-3-5",
      startCueId: "cue-3",
      endCueId: "cue-5",
      startSeconds: 13,
      endSeconds: 18,
      text: "Focus on behavior and boundaries",
    },
    {
      id: "cue-6-7",
      startCueId: "cue-6",
      endCueId: "cue-7",
      startSeconds: 30,
      endSeconds: 34,
      text: "This is a separate thought",
    },
  ],
};

function renderPanel(
  options: {
    currentTime?: number;
    onSeek?: (seconds: number) => void;
    onRangeSelect?: (range: {
      startSeconds: number;
      endSeconds: number;
    }) => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranscriptPanel
        videoId="video-1"
        currentTime={options.currentTime ?? 0}
        editorReady
        onSeek={options.onSeek ?? vi.fn()}
        onRangeSelect={options.onRangeSelect ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function TranscriptTrimHarness({
  duration,
  editorReady,
}: {
  duration: number;
  editorReady: boolean;
}) {
  const trim = useTrimRange({ duration, onSeek: vi.fn() });
  return (
    <>
      <TranscriptPanel
        videoId="video-1"
        currentTime={0}
        editorReady={editorReady}
        onSeek={vi.fn()}
        onRangeSelect={({ startSeconds, endSeconds }) =>
          trim.setClipWindow(startSeconds, endSeconds)
        }
      />
      <output aria-label="Trim start">{trim.range.start}</output>
      <output aria-label="Trim end">{trim.range.end}</output>
    </>
  );
}

describe("TranscriptPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("polls while durable transcript preparation is running", async () => {
    vi.mocked(getVideoTranscript)
      .mockResolvedValueOnce({
        transcriptStatus: "checking",
        retryAfterMs: 10,
      })
      .mockResolvedValue(transcript);

    renderPanel();

    expect(await screen.findByText("Preparing transcript…")).toBeTruthy();
    expect(
      await screen.findByRole("status", { name: "Transcript ready" }),
    ).toBeTruthy();
    expect(getVideoTranscript).toHaveBeenCalledTimes(2);
  });

  it("stops polling when background transcript preparation fails", async () => {
    vi.mocked(getVideoTranscript)
      .mockResolvedValueOnce({
        transcriptStatus: "checking",
        retryAfterMs: 10,
      })
      .mockRejectedValue(new Error("simulated transcript preparation failure"));

    renderPanel();

    expect(
      await screen.findByText(/You can still create clips by setting the start and end times manually/),
    ).toBeTruthy();
    expect(screen.queryByText("simulated transcript preparation failure")).toBeNull();
    expect(screen.queryByText("Preparing transcript…")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getVideoTranscript).toHaveBeenCalledTimes(2);
  });

  it("seeks, selects a grounded passage, and sends it to the trim editor", async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue(transcript);
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const onRangeSelect = vi.fn();
    renderPanel({ currentTime: 14, onSeek, onRangeSelect });

    const first = await screen.findByRole("button", {
      name: /0:10 Reading every line slows reviews/,
    });
    const second = screen.getByRole("button", {
      name: /0:13 Focus on behavior and boundaries/,
    });
    expect(second.getAttribute("aria-current")).toBe("true");

    await user.click(first);
    expect(onSeek).toHaveBeenCalledWith(10);

    fireEvent.click(second, { shiftKey: true });
    await user.click(
      screen.getByRole("button", { name: "Use selected text" }),
    );

    expect(onRangeSelect).toHaveBeenCalledWith({
      startSeconds: 10,
      endSeconds: 18,
    });
    expect(screen.getByText("2 passages selected")).toBeTruthy();
  });

  it("filters the visible transcript without changing its timestamps", async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue(transcript);
    const user = userEvent.setup();
    renderPanel();

    const search = await screen.findByRole("searchbox", {
      name: "Search transcript",
    });
    await user.type(search, "boundaries");

    expect(
      screen.getByText("Focus on behavior and boundaries"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Reading every line slows reviews"),
    ).toBeNull();
  });

  it("waits for player metadata, then sets the real trim range exactly", async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue({
      ...transcript,
      blocks: [
        {
          id: "cue-0-1",
          startCueId: "cue-0",
          endCueId: "cue-1",
          startSeconds: 70,
          endSeconds: 74,
          text: "A late video passage",
        },
        {
          id: "cue-2-3",
          startCueId: "cue-2",
          endCueId: "cue-3",
          startSeconds: 74,
          endSeconds: 78,
          text: "continues at the same point",
        },
      ],
    });
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <TranscriptTrimHarness duration={0} editorReady={false} />
      </QueryClientProvider>,
    );
    const first = await screen.findByRole("button", {
      name: /1:10 A late video passage/,
    });
    expect(first.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Waiting for the video player")).toBeTruthy();

    view.unmount();
    const readyClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={readyClient}>
        <TranscriptTrimHarness duration={120} editorReady />
      </QueryClientProvider>,
    );
    const readyFirst = await screen.findByRole("button", {
      name: /1:10 A late video passage/,
    });
    const readySecond = screen.getByRole("button", {
      name: /1:14 continues at the same point/,
    });
    await user.click(readyFirst);
    fireEvent.click(readySecond, { shiftKey: true });
    await user.click(
      screen.getByRole("button", { name: "Use selected text" }),
    );

    expect(
      screen.getByRole("status", { name: "Trim start" }).textContent,
    ).toBe("70");
    expect(
      screen.getByRole("status", { name: "Trim end" }).textContent,
    ).toBe("78");
  });

  it("rejects a transcript selection longer than the clip limit", async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue({
      ...transcript,
      blocks: [
        {
          id: "cue-0-1",
          startCueId: "cue-0",
          endCueId: "cue-1",
          startSeconds: 0,
          endSeconds: 10,
          text: "The selection begins here",
        },
        {
          id: "cue-2-3",
          startCueId: "cue-2",
          endCueId: "cue-3",
          startSeconds: 65,
          endSeconds: 70,
          text: "The selection ends too late",
        },
      ],
    });
    const user = userEvent.setup();
    renderPanel();
    const first = await screen.findByRole("button", {
      name: /0:00 The selection begins here/,
    });
    const second = screen.getByRole("button", {
      name: /1:05 The selection ends too late/,
    });

    await user.click(first);
    fireEvent.click(second, { shiftKey: true });

    expect(
      screen.getByText("Selection exceeds the 60-second clip limit"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Use selected text" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
