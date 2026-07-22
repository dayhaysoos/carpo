import { ClipFailureMessage } from "./ClipFailureMessage";
import { statusLabel } from "../status";
import type { ClipResponse } from "../types";

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
}

export function ClipModal({ clip, onClose }: ClipModalProps) {
  if (!clip.outputs.mp4) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-modal-title"
      >
        <div className="modal-header">
          <h2 id="clip-modal-title">{clip.title}</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <video
          src={clip.outputs.mp4}
          poster={clip.outputs.thumbnail ?? undefined}
          controls
          autoPlay
          loop
          playsInline
          className="clip-preview"
        />
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
    </div>
  );
}

interface ClipLibraryCardProps {
  clip: ClipResponse;
  onPlay: (clip: ClipResponse) => void;
  onDelete: (clip: ClipResponse) => void;
  deleting: boolean;
  onRequestGif: (clip: ClipResponse) => void;
  gifExporting: boolean;
}

export function ClipLibraryCard({
  clip,
  onPlay,
  onDelete,
  deleting,
  onRequestGif,
  gifExporting,
}: ClipLibraryCardProps) {
  const isComplete = clip.status === "complete";
  const showStatus = !isComplete;

  return (
    <article className={`library-card status-${clip.status}`}>
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
      </div>
    </article>
  );
}
