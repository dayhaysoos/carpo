import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTrimRange } from "../hooks/useTrimRange";
import { TrimSlider } from "./TrimSlider";
import type { ExistingClipRange } from "../timeline";

function TrimHarness({
  duration = 24 * 60,
  onSeek = vi.fn(),
  showTimestampCommand = false,
  existingClips = [],
}: {
  duration?: number;
  onSeek?: (seconds: number) => void;
  showTimestampCommand?: boolean;
  existingClips?: ExistingClipRange[];
}) {
  const trim = useTrimRange({ duration, onSeek });
  return (
    <>
      {showTimestampCommand ? (
        <>
          <button type="button" onClick={() => trim.setClipWindow(623, 633)}>
            Use timestamp
          </button>
          <button
            type="button"
            onClick={() => trim.setClipWindow(1435, 1465)}
          >
            Use ending timestamp
          </button>
          <button type="button" onClick={() => trim.setClipWindow(628, 638)}>
            Use nearby timestamp
          </button>
        </>
      ) : null}
      <TrimSlider
        duration={duration}
        ready
        trim={trim}
        existingClips={existingClips}
      />
    </>
  );
}

describe("TrimSlider precision controls", () => {
  afterEach(cleanup);

  it("shows existing clip ranges and identifies overlap without blocking", () => {
    render(
      <TrimHarness
        duration={120}
        existingClips={[
          {
            id: "opening",
            title: "Existing opening",
            startSeconds: 2,
            endSeconds: 6,
          },
          {
            id: "later",
            title: "Existing later clip",
            startSeconds: 70,
            endSeconds: 75,
          },
        ]}
      />,
    );

    expect(screen.getByText("Overlaps 1 existing clip")).toBeTruthy();
    expect(
      screen.getAllByLabelText(
        "Existing clip Existing opening from 0:02.000 to 0:06.000",
      ),
    ).toHaveLength(1);
    expect(document.querySelector(".trim-existing-overlap")).toBeTruthy();
  });

  it("opens a stable precision view when a boundary receives focus", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);

    const start = screen.getByRole("slider", { name: "Trim start" });
    const end = screen.getByRole("slider", { name: "Trim end" });
    expect(start).toBeTruthy();
    expect(end).toBeTruthy();
    expect(start.getAttribute("aria-valuemax")).toBe("9.999");
    expect(start.getAttribute("aria-valuemin")).toBe("0");
    expect(end.getAttribute("aria-valuemax")).toBe("1440");
    expect(end.getAttribute("aria-valuemin")).toBe("0.001");

    await user.click(start);
    expect(screen.getByText("Precision start")).toBeTruthy();
    expect(
      screen.getByRole("slider", { name: "Precision trim start" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show 30 seconds" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    await user.click(end);
    expect(screen.getByText("Precision end")).toBeTruthy();
  });

  it("applies a timestamp window, seeks, and opens precision at its start", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TrimHarness onSeek={onSeek} showTimestampCommand />);
    onSeek.mockClear();

    await user.click(screen.getByRole("button", { name: "Use timestamp" }));

    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      "10:23.000",
    );
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      "10:33.000",
    );
    expect(screen.getByText("Precision start")).toBeTruthy();
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(623);
  });

  it("keeps the timestamp start fixed when its window reaches the video end", async () => {
    const user = userEvent.setup();
    render(<TrimHarness showTimestampCommand />);

    await user.click(
      screen.getByRole("button", { name: "Use ending timestamp" }),
    );

    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      "23:55.000",
    );
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      "24:00.000",
    );
    expect(screen.getByText("5.00s")).toBeTruthy();
  });

  it("does not round an end-of-source selection past a fractional duration", async () => {
    const user = userEvent.setup();
    render(<TrimHarness duration={3600.1236} />);
    const endInput = screen.getByLabelText("End") as HTMLInputElement;

    await user.clear(endInput);
    await user.type(endInput, "60:00.124");
    fireEvent.blur(endInput);

    expect(
      screen.getByRole("slider", { name: "Trim end" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("3600.1236");
  });

  it("recenters precision for every timestamp selection, even nearby ones", async () => {
    const user = userEvent.setup();
    render(<TrimHarness showTimestampCommand />);

    await user.click(screen.getByRole("button", { name: "Use timestamp" }));
    expect(screen.getByText("10:08.000")).toBeTruthy();
    expect(screen.getByText("10:38.000")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Use nearby timestamp" }),
    );
    expect(screen.getByText("10:13.000")).toBeTruthy();
    expect(screen.getByText("10:43.000")).toBeTruthy();
  });

  it("nudges the active boundary by tenths and whole seconds", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);
    const start = screen.getByRole("slider", { name: "Trim start" });

    await user.click(start);
    await user.keyboard("{ArrowRight}");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      "0:00.100",
    );

    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      "0:01.100",
    );
  });

  it("changes magnification without changing the selected timestamp", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);
    await user.click(screen.getByRole("slider", { name: "Trim end" }));
    const endInput = screen.getByLabelText("End") as HTMLInputElement;
    expect(endInput.value).toBe("0:10.000");

    await user.click(screen.getByRole("button", { name: "Show 5 seconds" }));
    expect(endInput.value).toBe("0:10.000");
    expect(
      screen.getByRole("button", { name: "Show 5 seconds" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  it("clamps the moved boundary without shifting its opposite boundary", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);
    const startInput = screen.getByLabelText("Start") as HTMLInputElement;
    const endInput = screen.getByLabelText("End") as HTMLInputElement;

    await user.clear(startInput);
    await user.type(startInput, "0:20.000");
    await user.tab();

    expect(startInput.value).toBe("0:09.000");
    expect(endInput.value).toBe("0:10.000");
  });

  it("allows a rough overview selection longer than 60 seconds", () => {
    render(<TrimHarness />);
    const end = screen.getByRole("slider", { name: "Trim end" });
    const track = end.parentElement as HTMLDivElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 6,
      top: 0,
      right: 1000,
      bottom: 6,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(end, { pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "Trim end" }), {
      pointerId: 1,
      clientX: 500,
    });

    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      "12:00.000",
    );
    expect(screen.getByText("11:45.000")).toBeTruthy();
    expect(screen.getByText("12:15.000")).toBeTruthy();
  });

  it("recenters precision when an overview drag is cancelled", () => {
    render(<TrimHarness />);
    const end = screen.getByRole("slider", { name: "Trim end" });
    const track = end.parentElement as HTMLDivElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 6,
      top: 0,
      right: 1000,
      bottom: 6,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(end, { pointerId: 3, clientX: 10 });
    fireEvent.pointerMove(end, { pointerId: 3, clientX: 500 });
    fireEvent.pointerCancel(
      screen.getByRole("slider", { name: "Trim end" }),
      { pointerId: 3, clientX: 500 },
    );

    expect(screen.getByText("11:45.000")).toBeTruthy();
    expect(screen.getByText("12:15.000")).toBeTruthy();
  });

  it("closes stale precision state when the source duration changes", async () => {
    const user = userEvent.setup();
    const view = render(<TrimHarness duration={24 * 60} />);
    await user.click(screen.getByRole("slider", { name: "Trim end" }));
    expect(screen.getByRole("region", { name: "Precision timeline" })).toBeTruthy();

    view.rerender(<TrimHarness duration={90} />);

    expect(
      screen.queryByRole("region", { name: "Precision timeline" }),
    ).toBeNull();
  });

  it("seeks only once when a boundary is activated by pointer", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TrimHarness onSeek={onSeek} />);
    onSeek.mockClear();

    await user.click(screen.getByRole("slider", { name: "Trim start" }));

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("keeps the displayed precision window stable when switching handles", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);
    const endInput = screen.getByLabelText("End") as HTMLInputElement;
    const startInput = screen.getByLabelText("Start") as HTMLInputElement;

    await user.clear(endInput);
    await user.type(endInput, "1:00.000");
    fireEvent.blur(endInput);
    await user.clear(startInput);
    await user.type(startInput, "0:50.000");
    fireEvent.blur(startInput);

    expect(screen.getByText("0:35.000")).toBeTruthy();
    expect(screen.getByText("1:05.000")).toBeTruthy();
    const precisionEnd = screen.getByRole("slider", {
      name: "Precision trim end",
    });
    const precisionTrack = precisionEnd.parentElement as HTMLDivElement;
    vi.spyOn(precisionTrack, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 6,
      top: 0,
      right: 1000,
      bottom: 6,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(precisionEnd, { pointerId: 2, clientX: 833 });
    fireEvent.pointerMove(precisionEnd, { pointerId: 2, clientX: 1000 });
    fireEvent.pointerUp(
      screen.getByRole("slider", { name: "Precision trim end" }),
      { pointerId: 2, clientX: 1000 },
    );

    expect(endInput.value).toBe("1:05.000");
    expect(screen.getByText("0:35.000")).toBeTruthy();
  });

  it("keeps keyboard focus while precision pans to follow a nudge", async () => {
    const user = userEvent.setup();
    render(<TrimHarness />);
    await user.click(screen.getByRole("slider", { name: "Trim end" }));
    const precisionEnd = screen.getByRole("slider", {
      name: "Precision trim end",
    });
    await user.click(precisionEnd);

    for (let step = 0; step < 21; step += 1) {
      await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    }

    expect(document.activeElement).toBe(precisionEnd);
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      "0:31.000",
    );
    expect(screen.getByText("0:16.000")).toBeTruthy();
    expect(screen.getByText("0:46.000")).toBeTruthy();
  });
});
