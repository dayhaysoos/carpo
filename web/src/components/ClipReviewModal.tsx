import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { sourceVideoUploadUrl } from "../api";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import {
  MAX_CLIP_LENGTH_SECONDS,
  MIN_TRIM_GAP_SECONDS,
  type ClipQuality,
  type ClipSource,
} from "../types";
import { extractYoutubeVideoId, formatTimestamp } from "../youtube";
import { rangesOverlap, type ExistingClipRange } from "../timeline";
import { ModalDialog } from "./ModalDialog";
import { ExistingClipRail } from "./TrimSlider";

export interface ManualClipInput {
  title: string;
  startSeconds: number;
  endSeconds: number;
  caption?: string;
  quality?: ClipQuality;
}

export interface PendingClipApproval {
  approvalId: string;
  toolCallId: string;
  resolution: "approval" | "client";
  input: ManualClipInput;
}

interface ClipReviewModalProps {
  videoId: string;
  source?: ClipSource;
  retainedSourceReady?: boolean;
  approvals: PendingClipApproval[];
  activeIndex: number;
  decisions: Readonly<Record<string, boolean>>;
  inputs: Readonly<Record<string, ManualClipInput>>;
  submitting: boolean;
  submitError: string | null;
  onActiveIndexChange: (index: number) => void;
  onInputChange: (approvalId: string, input: ManualClipInput) => void;
  onDecision: (approvalId: string, approved: boolean) => void;
  onSubmit: () => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
  onDismiss: () => void;
  existingClips?: ExistingClipRange[];
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${rounded.toLocaleString()} ${rounded === 1 ? "second" : "seconds"}`;
}

function YouTubeClipPreview({
  youtubeId,
  input,
  onDurationChange,
}: {
  youtubeId: string;
  input: ManualClipInput;
  onDurationChange: (duration: number) => void;
}) {
  const {
    containerId,
    ready,
    duration,
    currentTime,
    seekTo,
    pauseVideo,
  } = useYoutubePlayer(youtubeId);

  useEffect(() => {
    if (ready) seekTo(input.startSeconds);
  }, [input.startSeconds, ready, seekTo]);

  useEffect(() => {
    if (ready && currentTime >= input.endSeconds) {
      pauseVideo();
      seekTo(input.startSeconds);
    }
  }, [
    currentTime,
    input.endSeconds,
    input.startSeconds,
    pauseVideo,
    ready,
    seekTo,
  ]);

  useEffect(() => {
    if (duration > 0) onDurationChange(duration);
  }, [duration, onDurationChange]);

  return (
    <div
      className="clip-review-player"
      aria-label={`Preview ${input.title}`}
    >
      <div id={containerId} className="clip-review-youtube-host" />
    </div>
  );
}

function ClipSourcePreview({
  videoId,
  source,
  retainedSourceReady,
  input,
  onDurationChange,
}: {
  videoId: string;
  source?: ClipSource;
  retainedSourceReady: boolean;
  input: ManualClipInput;
  onDurationChange: (duration: number) => void;
}) {
  if (!source) {
    return (
      <div className="clip-review-preview-placeholder">
        Loading source preview…
      </div>
    );
  }

  if (!retainedSourceReady && source.type === "youtube") {
    const youtubeId = extractYoutubeVideoId(source.url);
    if (!youtubeId) {
      return (
        <div className="clip-review-preview-placeholder">
          Preview unavailable
        </div>
      );
    }
    return (
      <YouTubeClipPreview
        key={youtubeId}
        youtubeId={youtubeId}
        input={input}
        onDurationChange={onDurationChange}
      />
    );
  }

  return (
    <UploadClipPreview
      videoId={videoId}
      input={input}
      onDurationChange={onDurationChange}
    />
  );
}

function UploadClipPreview({
  videoId,
  input,
  onDurationChange,
}: {
  videoId: string;
  input: ManualClipInput;
  onDurationChange: (duration: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video && Math.abs(video.currentTime - input.startSeconds) > 0.05) {
      video.currentTime = input.startSeconds;
    }
  }, [input.startSeconds]);

  return (
    <video
      ref={videoRef}
      className="clip-review-player"
      src={sourceVideoUploadUrl(videoId)}
      title={`Preview ${input.title}`}
      controls
      preload="metadata"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration)) onDurationChange(video.duration);
        video.currentTime = input.startSeconds;
      }}
      onTimeUpdate={(event) => {
        if (event.currentTarget.currentTime >= input.endSeconds) {
          event.currentTarget.pause();
          event.currentTarget.currentTime = input.startSeconds;
        }
      }}
    />
  );
}

function ClipRangeEditor({
  approvalId,
  originalInput,
  input,
  sourceDuration,
  existingClips,
  onChange,
}: {
  approvalId: string;
  originalInput: ManualClipInput;
  input: ManualClipInput;
  sourceDuration: number;
  existingClips: ExistingClipRange[];
  onChange: (input: ManualClipInput) => void;
}) {
  const window = useMemo(() => {
    const padding = 30;
    const min = Math.max(0, originalInput.startSeconds - padding);
    const unclampedMax = originalInput.endSeconds + padding;
    const max =
      sourceDuration > 0
        ? Math.min(sourceDuration, unclampedMax)
        : unclampedMax;
    return { min, max: Math.max(max, originalInput.endSeconds) };
  }, [
    approvalId,
    originalInput.endSeconds,
    originalInput.startSeconds,
    sourceDuration,
  ]);
  const span = Math.max(MIN_TRIM_GAP_SECONDS, window.max - window.min);
  const startPercent = ((input.startSeconds - window.min) / span) * 100;
  const endPercent = ((input.endSeconds - window.min) / span) * 100;
  const trackStyle = {
    "--clip-range-start": `${Math.max(0, Math.min(100, startPercent))}%`,
    "--clip-range-end": `${Math.max(0, Math.min(100, endPercent))}%`,
  } as CSSProperties;
  const overlappingClips = existingClips.filter((clip) =>
    rangesOverlap(
      { start: input.startSeconds, end: input.endSeconds },
      { start: clip.startSeconds, end: clip.endSeconds },
    ),
  );

  const changeStart = (nextValue: number) => {
    const nextStart = Math.max(
      window.min,
      input.endSeconds - MAX_CLIP_LENGTH_SECONDS,
      Math.min(nextValue, input.endSeconds - MIN_TRIM_GAP_SECONDS),
    );
    onChange({ ...input, startSeconds: nextStart });
  };
  const changeEnd = (nextValue: number) => {
    const nextEnd = Math.min(
      window.max,
      input.startSeconds + MAX_CLIP_LENGTH_SECONDS,
      Math.max(nextValue, input.startSeconds + MIN_TRIM_GAP_SECONDS),
    );
    onChange({ ...input, endSeconds: nextEnd });
  };

  return (
    <div className="clip-range-editor">
      <div className="clip-range-values">
        <span>
          Start <strong>{formatTimestamp(input.startSeconds)}</strong>
        </span>
        <span>
          End <strong>{formatTimestamp(input.endSeconds)}</strong>
        </span>
      </div>
      <div className="clip-range-track" style={trackStyle}>
        <input
          type="range"
          aria-label="Trim start"
          aria-valuetext={formatTimestamp(input.startSeconds)}
          min={window.min}
          max={window.max}
          step={0.1}
          value={input.startSeconds}
          onChange={(event) => changeStart(event.currentTarget.valueAsNumber)}
        />
        <input
          type="range"
          aria-label="Trim end"
          aria-valuetext={formatTimestamp(input.endSeconds)}
          min={window.min}
          max={window.max}
          step={0.1}
          value={input.endSeconds}
          onChange={(event) => changeEnd(event.currentTarget.valueAsNumber)}
        />
      </div>
      <ExistingClipRail
        clips={existingClips}
        selection={{ start: input.startSeconds, end: input.endSeconds }}
        window={{ start: window.min, end: window.max }}
      />
      <p className={overlappingClips.length > 0 ? "overlap" : undefined}>
        {overlappingClips.length > 0
          ? `Overlaps ${overlappingClips.length} existing ${
              overlappingClips.length === 1 ? "clip" : "clips"
            }`
          : "Fine-tune this clip before approving it."}
      </p>
    </div>
  );
}

export function ClipReviewModal({
  videoId,
  source,
  retainedSourceReady = false,
  approvals,
  activeIndex,
  decisions,
  inputs,
  submitting,
  submitError,
  onActiveIndexChange,
  onInputChange,
  onDecision,
  onSubmit,
  onApproveAll,
  onRejectAll,
  onDismiss,
  existingClips = [],
}: ClipReviewModalProps) {
  const [sourceDuration, setSourceDuration] = useState(0);
  const [hasNavigated, setHasNavigated] = useState(false);
  const approval = approvals[activeIndex];
  if (!approval) return null;

  const input = inputs[approval.approvalId] ?? approval.input;
  const duration = Math.max(0, input.endSeconds - input.startSeconds);
  const reviewedCount = approvals.filter((item) =>
    Object.hasOwn(decisions, item.approvalId),
  ).length;
  const approvedCount = approvals.filter(
    (item) => decisions[item.approvalId] === true,
  ).length;
  const allReviewed = reviewedCount === approvals.length;
  const currentDecision = Object.hasOwn(decisions, approval.approvalId)
    ? decisions[approval.approvalId]
    : null;

  const decide = (approved: boolean) => {
    onDecision(approval.approvalId, approved);
    if (activeIndex < approvals.length - 1) {
      setHasNavigated(true);
      onActiveIndexChange(activeIndex + 1);
    }
  };
  const moveTo = (index: number) => {
    setHasNavigated(true);
    onActiveIndexChange(index);
  };

  return (
    <ModalDialog
      labelledBy="clip-review-title"
      className="clip-review-modal"
      onDismiss={onDismiss}
    >
      <header className="modal-header clip-review-header">
        <div>
          <h2 id="clip-review-title">Review clips</h2>
          <p
            key={`progress-${approval.approvalId}`}
            className={
              hasNavigated
                ? "clip-review-progress clip-review-progress-advance"
                : "clip-review-progress"
            }
            aria-live="polite"
          >
            <strong>{activeIndex + 1} of {approvals.length}</strong>
          </p>
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close clip review"
          onClick={onDismiss}
        >
          ×
        </button>
      </header>

      <div className="clip-review-step">
        <div className="clip-review-preview">
          <ClipSourcePreview
            videoId={videoId}
            source={source}
            retainedSourceReady={retainedSourceReady}
            input={input}
            onDurationChange={setSourceDuration}
          />
        </div>

        <div
          key={`details-${approval.approvalId}`}
          className={
            hasNavigated
              ? "clip-review-details clip-review-details-advance"
              : "clip-review-details"
          }
        >
          <ClipRangeEditor
            approvalId={approval.approvalId}
            originalInput={approval.input}
            input={input}
            sourceDuration={sourceDuration}
            existingClips={existingClips}
            onChange={(nextInput) =>
              onInputChange(approval.approvalId, nextInput)
            }
          />
          <div className="clip-review-meta">
            <span>{formatDuration(duration)}</span>
            <span>{input.quality ?? "1080p"}</span>
            {currentDecision !== null ? (
              <span className={currentDecision ? "approved" : "rejected"}>
                {currentDecision ? "Approved" : "Rejected"}
              </span>
            ) : null}
          </div>
          {input.caption ? (
            <p className="clip-review-caption">
              <span>Caption</span>
              {input.caption}
            </p>
          ) : null}
        </div>
      </div>

      {submitError ? (
        <div className="clip-review-error" role="alert">
          {submitError}
        </div>
      ) : null}

      <div className="clip-review-decision">
        <button
          type="button"
          className="btn-ghost"
          disabled={submitting}
          onClick={() => decide(false)}
        >
          {activeIndex < approvals.length - 1 ? "Reject and next" : "Reject clip"}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={submitting}
          onClick={() => decide(true)}
        >
          {activeIndex < approvals.length - 1
            ? "Approve and next"
            : "Approve clip"}
        </button>
      </div>

      <footer className="clip-review-footer">
        <div className="clip-review-navigation">
          <button
            type="button"
            className="btn-ghost"
            disabled={submitting || activeIndex === 0}
            onClick={() => moveTo(activeIndex - 1)}
          >
            Previous clip
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={submitting || activeIndex === approvals.length - 1}
            onClick={() => moveTo(activeIndex + 1)}
          >
            Next clip
          </button>
        </div>
        <div className="clip-review-bulk-actions">
          <span>{reviewedCount} of {approvals.length} reviewed</span>
          <button
            type="button"
            className="btn-ghost"
            disabled={submitting}
            onClick={onRejectAll}
          >
            Reject all
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={submitting}
            onClick={onApproveAll}
          >
            Approve all
          </button>
          {allReviewed ? (
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={onSubmit}
            >
              {submitting
                ? "Creating…"
                : approvedCount === 0
                ? "Finish review"
                : `Create ${approvedCount} approved clip${approvedCount === 1 ? "" : "s"}`}
            </button>
          ) : null}
        </div>
      </footer>
    </ModalDialog>
  );
}
