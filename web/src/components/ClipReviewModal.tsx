import { useEffect } from "react";
import { sourceVideoUploadUrl } from "../api";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import type { ClipQuality, ClipSource } from "../types";
import { extractYoutubeVideoId, formatTimestamp } from "../youtube";
import { ModalDialog } from "./ModalDialog";

export interface ManualClipInput {
  title: string;
  startSeconds: number;
  endSeconds: number;
  caption?: string;
  quality?: ClipQuality;
}

export interface PendingClipApproval {
  approvalId: string;
  input: ManualClipInput;
}

interface ClipReviewModalProps {
  videoId: string;
  sourceTitle?: string;
  source?: ClipSource;
  approvals: PendingClipApproval[];
  activeIndex: number;
  decisions: Readonly<Record<string, boolean>>;
  onActiveIndexChange: (index: number) => void;
  onDecision: (approvalId: string, approved: boolean) => void;
  onSubmit: () => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
  onDismiss: () => void;
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${rounded.toLocaleString()} ${rounded === 1 ? "second" : "seconds"}`;
}

function YouTubeClipPreview({
  youtubeId,
  input,
}: {
  youtubeId: string;
  input: ManualClipInput;
}) {
  const {
    containerId,
    ready,
    currentTime,
    seekTo,
    pauseVideo,
  } = useYoutubePlayer(youtubeId);

  useEffect(() => {
    if (ready) seekTo(input.startSeconds);
  }, [input.startSeconds, ready, seekTo]);

  useEffect(() => {
    if (ready && currentTime >= input.endSeconds) pauseVideo();
  }, [currentTime, input.endSeconds, pauseVideo, ready]);

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
  input,
}: {
  videoId: string;
  source?: ClipSource;
  input: ManualClipInput;
}) {
  if (!source) {
    return (
      <div className="clip-review-preview-placeholder">
        Loading source preview…
      </div>
    );
  }

  if (source.type === "youtube") {
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
      />
    );
  }

  return (
    <video
      key={`${videoId}-${input.startSeconds}-${input.endSeconds}`}
      className="clip-review-player"
      src={`${sourceVideoUploadUrl(videoId)}#t=${input.startSeconds},${input.endSeconds}`}
      title={`Preview ${input.title}`}
      controls
      preload="metadata"
    />
  );
}

export function ClipReviewModal({
  videoId,
  sourceTitle,
  source,
  approvals,
  activeIndex,
  decisions,
  onActiveIndexChange,
  onDecision,
  onSubmit,
  onApproveAll,
  onRejectAll,
  onDismiss,
}: ClipReviewModalProps) {
  const approval = approvals[activeIndex];
  if (!approval) return null;

  const input = approval.input;
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
      onActiveIndexChange(activeIndex + 1);
    }
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
          <p>
            <strong>{activeIndex + 1} of {approvals.length}</strong>
            <span>
              {sourceTitle
                ? `From ${sourceTitle}`
                : "Preview each proposed range before creating anything."}
            </span>
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

      <div className="clip-review-preview">
        <ClipSourcePreview videoId={videoId} source={source} input={input} />
      </div>

      <div
        className="clip-review-details"
        aria-live="polite"
        aria-atomic="true"
      >
        <div>
          <h3>{input.title}</h3>
          <div className="clip-review-time">
            {formatTimestamp(input.startSeconds)}–
            {formatTimestamp(input.endSeconds)}
          </div>
        </div>
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

      <div className="clip-review-decision">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => decide(false)}
        >
          {activeIndex < approvals.length - 1 ? "Reject and next" : "Reject clip"}
        </button>
        <button
          type="button"
          className="btn-primary"
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
            disabled={activeIndex === 0}
            onClick={() => onActiveIndexChange(activeIndex - 1)}
          >
            Previous clip
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={activeIndex === approvals.length - 1}
            onClick={() => onActiveIndexChange(activeIndex + 1)}
          >
            Next clip
          </button>
        </div>
        <div className="clip-review-bulk-actions">
          <span>{reviewedCount} of {approvals.length} reviewed</span>
          <button type="button" className="btn-ghost" onClick={onRejectAll}>
            Reject all
          </button>
          <button type="button" className="btn-ghost" onClick={onApproveAll}>
            Approve all
          </button>
          {allReviewed ? (
            <button type="button" className="btn-primary" onClick={onSubmit}>
              {approvedCount === 0
                ? "Finish review"
                : `Create ${approvedCount} approved clip${approvedCount === 1 ? "" : "s"}`}
            </button>
          ) : null}
        </div>
      </footer>
    </ModalDialog>
  );
}
