import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteClip, listClips, requestGifExport } from "../api";
import { ClipFailureMessage } from "../components/ClipFailureMessage";
import { CLIPS_QUERY_KEY } from "../queries";
import { isTerminalStatus, statusLabel } from "../status";
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

function ClipModal({ clip, onClose }: ClipModalProps) {
  if (!clip.outputs.mp4) {
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
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

interface LibraryCardProps {
  clip: ClipResponse;
  onPlay: (clip: ClipResponse) => void;
  onDelete: (clip: ClipResponse) => void;
  deleting: boolean;
  onRequestGif: (clip: ClipResponse) => void;
  gifExporting: boolean;
}

function LibraryCard({
  clip,
  onPlay,
  onDelete,
  deleting,
  onRequestGif,
  gifExporting,
}: LibraryCardProps) {
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
        <p className="library-card-date">{formatDate(clip.createdAt)}</p>

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

export function LibraryPage() {
  const queryClient = useQueryClient();
  const [playingClip, setPlayingClip] = useState<ClipResponse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClipResponse | null>(null);
  const [gifExportClipId, setGifExportClipId] = useState<string | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: CLIPS_QUERY_KEY,
    queryFn: () => listClips(),
    refetchInterval: (query) => {
      const clips = query.state.data?.clips ?? [];
      const hasInFlight = clips.some((clip) => !isTerminalStatus(clip.status));
      const hasGifEncoding = clips.some((clip) => clip.gifStatus === "encoding");
      return hasInFlight || hasGifEncoding ? 2000 : false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteClip,
    onSuccess: () => {
      setPendingDelete(null);
      setPlayingClip(null);
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    },
  });

  const gifMutation = useMutation({
    mutationFn: requestGifExport,
    onMutate: (clipId) => {
      setGifExportClipId(clipId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    },
    onSettled: () => {
      setGifExportClipId(null);
    },
  });

  const handleRequestGif = (clip: ClipResponse) => {
    gifMutation.mutate(clip.id);
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    deleteMutation.mutate(pendingDelete.id);
  };

  return (
    <main className="library-main">
      <section className="library-panel card">
        <div className="card-header">
          <h2>Library</h2>
          <p>
            {data?.total === 0
              ? "Every clip you create lives here until you delete it."
              : `${data?.total ?? 0} clip${data?.total === 1 ? "" : "s"}`}
          </p>
        </div>

        {isLoading && !data && (
          <div className="empty-state">Loading your clips…</div>
        )}

        {error && !data && (
          <div className="form-error">{error.message}</div>
        )}

        {data?.clips.length === 0 && (
          <div className="empty-state">
            No clips yet — create one on the home page.
          </div>
        )}

        {data && data.clips.length > 0 && (
          <div className="library-grid">
            {data.clips.map((clip) => (
              <LibraryCard
                key={clip.id}
                clip={clip}
                onPlay={setPlayingClip}
                onDelete={setPendingDelete}
                onRequestGif={handleRequestGif}
                deleting={
                  deleteMutation.isPending && pendingDelete?.id === clip.id
                }
                gifExporting={
                  (gifMutation.isPending && gifExportClipId === clip.id) ||
                  clip.gifStatus === "encoding"
                }
              />
            ))}
          </div>
        )}
        {gifMutation.error && (
          <p className="form-error">{gifMutation.error.message}</p>
        )}
      </section>

      {playingClip && (
        <ClipModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel confirm-panel" role="alertdialog">
            <h2>Delete clip?</h2>
            <p>
              <strong>{pendingDelete.title}</strong> will be removed permanently,
              including its files.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPendingDelete(null)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary confirm-delete"
                onClick={handleConfirmDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
            {deleteMutation.error && (
              <p className="job-error">{deleteMutation.error.message}</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
