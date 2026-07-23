import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TrimHandle,
  TrimTimelineWindow,
  useTrimRange,
} from "../hooks/useTrimRange";
import {
  MAX_CLIP_LENGTH_SECONDS,
  MIN_TRIM_GAP_SECONDS,
} from "../types";
import { rangesOverlap, type ExistingClipRange } from "../timeline";
import { formatTimestamp } from "../youtube";

interface TrimSliderProps {
  duration: number;
  ready: boolean;
  trim: ReturnType<typeof useTrimRange>;
  existingClips?: ExistingClipRange[];
}

const PRECISION_WINDOWS = [60, 30, 15, 5] as const;
type PrecisionWindowSeconds = (typeof PRECISION_WINDOWS)[number];

function percentageInWindow(value: number, window: TrimTimelineWindow): number {
  const span = window.end - window.start;
  if (span <= 0) return 0;
  return ((value - window.start) / span) * 100;
}

function makePrecisionWindow(
  anchor: number,
  requestedSeconds: number,
  duration: number,
): TrimTimelineWindow {
  const span = Math.min(requestedSeconds, duration);
  let start = Math.max(0, anchor - span / 2);
  let end = start + span;
  if (end > duration) {
    end = duration;
    start = Math.max(0, end - span);
  }
  return { start, end };
}

