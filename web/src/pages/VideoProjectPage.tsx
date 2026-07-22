import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deleteClip,
  deleteSourceVideo,
  getSourceVideo,
  requestGifExport,
  setSourceVideoArchived,
} from "../api";
import {
  ClipLibraryCard,
  ClipModal,
} from "../components/ClipLibraryCard";
import {
  CLIPS_QUERY_KEY,
  SOURCE_VIDEOS_QUERY_KEY,
  sourceVideoQueryKey,
} from "../queries";
import { isTerminalStatus } from "../status";
import type { ClipResponse } from "../types";

export function VideoProjectPage() {
  const { videoId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [playingClip, setPlayingClip] = useState<ClipResponse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClipResponse | null>(null);
  const [gifExportClipId, setGifExportClipId] = useState<string | null>(null);
  const [pendingVideoDelete, setPendingVideoDelete] = useState(false);

  const { data, error, isLoading } = useQuery({
    queryKey: sourceVideoQueryKey(videoId),
    queryFn: () => getSourceVideo(videoId),
    enabled: Boolean(videoId),
    refetchInterval: (query) => {
      const clips = query.state.data?.clips ?? [];
      const hasInFlight = clips.some((clip) => !isTerminalStatus(clip.status));
      const hasGifEncoding = clips.some((clip) => clip.gifStatus === "encoding");
      return hasInFlight || hasGifEncoding ? 1000 : false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteClip,
    onSuccess: () => {
      setPendingDelete(null);
      setPlayingClip(null);
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: sourceVideoQueryKey(videoId) });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) =>
      setSourceVideoArchived(videoId, archived),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: sourceVideoQueryKey(videoId) });
      navigate("/library");
    },
  });

  const deleteVideoMutation = useMutation({
    mutationFn: () => deleteSourceVideo(videoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
      navigate("/library", { replace: true });
    },
  });

  const gifMutation = useMutation({
    mutationFn: requestGifExport,
    onMutate: (clipId) => setGifExportClipId(clipId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sourceVideoQueryKey(videoId) });
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    },
    onSettled: () => setGifExportClipId(null),
  });

  return (
    <main className="library-main">
      <section className="library-panel card">
        <Link to="/library" className="library-back-link">
          <span aria-hidden="true">←</span> All videos
        </Link>

        {isLoading && !data && (
          <div className="empty-state">Loading video clips…</div>
        )}

        {error && !data && (
          <div className="form-error">
            {error.message === "Video not found"
              ? "This video project no longer exists."
              : error.message}
          </div>
        )}

        {data && (
          <>
            <div className="video-project-header">
              {data.video.thumbnail ? (
                <img src={data.video.thumbnail} alt="" />
              ) : (
                <div className="video-project-header-placeholder">No preview</div>
              )}
              <div className="video-project-header-copy">
                <p className="video-project-source">
                  {data.video.source.type === "youtube" ? "YouTube video" : "Uploaded video"}
                </p>
                <h2>{data.video.title}</h2>
                <p>
                  {data.video.clipCount} clip{data.video.clipCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="video-project-actions">
                <Link
                  to={`/?video=${encodeURIComponent(videoId)}`}
                  className="btn-primary video-create-clip"
                >
                  Create clip
                </Link>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    archiveMutation.mutate(!Boolean(data.video.archivedAt))
                  }
                  disabled={archiveMutation.isPending}
                >
                  {archiveMutation.isPending
                    ? "Saving…"
                    : data.video.archivedAt
                      ? "Restore"
                      : "Archive"}
                </button>
                <button
                  type="button"
                  className="btn-ghost video-delete"
                  onClick={() => setPendingVideoDelete(true)}
                >
                  Delete video
                </button>
              </div>
            </div>

            {archiveMutation.error && (
              <p className="form-error">{archiveMutation.error.message}</p>
            )}

            <div className="project-clips-heading">
              <h3>Clips</h3>
            </div>

            {data.clips.length === 0 ? (
              <div className="empty-state">
                No clips yet — create one from this video.
              </div>
            ) : (
              <div className="library-grid">
                {data.clips.map((clip) => (
                <ClipLibraryCard
                  key={clip.id}
                  clip={clip}
                  onPlay={setPlayingClip}
                  onDelete={setPendingDelete}
                  deleting={
                    deleteMutation.isPending && pendingDelete?.id === clip.id
                  }
                  onRequestGif={(selectedClip) =>
                    gifMutation.mutate(selectedClip.id)
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
          </>
        )}
      </section>

      {playingClip && (
        <ClipModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel confirm-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-clip-title"
          >
            <h2 id="delete-clip-title">Delete clip?</h2>
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
                onClick={() => deleteMutation.mutate(pendingDelete.id)}
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

      {pendingVideoDelete && data && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel confirm-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-video-title"
          >
            <h2 id="delete-video-title">Delete video?</h2>
            <p>
              <strong>{data.video.title}</strong>, its retained original, and all
              {` ${data.video.clipCount} `}
              associated clip{data.video.clipCount === 1 ? "" : "s"} will be
              removed permanently.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPendingVideoDelete(false)}
                disabled={deleteVideoMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary confirm-delete"
                onClick={() => deleteVideoMutation.mutate()}
                disabled={deleteVideoMutation.isPending}
              >
                {deleteVideoMutation.isPending ? "Deleting…" : "Delete video"}
              </button>
            </div>
            {deleteVideoMutation.error && (
              <p className="job-error">{deleteVideoMutation.error.message}</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
