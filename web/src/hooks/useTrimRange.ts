import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_CLIP_LENGTH_SECONDS,
  MIN_TRIM_GAP_SECONDS,
} from "../types";
import { formatTimestamp, parseTimestampInput } from "../youtube";

interface TrimRange {
  start: number;
  end: number;
}

export type TrimHandle = "start" | "end";

export interface TrimTimelineWindow {
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
  movedHandle?: TrimHandle,
): TrimRange {
  const maxEnd = duration > 0 ? duration : MAX_CLIP_LENGTH_SECONDS;
  let s = Math.max(0, Math.min(start, maxEnd));
  let e = Math.max(0, Math.min(end, maxEnd));

  if (e <= s) {
    const fallbackGap = Math.min(1, maxEnd);
    if (movedHandle === "start") {
      s = Math.max(0, e - fallbackGap);
    } else {
      e = Math.min(maxEnd, s + fallbackGap);
    }
  }

  if (e - s > MAX_CLIP_LENGTH_SECONDS) {
    if (movedHandle === "start") {
      s = e - MAX_CLIP_LENGTH_SECONDS;
    } else {
      e = s + MAX_CLIP_LENGTH_SECONDS;
    }
  }

  s = Math.round(s * 1000) / 1000;
  e = Math.round(e * 1000) / 1000;
  if (e <= s) {
    const minimumGap = Math.min(MIN_TRIM_GAP_SECONDS, maxEnd);
    if (movedHandle === "start") {
      s = Math.max(0, e - minimumGap);
    } else {
      e = Math.min(maxEnd, s + minimumGap);
    }
  }

  return { start: s, end: e };
}

export function useTrimRange({ duration, onSeek }: UseTrimRangeOptions) {
  const [range, setRange] = useState<TrimRange>({ start: 0, end: 10 });
  const [startInput, setStartInput] = useState("0:00.000");
  const [endInput, setEndInput] = useState("0:10.000");
  const [activeHandle, setActiveHandle] = useState<TrimHandle | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<TrimHandle | null>(null);
  const dragRef = useRef<{
    handle: TrimHandle;
    trackLeft: number;
    trackWidth: number;
    window: TrimTimelineWindow;
    lastValue: number;
  } | null>(null);

  const syncInputs = useCallback((next: TrimRange) => {
    setStartInput(formatTimestamp(next.start));
    setEndInput(formatTimestamp(next.end));
  }, []);

  const applyRange = useCallback(
    (start: number, end: number, seekHandle?: TrimHandle) => {
      const next = clampRange(start, end, duration, seekHandle);
      setRange(next);
      syncInputs(next);
      if (seekHandle) {
        onSeek(seekHandle === "start" ? next.start : next.end);
      }
      return next;
    },
    [duration, onSeek, syncInputs],
  );

  useEffect(() => {
    dragRef.current = null;
    setActiveHandle(null);
    setDraggingHandle(null);
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
    return drag.window.start + ratio * (drag.window.end - drag.window.start);
  };

  const focusHandle = (handle: TrimHandle) => {
    setActiveHandle(handle);
    onSeek(handle === "start" ? range.start : range.end);
  };

  const nudgeHandle = (handle: TrimHandle, deltaSeconds: number) => {
    setActiveHandle(handle);
    if (handle === "start") {
      applyRange(range.start + deltaSeconds, range.end, "start");
    } else {
      applyRange(range.start, range.end + deltaSeconds, "end");
    }
  };

  const onHandleKeyDown = (
    handle: TrimHandle,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    nudgeHandle(handle, direction * (event.shiftKey ? 1 : 0.1));
  };

  const onPointerDown = (
    handle: TrimHandle,
    event: React.PointerEvent<HTMLButtonElement>,
    track: HTMLDivElement,
    window: TrimTimelineWindow = { start: 0, end: duration },
  ) => {
    const wasFocused = event.currentTarget === document.activeElement;
    event.currentTarget.focus();
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    dragRef.current = {
      handle,
      trackLeft: rect.left,
      trackWidth: rect.width,
      window,
      lastValue: handle === "start" ? range.start : range.end,
    };
    setDraggingHandle(handle);
    if (wasFocused) {
      onSeek(handle === "start" ? range.start : range.end);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    const value = valueFromClientX(event.clientX);
    if (drag.handle === "start") {
      drag.lastValue = applyRange(value, range.end, "start").start;
    } else {
      drag.lastValue = applyRange(range.start, value, "end").end;
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const completed = dragRef.current
      ? {
          handle: dragRef.current.handle,
          value: dragRef.current.lastValue,
        }
      : null;
    dragRef.current = null;
    setDraggingHandle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    return completed;
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    return onPointerUp(event);
  };

  const onStartInputBlur = () => {
    const parsed = parseTimestampInput(startInput);
    if (parsed === null) {
      syncInputs(range);
      return null;
    }
    return applyRange(parsed, range.end, "start");
  };

  const onEndInputBlur = () => {
    const parsed = parseTimestampInput(endInput);
    if (parsed === null) {
      syncInputs(range);
      return null;
    }
    return applyRange(range.start, parsed, "end");
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
    draggingHandle,
    focusHandle,
    nudgeHandle,
    onHandleKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onStartInputBlur,
    onEndInputBlur,
  };
}
