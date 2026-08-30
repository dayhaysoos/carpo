import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { statusLabel } from "../status";
import type { ClipResponse } from "../types";
import { ClipFailureMessage } from "./ClipFailureMessage";
import { ModalDialog } from "./ModalDialog";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface ClipModalProps {
  clip: ClipResponse;
  onClose: () => void;
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
}

export function ClipModal({
  clip,
  onClose,
  position,
  total,
  onPrevious,
  onNext,
}: ClipModalProps) {
  if (!clip.outputs.mp4) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "video, input, textarea, select, [contenteditable='true']",
      )
    ) {
      return;
    }
    if (event.key === "ArrowLeft" && onPrevious) {
      event.preventDefault();
      onPrevious();
    } else if (event.key === "ArrowRight" && onNext) {
      event.preventDefault();
      onNext();
    }
  };

  return (
    <ModalDialog
      labelledBy="clip-modal-title"
      onDismiss={onClose}
      className="clip-library-modal"
    >
      <div onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <div className="clip-modal-heading">
            <h2 id="clip-modal-title">{clip.title}</h2>
            <span aria-live="polite">
              {position} of {total}
            </span>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <video
          key={clip.id}
          src={clip.outputs.mp4}
          poster={clip.outputs.thumbnail ?? undefined}
          aria-label={`${clip.title} video`}
          controls
          autoPlay
          loop
          playsInline
          className="clip-preview"
        />
        <div className="clip-modal-toolbar">
          <div className="clip-modal-navigation" aria-label="Clip previews">
            <button
              type="button"
              className="btn-secondary"
              aria-label="Previous clip"
              onClick={onPrevious}
              disabled={!onPrevious}
            >
              <span aria-hidden="true">←</span> Previous
            </button>
            <button
              type="button"
              className="btn-secondary"
              aria-label="Next clip"
              onClick={onNext}
              disabled={!onNext}
            >
              Next <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="modal-actions">
            <a href={clip.outputs.mp4} download className="btn-secondary">
              Download MP4
            </a>
            {clip.outputs.gif && (
              <a href={clip.outputs.gif} download className="btn-secondary">
                Download GIF
              </a>
            )}
          </div>
        </div>
        <p className="clip-modal-keyboard-hint">
          Use left and right arrows to move between clips.
        </p>
      </div>
    </ModalDialog>
  );
}

interface ClipLibraryCardProps {
  clip: ClipResponse;
  onPlay: (clip: ClipResponse) => void;
  onDelete: (clip: ClipResponse) => void;
  deleting: boolean;
  onRequestGif: (clip: ClipResponse) => void;
  onEditCaptions: (clip: ClipResponse) => void;
  onManageDistribution: (clip: ClipResponse) => void;
  gifExporting: boolean;
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}

export function ClipLibraryCard({
  clip,
  onPlay,
  onDelete,
  deleting,
  onRequestGif,
  onEditCaptions,
  onManageDistribution,
  gifExporting,
  selecting = false,
  selected = false,
  onToggle,
}: ClipLibraryCardProps) {
  const isComplete = clip.status === "complete";
  const showStatus = !isComplete;

  return (
    <article
      className={`library-card status-${clip.status}${selected ? " selected" : ""}`}
    >
      {selecting && (
        <button
          type="button"
          className="library-card-select-target"
          aria-label={`${selected ? "Deselect" : "Select"} ${clip.title}`}
          aria-pressed={selected}
          onClick={onToggle}
        />
      )}
      {selecting ? (
        <div className="library-thumb-btn">
          {clip.outputs.thumbnail ? (
            <img src={clip.outputs.thumbnail} alt="" className="library-thumb" />
          ) : (
            <div className="library-thumb placeholder">
              {showStatus ? statusLabel(clip.status) : "No preview"}
            </div>
          )}
          <span className="video-selection-mark" aria-hidden="true">
            {selected ? "✓" : ""}
          </span>
          {showStatus && (
            <span className={`status-badge status-${clip.status}`}>
              {statusLabel(clip.status)}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="library-thumb-btn"
          onClick={() => isComplete && onPlay(clip)}
          disabled={!isComplete}
          aria-label={isComplete ? `Play ${clip.title}` : clip.title}
        >
          {clip.outputs.thumbnail ? (
            <img src={clip.outputs.thumbnail} alt="" className="library-thumb" />
          ) : (
            <div className="library-thumb placeholder">
              {showStatus ? statusLabel(clip.status) : "No preview"}
            </div>
          )}
          {showStatus && (
            <span className={`status-badge status-${clip.status}`}>
              {statusLabel(clip.status)}
            </span>
          )}
        </button>
      )}

      <div className="library-card-body">
        <h3 className="library-card-title">{clip.title}</h3>
        <p className="library-card-meta">
          {formatDate(clip.createdAt)}
          <span className="library-meta-sep">·</span>
          {clip.quality}
        </p>

        {clip.status === "failed" && clip.errorMessage && (
          <ClipFailureMessage message={clip.errorMessage} />
        )}

        {clip.gifStatus === "failed" && clip.gifErrorMessage && (
          <p className="job-error">{clip.gifErrorMessage}</p>
        )}

        {!selecting && (
          <div className="library-card-actions">
            {isComplete && clip.outputs.mp4 && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onPlay(clip)}
                >
                  Play
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onEditCaptions(clip)}
                >
                  Captions
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onManageDistribution(clip)}
                >
                  Share &amp; export
                </button>
                <a href={clip.outputs.mp4} download className="btn-secondary">
                  Download
                </a>
                {clip.outputs.gif ? (
                  <a href={clip.outputs.gif} download className="btn-secondary">
                    GIF
                  </a>
                ) : clip.gifStatus === "encoding" || gifExporting ? (
                  <button type="button" className="btn-secondary" disabled>
                    GIF…
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => onRequestGif(clip)}
                  >
                    {clip.gifStatus === "failed" ? "Retry GIF" : "GIF"}
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="btn-ghost library-delete"
              onClick={() => onDelete(clip)}
              disabled={deleting}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
