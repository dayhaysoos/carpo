import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { sourceVideoUploadUrl } from "../api";
import type {
  ClipProposalInput,
  ClipProposalReview,
  CreatedClipResult,
} from "../clip-proposal-review";
import { useClipProposalReview } from "../hooks/useClipProposalReview";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import {
  MIN_TRIM_GAP_SECONDS,
  type ClipSource,
} from "../types";
import { extractYoutubeVideoId, formatTimestamp } from "../youtube";
import { rangesOverlap, type ExistingClipRange } from "../timeline";
import { ModalDialog } from "./ModalDialog";
import { ExistingClipRail } from "./TrimSlider";

interface ClipReviewModalProps {
  review: ClipProposalReview;
  videoId: string;
  source?: ClipSource;
  retainedSourceReady?: boolean;
  onClipCreated: (clip: CreatedClipResult) => void;
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
  input: ClipProposalInput;
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
  input: ClipProposalInput;
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
  input: ClipProposalInput;
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
  originalInput: ClipProposalInput;
  input: ClipProposalInput;
  sourceDuration: number;
  existingClips: ExistingClipRange[];
  onChange: (input: ClipProposalInput) => void;
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
      Math.min(nextValue, input.endSeconds - MIN_TRIM_GAP_SECONDS),
    );
    onChange({ ...input, startSeconds: nextStart });
  };
  const changeEnd = (nextValue: number) => {
    const nextEnd = Math.min(
      window.max,
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
  review,
  videoId,
  source,
  retainedSourceReady = false,
  onClipCreated,
  existingClips = [],
}: ClipReviewModalProps) {
  const state = useClipProposalReview(review);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [hasNavigated, setHasNavigated] = useState(false);
  const approval = state.items[state.activeIndex];
  if (!approval) return null;

  const input = approval.input;
  const duration = Math.max(0, input.endSeconds - input.startSeconds);
  const currentDecision = approval.decision;

  const decide = (approved: boolean) => {
    review.dispatch({
      type: "decide",
      proposalId: approval.proposalId,
      approved,
    });
    if (state.activeIndex < state.items.length - 1) {
      setHasNavigated(true);
      review.dispatch({ type: "navigate", index: state.activeIndex + 1 });
    }
  };
  const moveTo = (index: number) => {
    setHasNavigated(true);
    review.dispatch({ type: "navigate", index });
  };
  const finishReview = async () => {
    const result = await review.finish();
    const latestCreated = result.created.at(-1);
    if (latestCreated) onClipCreated(latestCreated);
  };

  return (
    <ModalDialog
      labelledBy="clip-review-title"
      className="clip-review-modal"
      onDismiss={() => review.dispatch({ type: "dismiss" })}
    >
      <header className="modal-header clip-review-header">
        <div>
          <h2 id="clip-review-title">Review clips</h2>
          <p
            key={`progress-${approval.proposalId}`}
            className={
              hasNavigated
                ? "clip-review-progress clip-review-progress-advance"
                : "clip-review-progress"
            }
            aria-live="polite"
          >
            <strong>{state.activeIndex + 1} of {state.items.length}</strong>
          </p>
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close clip review"
          onClick={() => review.dispatch({ type: "dismiss" })}
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
          key={`details-${approval.proposalId}`}
          className={
            hasNavigated
              ? "clip-review-details clip-review-details-advance"
              : "clip-review-details"
          }
        >
          <div className="clip-review-proposal-heading">
            <strong>{input.title}</strong>
            {approval.provenance ? (
              <span>
                Suggested via {approval.provenance.label}
                {approval.provenance.basis === "timestamps"
                  ? " · timestamp selection — preview before approval"
                  : ""}
                {approval.provenance.sourceBlockIds?.length
                  ? ` · grounded in ${approval.provenance.sourceBlockIds.length} transcript passage${
                      approval.provenance.sourceBlockIds.length === 1 ? "" : "s"
                    }`
                  : ""}
              </span>
            ) : null}
          </div>
          {approval.provenance?.rationale ? (
            <p className="clip-review-rationale">
              {approval.provenance.rationale}
            </p>
          ) : null}
          <ClipRangeEditor
            approvalId={approval.proposalId}
            originalInput={approval.originalInput}
            input={input}
            sourceDuration={sourceDuration}
            existingClips={existingClips}
            onChange={(nextInput) =>
              review.dispatch({
                type: "edit",
                proposalId: approval.proposalId,
                input: nextInput,
              })
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
              <span>Overlay text</span>
              {input.caption}
            </p>
          ) : null}
          {approval.error ? (
            <div className="clip-review-error" role="alert">
              <strong>{input.title}</strong>: {approval.error}
            </div>
          ) : null}
        </div>
      </div>

      {state.submitError ? (
        <div className="clip-review-error" role="alert">
          {state.submitError}
        </div>
      ) : null}

      <div className="clip-review-decision">
        <button
          type="button"
          className="btn-ghost"
          disabled={state.submitting}
          onClick={() => decide(false)}
        >
          {state.activeIndex < state.items.length - 1
            ? "Reject and next"
            : "Reject clip"}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={state.submitting}
          onClick={() => decide(true)}
        >
          {state.activeIndex < state.items.length - 1
            ? "Approve and next"
            : "Approve clip"}
        </button>
      </div>

      <footer className="clip-review-footer">
        <div className="clip-review-navigation">
          <button
            type="button"
            className="btn-ghost"
            disabled={state.submitting || state.activeIndex === 0}
            onClick={() => moveTo(state.activeIndex - 1)}
          >
            Previous clip
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={
              state.submitting || state.activeIndex === state.items.length - 1
            }
            onClick={() => moveTo(state.activeIndex + 1)}
          >
            Next clip
          </button>
        </div>
        <div className="clip-review-bulk-actions">
          <span>{state.reviewedCount} of {state.items.length} reviewed</span>
          <button
            type="button"
            className="btn-ghost"
            disabled={state.submitting}
            onClick={() =>
              review.dispatch({ type: "decide-all", approved: false })
            }
          >
            Reject all
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={state.submitting}
            onClick={() =>
              review.dispatch({ type: "decide-all", approved: true })
            }
          >
            Approve all
          </button>
          {state.allReviewed ? (
            <button
              type="button"
              className="btn-primary"
              disabled={state.submitting}
              onClick={() => void finishReview()}
            >
              {state.submitting
                ? "Creating…"
                : state.approvedCount === 0
                ? "Finish review"
                : `Create ${state.approvedCount} approved clip${
                    state.approvedCount === 1 ? "" : "s"
                  }`}
            </button>
          ) : null}
        </div>
      </footer>
    </ModalDialog>
  );
}
