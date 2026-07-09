import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CLIP_LENGTH_SECONDS } from "../types";
import { formatTimestamp, parseTimestampInput } from "../youtube";

interface TrimRange {
  start: number;
  end: number;
}

interface UseTrimRangeOptions {
  duration: number;
  onSeek: (seconds: number) => void;
}

function clampRange(
  start: number,
  end: number,
  duration: number,
): TrimRange {
  const maxEnd = duration > 0 ? duration : MAX_CLIP_LENGTH_SECONDS;
  let s = Math.max(0, Math.min(start, maxEnd));
  let e = Math.max(0, Math.min(end, maxEnd));

  if (e <= s) {
    e = Math.min(s + 1, maxEnd);
  }

  if (e - s > MAX_CLIP_LENGTH_SECONDS) {
    e = s + MAX_CLIP_LENGTH_SECONDS;
  }

  return { start: s, end: e };
}

export function useTrimRange({ duration, onSeek }: UseTrimRangeOptions) {
  const [range, setRange] = useState<TrimRange>({ start: 0, end: 10 });
  const [startInput, setStartInput] = useState("0:00.000");
  const [endInput, setEndInput] = useState("0:10.000");
  const [activeHandle, setActiveHandle] = useState<"start" | "end" | null>(null);
  const dragRef = useRef<{
    handle: "start" | "end";
    trackLeft: number;
    trackWidth: number;
  } | null>(null);

  const syncInputs = useCallback((next: TrimRange) => {
    setStartInput(formatTimestamp(next.start));
    setEndInput(formatTimestamp(next.end));
  }, []);

  const applyRange = useCallback(
    (start: number, end: number, seekHandle?: "start" | "end") => {
      const next = clampRange(start, end, duration);
      setRange(next);
      syncInputs(next);
      if (seekHandle) {
        onSeek(seekHandle === "start" ? next.start : next.end);
      }
    },
    [duration, onSeek, syncInputs],
  );

  useEffect(() => {
    if (duration > 0) {
      const end = Math.min(10, duration, MAX_CLIP_LENGTH_SECONDS);
      applyRange(0, end, "start");
    }
  }, [duration]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPercent = duration > 0 ? (range.start / duration) * 100 : 0;
  const endPercent = duration > 0 ? (range.end / duration) * 100 : 100;
  const clipDuration = range.end - range.start;
  const overMax = clipDuration > MAX_CLIP_LENGTH_SECONDS;

  const valueFromClientX = (clientX: number) => {
    const drag = dragRef.current;
    if (!drag || duration <= 0) return 0;
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - drag.trackLeft) / drag.trackWidth),
    );
    return ratio * duration;
  };

  const onPointerDown = (
    handle: "start" | "end",
    event: React.PointerEvent<HTMLButtonElement>,
    track: HTMLDivElement,
  ) => {
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    dragRef.current = {
      handle,
      trackLeft: rect.left,
      trackWidth: rect.width,
    };
    setActiveHandle(handle);
    onSeek(handle === "start" ? range.start : range.end);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    const value = valueFromClientX(event.clientX);
    if (drag.handle === "start") {
      applyRange(value, range.end, "start");
    } else {
      applyRange(range.start, value, "end");
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragRef.current = null;
    setActiveHandle(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onStartInputBlur = () => {
    const parsed = parseTimestampInput(startInput);
    if (parsed === null) {
      syncInputs(range);
      return;
    }
    applyRange(parsed, range.end, "start");
  };

  const onEndInputBlur = () => {
    const parsed = parseTimestampInput(endInput);
    if (parsed === null) {
      syncInputs(range);
      return;
    }
    applyRange(range.start, parsed, "end");
  };

  return {
    range,
    startInput,
    endInput,
    setStartInput,
    setEndInput,
    startPercent,
    endPercent,
    clipDuration,
    overMax,
    activeHandle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onStartInputBlur,
    onEndInputBlur,
  };
}