export function ExistingClipRail({
  clips,
  selection,
  window,
}: {
  clips: ExistingClipRange[];
  selection: { start: number; end: number };
  window: TrimTimelineWindow;
}) {
  const visible = clips
    .map((clip) => ({
      clip,
      start: Math.max(window.start, clip.startSeconds),
      end: Math.min(window.end, clip.endSeconds),
    }))
    .filter((item) => item.end > item.start);
  if (visible.length === 0) return null;

  return (
    <div className="trim-existing-rail" role="list" aria-label="Existing clips">
      {visible.map(({ clip, start, end }) => {
        const overlapStart = Math.max(start, selection.start);
        const overlapEnd = Math.min(end, selection.end);
        const overlap = overlapEnd > overlapStart;
        return (
          <span
            key={clip.id}
            className="trim-existing-range"
            role="listitem"
            aria-label={`Existing clip ${clip.title} from ${formatTimestamp(clip.startSeconds)} to ${formatTimestamp(clip.endSeconds)}`}
            style={{
              left: `${percentageInWindow(start, window)}%`,
              width: `${percentageInWindow(end, window) - percentageInWindow(start, window)}%`,
            }}
          >
            {overlap ? (
              <span
                className="trim-existing-overlap"
                aria-hidden="true"
                style={{
                  left: `${((overlapStart - start) / (end - start)) * 100}%`,
                  width: `${((overlapEnd - overlapStart) / (end - start)) * 100}%`,
                }}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function TrimHandleControl({
  handle,
  label,
  value,
  left,
  duration,
  active,
  dragging,
  disabled,
  track,
  window,
  trim,
  onActivate,
  showReadout = false,
  onPointerComplete,
}: {
  handle: TrimHandle;
  label: string;
  value: number;
  left: number;
  duration: number;
  active: boolean;
  dragging: boolean;
  disabled: boolean;
  track: HTMLDivElement | null;
  window: TrimTimelineWindow;
  trim: ReturnType<typeof useTrimRange>;
  onActivate: (handle: TrimHandle) => void;
  showReadout?: boolean;
  onPointerComplete?: (handle: TrimHandle, value: number) => void;
}) {
  const minimumGap = Math.min(MIN_TRIM_GAP_SECONDS, duration);
  return (
    <button
      type="button"
      role="slider"
      className={`trim-handle ${handle}${active ? " active" : ""}${dragging ? " dragging" : ""}`}
      style={{ left: `${left}%` }}
      disabled={disabled}
      aria-label={label}
      aria-valuemax={
        handle === "start"
          ? Math.max(0, trim.range.end - minimumGap)
          : Math.min(duration, trim.range.start + MAX_CLIP_LENGTH_SECONDS)
      }
      aria-valuemin={
        handle === "start"
          ? Math.max(0, trim.range.end - MAX_CLIP_LENGTH_SECONDS)
          : Math.min(duration, trim.range.start + minimumGap)
      }
      aria-valuenow={value}
      aria-valuetext={formatTimestamp(value)}
      aria-orientation="horizontal"
      onFocus={() => onActivate(handle)}
      onKeyDown={(event) => trim.onHandleKeyDown(handle, event)}
      onPointerDown={(event) => {
        if (!track) return;
        trim.onPointerDown(handle, event, track, window);
      }}
      onPointerMove={trim.onPointerMove}
      onPointerUp={(event) => {
        const completed = trim.onPointerUp(event);
        if (completed) {
          onPointerComplete?.(completed.handle, completed.value);
        }
      }}
      onPointerCancel={(event) => {
        const completed = trim.onPointerCancel(event);
        if (completed) {
          onPointerComplete?.(completed.handle, completed.value);
        }
      }}
    >
      <span className="trim-handle-bar" aria-hidden="true" />
      {active && showReadout && (
        <span className="trim-handle-readout" aria-hidden="true">
          {formatTimestamp(value)}
        </span>
      )}
    </button>
  );
}

export function TrimSlider({
  duration,
  ready,
  trim,
  existingClips = [],
}: TrimSliderProps) {
  const disabled = !ready || duration <= 0;
  const [overviewTrack, setOverviewTrack] = useState<HTMLDivElement | null>(null);
  const [precisionTrack, setPrecisionTrack] = useState<HTMLDivElement | null>(null);
  const [precisionSeconds, setPrecisionSeconds] =
    useState<PrecisionWindowSeconds>(30);
  const [precisionAnchor, setPrecisionAnchor] = useState(0);
  const centeredClipWindowRevision = useRef(0);

  const activeValue = trim.activeHandle
    ? trim.range[trim.activeHandle]
    : trim.range.start;
  const precisionWindow = useMemo(
    () => makePrecisionWindow(precisionAnchor, precisionSeconds, duration),
    [duration, precisionAnchor, precisionSeconds],
  );
  useEffect(() => {
    if (
      trim.activeHandle &&
      !trim.draggingHandle &&
      (activeValue < precisionWindow.start || activeValue > precisionWindow.end)
    ) {
      setPrecisionAnchor(activeValue);
    }
  }, [
    activeValue,
    precisionWindow.end,
    precisionWindow.start,
    trim.activeHandle,
    trim.draggingHandle,
  ]);
  useEffect(() => {
    if (trim.clipWindowRevision === centeredClipWindowRevision.current) return;
    centeredClipWindowRevision.current = trim.clipWindowRevision;
    setPrecisionAnchor(trim.range.start);
  }, [trim.clipWindowRevision, trim.range.start]);
  const precisionStartPercent = percentageInWindow(
    trim.range.start,
    precisionWindow,
  );
  const precisionEndPercent = percentageInWindow(
    trim.range.end,
    precisionWindow,
  );
  const visiblePrecisionStart =
    trim.activeHandle === "start" ||
    (precisionStartPercent >= 0 && precisionStartPercent <= 100);
  const visiblePrecisionEnd =
    trim.activeHandle === "end" ||
    (precisionEndPercent >= 0 && precisionEndPercent <= 100);
  const clampedPrecisionStart = Math.max(0, Math.min(100, precisionStartPercent));
  const clampedPrecisionEnd = Math.max(0, Math.min(100, precisionEndPercent));

  const activateHandle = (handle: TrimHandle) => {
    if (trim.activeHandle !== handle) {
      setPrecisionAnchor(trim.range[handle]);
    }
    trim.focusHandle(handle);
  };

  const changePrecision = (seconds: PrecisionWindowSeconds) => {
    setPrecisionAnchor(activeValue);
    setPrecisionSeconds(seconds);
  };

  const overviewWindow = { start: 0, end: duration };
  const overlappingClips = existingClips.filter((clip) =>
    rangesOverlap(
      { start: trim.range.start, end: trim.range.end },
      { start: clip.startSeconds, end: clip.endSeconds },
    ),
  );

  return (
    <div className="trim-section">
      <div className="trim-header">
        <span className="trim-label">Trim window</span>
        <span className={`trim-duration ${trim.overMax ? "error" : ""}`}>
          {trim.clipDuration.toFixed(2)}s
          {trim.overMax ? ` (max ${MAX_CLIP_LENGTH_SECONDS}s)` : ""}
        </span>
      </div>
      {overlappingClips.length > 0 ? (
        <p className="trim-overlap-status" role="status">
          Overlaps {overlappingClips.length} existing{" "}
          {overlappingClips.length === 1 ? "clip" : "clips"}
        </p>
      ) : null}

      <div className="trim-overview" aria-label="Full video timeline">
        <div className={`trim-track-wrap ${disabled ? "disabled" : ""}`}>
          <div className="trim-track" ref={setOverviewTrack}>
            <div
              className="trim-fill"
              style={{
                left: `${trim.startPercent}%`,
                width: `${trim.endPercent - trim.startPercent}%`,
              }}
            />
            <TrimHandleControl
              handle="start"
              label="Trim start"
              value={trim.range.start}
              left={trim.startPercent}
              duration={duration}
              active={trim.activeHandle === "start"}
              dragging={trim.draggingHandle === "start"}
              disabled={disabled}
              track={overviewTrack}
              window={overviewWindow}
              trim={trim}
              onActivate={activateHandle}
              onPointerComplete={(_handle, value) => setPrecisionAnchor(value)}
            />
            <TrimHandleControl
              handle="end"
              label="Trim end"
              value={trim.range.end}
              left={trim.endPercent}
              duration={duration}
              active={trim.activeHandle === "end"}
              dragging={trim.draggingHandle === "end"}
              disabled={disabled}
              track={overviewTrack}
              window={overviewWindow}
              trim={trim}
              onActivate={activateHandle}
              onPointerComplete={(_handle, value) => setPrecisionAnchor(value)}
            />
          </div>
          <ExistingClipRail
            clips={existingClips}
            selection={{ start: trim.range.start, end: trim.range.end }}
            window={overviewWindow}
          />
        </div>
        <div className="trim-scale" aria-hidden="true">
          <span>{formatTimestamp(0)}</span>
          <span>{formatTimestamp(duration)}</span>
        </div>
      </div>

      {trim.activeHandle && !disabled && (
        <section className="trim-precision" aria-label="Precision timeline">
          <div className="trim-precision-header">
            <div>
              <span className="trim-precision-label">
                Precision {trim.activeHandle}
              </span>
              <strong aria-live="polite">{formatTimestamp(activeValue)}</strong>
            </div>
            <div className="trim-zoom" role="group" aria-label="Precision zoom">
              {PRECISION_WINDOWS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  aria-label={`Show ${seconds} seconds`}
                  aria-pressed={precisionSeconds === seconds}
                  onClick={() => changePrecision(seconds)}
                >
                  {seconds}s
                </button>
              ))}
            </div>
          </div>

          <div className="trim-precision-track-wrap">
            <div className="trim-track precision" ref={setPrecisionTrack}>
              <div
                className="trim-fill"
                style={{
                  left: `${clampedPrecisionStart}%`,
                  width: `${Math.max(0, clampedPrecisionEnd - clampedPrecisionStart)}%`,
                }}
              />
              {visiblePrecisionStart && (
                <TrimHandleControl
                  handle="start"
                  label="Precision trim start"
                  value={trim.range.start}
                  left={clampedPrecisionStart}
                  duration={duration}
                  active={trim.activeHandle === "start"}
                  dragging={trim.draggingHandle === "start"}
                  disabled={disabled}
                  track={precisionTrack}
                  window={precisionWindow}
                  trim={trim}
                  onActivate={trim.focusHandle}
                  showReadout
                />
              )}
              {visiblePrecisionEnd && (
                <TrimHandleControl
                  handle="end"
                  label="Precision trim end"
                  value={trim.range.end}
                  left={clampedPrecisionEnd}
                  duration={duration}
                  active={trim.activeHandle === "end"}
                  dragging={trim.draggingHandle === "end"}
                  disabled={disabled}
                  track={precisionTrack}
                  window={precisionWindow}
                  trim={trim}
                  onActivate={trim.focusHandle}
                  showReadout
                />
              )}
            </div>
            <ExistingClipRail
              clips={existingClips}
              selection={{ start: trim.range.start, end: trim.range.end }}
              window={precisionWindow}
            />
            <div className="trim-scale" aria-hidden="true">
              <span>{formatTimestamp(precisionWindow.start)}</span>
              <span>{formatTimestamp(precisionWindow.end)}</span>
            </div>
          </div>

          <div className="trim-nudge-controls">
            {[-1, -0.1, 0.1, 1].map((delta) => (
              <button
                key={delta}
                type="button"
                className="btn-ghost"
                aria-label={`Move ${trim.activeHandle} ${delta < 0 ? "backward" : "forward"} by ${Math.abs(delta)} second${Math.abs(delta) === 1 ? "" : "s"}`}
                onClick={() => trim.nudgeHandle(trim.activeHandle!, delta)}
              >
                {delta > 0 ? "+" : "−"}
                {Math.abs(delta)}s
              </button>
            ))}
          </div>
          <p className="trim-keyboard-hint">
            Arrow keys move 0.1s · Shift + arrow moves 1s
          </p>
        </section>
      )}

      <div className="trim-inputs">
        <label className="field">
          <span>Start</span>
          <input
            type="text"
            value={trim.startInput}
            onFocus={() => activateHandle("start")}
            onChange={(event) => trim.setStartInput(event.target.value)}
            onBlur={() => {
              const next = trim.onStartInputBlur();
              if (next) setPrecisionAnchor(next.start);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const next = trim.onStartInputBlur();
                if (next) setPrecisionAnchor(next.start);
              }
            }}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>End</span>
          <input
            type="text"
            value={trim.endInput}
            onFocus={() => activateHandle("end")}
            onChange={(event) => trim.setEndInput(event.target.value)}
            onBlur={() => {
              const next = trim.onEndInputBlur();
              if (next) setPrecisionAnchor(next.end);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const next = trim.onEndInputBlur();
                if (next) setPrecisionAnchor(next.end);
              }
            }}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}
