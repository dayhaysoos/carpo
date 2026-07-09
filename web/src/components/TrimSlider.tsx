import type { useTrimRange } from "../hooks/useTrimRange";

interface TrimSliderProps {
  duration: number;
  ready: boolean;
  trim: ReturnType<typeof useTrimRange>;
}

export function TrimSlider({ duration, ready, trim }: TrimSliderProps) {
  const disabled = !ready || duration <= 0;

  return (
    <div className="trim-section">
      <div className="trim-header">
        <span className="trim-label">Trim window</span>
        <span className={`trim-duration ${trim.overMax ? "error" : ""}`}>
          {trim.clipDuration.toFixed(2)}s
          {trim.overMax ? ` (max ${60}s)` : ""}
        </span>
      </div>

      <div
        className={`trim-track-wrap ${disabled ? "disabled" : ""}`}
        ref={(el) => {
          if (el) {
            (trim as unknown as { trackEl?: HTMLDivElement }).trackEl = el;
          }
        }}
      >
        <div className="trim-track">
          <div
            className="trim-fill"
            style={{
              left: `${trim.startPercent}%`,
              width: `${trim.endPercent - trim.startPercent}%`,
            }}
          />
          <button
            type="button"
            className={`trim-handle start ${trim.activeHandle === "start" ? "active" : ""}`}
            style={{ left: `${trim.startPercent}%` }}
            disabled={disabled}
            aria-label="Trim start"
            onPointerDown={(e) => {
              const track = e.currentTarget.parentElement;
              if (track) trim.onPointerDown("start", e, track as HTMLDivElement);
            }}
            onPointerMove={trim.onPointerMove}
            onPointerUp={trim.onPointerUp}
          />
          <button
            type="button"
            className={`trim-handle end ${trim.activeHandle === "end" ? "active" : ""}`}
            style={{ left: `${trim.endPercent}%` }}
            disabled={disabled}
            aria-label="Trim end"
            onPointerDown={(e) => {
              const track = e.currentTarget.parentElement;
              if (track) trim.onPointerDown("end", e, track as HTMLDivElement);
            }}
            onPointerMove={trim.onPointerMove}
            onPointerUp={trim.onPointerUp}
          />
        </div>
      </div>

      <div className="trim-inputs">
        <label className="field">
          <span>Start</span>
          <input
            type="text"
            value={trim.startInput}
            onChange={(e) => trim.setStartInput(e.target.value)}
            onBlur={trim.onStartInputBlur}
            onKeyDown={(e) => e.key === "Enter" && trim.onStartInputBlur()}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>End</span>
          <input
            type="text"
            value={trim.endInput}
            onChange={(e) => trim.setEndInput(e.target.value)}
            onBlur={trim.onEndInputBlur}
            onKeyDown={(e) => e.key === "Enter" && trim.onEndInputBlur()}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}
