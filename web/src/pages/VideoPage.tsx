import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
import { CaptionEditorModal } from "../components/CaptionEditorModal";
import { ClipDistributionModal } from "../components/ClipDistributionModal";
import { ModalDialog } from "../components/ModalDialog";
import {
  CLIPS_QUERY_KEY,
  SOURCE_VIDEOS_QUERY_KEY,
  sourceVideoQueryKey,
} from "../queries";
import { settleWithConcurrency } from "../settleWithConcurrency";
import { isTerminalStatus } from "../status";
import type { ClipResponse } from "../types";
import { useSelection } from "../useSelection";

interface ClipDeleteRequest {
  clips: ClipResponse[];
  bulk: boolean;
}

interface ClipDeleteResult extends ClipDeleteRequest {
  failures: Array<{ clip: ClipResponse; message: string }>;
}

async function deleteClips(
  request: ClipDeleteRequest,
): Promise<ClipDeleteResult> {
  const results = await settleWithConcurrency(
    request.clips,
    (clip) => deleteClip(clip.id),
  );
  const failures = results.flatMap<ClipDeleteResult["failures"][number]>(
    (result, index) =>
      result.status === "rejected"
        ? [
            {
              clip: request.clips[index],
              message:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Clip deletion failed",
            },
          ]
        : [],
  );
  return { ...request, failures };
}

export function VideoPage() {
  const { videoId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [playingClip, setPlayingClip] = useState<ClipResponse | null>(null);
  const [captionClip, setCaptionClip] = useState<ClipResponse | null>(null);
  const [distributionClip, setDistributionClip] =
    useState<ClipResponse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClipResponse[]>([]);
  const [clipActionError, setClipActionError] = useState<string | null>(null);
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

  const clips = data?.clips ?? [];
  const {
    allSelected: allClipsSelected,
    cancelSelection,
    clearSelection,
    replaceSelection,
    selectedIds: selectedClipIds,
    selectedItems: selectedClips,
    selecting: selectingClips,
    startSelection,
    toggleAll,
    toggleSelection,
  } = useSelection(clips);
  const playableClips = useMemo(
    () =>
      (data?.clips ?? []).filter(
        (clip) => clip.status === "complete" && Boolean(clip.outputs.mp4),
      ),
    [data?.clips],
  );
  const playingClipIndex = playingClip
    ? playableClips.findIndex((clip) => clip.id === playingClip.id)
    : -1;
  const activePlayingClip =
    playingClipIndex >= 0 ? playableClips[playingClipIndex] : null;

  const resetClipSelection = () => {
    cancelSelection();
    setClipActionError(null);
  };

  const deleteMutation = useMutation({
    mutationFn: deleteClips,
    onMutate: () => setClipActionError(null),
    onSuccess: (result) => {
      const failedIds = new Set(
        result.failures.map(({ clip }) => clip.id),
      );
      const succeeded = result.clips.length - result.failures.length;
      setPendingDelete([]);
      void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: sourceVideoQueryKey(videoId) });

      if (result.failures.length === 0) {
        if (
          playingClip &&
          result.clips.some((clip) => clip.id === playingClip.id)
        ) {
          setPlayingClip(null);
        }
        if (result.bulk) resetClipSelection();
        else clearSelection();
        return;
      }

      setPendingDelete(result.failures.map(({ clip }) => clip));
      if (result.bulk) replaceSelection(failedIds);
      else clearSelection();
      const prefix = succeeded > 0 ? `${succeeded} succeeded. ` : "";
      setClipActionError(
        `${prefix}Could not delete ${result.failures.length} clip${
          result.failures.length === 1 ? "" : "s"
        }. ${result.failures[0].message}`,
      );
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

  const toggleSelectedClip = (clipId: string) => {
    setClipActionError(null);
    toggleSelection(clipId);
  };

  const deleteCount = pendingDelete.length;

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
              ? "This video no longer exists."
              : error.message}
          </div>
        )}

        {data && (
          <>
            <div className="video-header">
              {data.video.thumbnail ? (
                <img src={data.video.thumbnail} alt="" />
              ) : (
                <div className="video-header-placeholder">No preview</div>
              )}
              <div className="video-header-copy">
                <p className="video-source">
                  {data.video.source.type === "youtube" ? "YouTube video" : "Uploaded video"}
                </p>
                <h2>{data.video.title}</h2>
                <p>
                  {data.video.clipCount} clip{data.video.clipCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="video-actions">
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

            <div className="video-clips-heading">
              <h3>Clips</h3>
              <button
                type="button"
                className="btn-secondary library-select-toggle"
                aria-label={
                  selectingClips ? "Cancel clip selection" : "Select clips"
                }
                onClick={() => {
                  if (selectingClips) resetClipSelection();
                  else {
                    startSelection();
                    setClipActionError(null);
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {selectingClips ? "Cancel" : "Select"}
              </button>
            </div>

            {selectingClips && data.clips.length > 0 && (
              <div
                className="library-bulk-bar"
                role="toolbar"
                aria-label="Selected clip actions"
              >
                <div className="library-selection-count" aria-live="polite">
                  <strong>{selectedClips.length} selected</strong>
                  <span>
                    {data.clips.length} clip
                    {data.clips.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="library-bulk-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label={
                      allClipsSelected ? "Clear all clips" : "Select all clips"
                    }
                    onClick={toggleAll}
                    disabled={deleteMutation.isPending}
                  >
                    {allClipsSelected ? "Clear all" : "Select all"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost library-bulk-delete"
                    aria-label="Delete selected"
                    onClick={() => setPendingDelete(selectedClips)}
                    disabled={
                      selectedClips.length === 0 || deleteMutation.isPending
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}

            {clipActionError && pendingDelete.length === 0 && (
              <p className="form-error library-action-error" role="alert">
                {clipActionError}
              </p>
            )}

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
                    onDelete={(selectedClip) => {
                      setClipActionError(null);
                      setPendingDelete([selectedClip]);
                    }}
                    deleting={
                      deleteMutation.isPending &&
                      pendingDelete.some(
                        (pendingClip) => pendingClip.id === clip.id,
                      )
                    }
                    onRequestGif={(selectedClip) =>
                      gifMutation.mutate(selectedClip.id)
                    }
                    onEditCaptions={setCaptionClip}
                    onManageDistribution={setDistributionClip}
                    gifExporting={
                      (gifMutation.isPending && gifExportClipId === clip.id) ||
                      clip.gifStatus === "encoding"
                    }
                    selecting={selectingClips}
                    selected={selectedClipIds.has(clip.id)}
                    onToggle={() => toggleSelectedClip(clip.id)}
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

      {activePlayingClip && playingClipIndex >= 0 && (
        <ClipModal
          clip={activePlayingClip}
          onClose={() => setPlayingClip(null)}
          position={playingClipIndex + 1}
          total={playableClips.length}
          onPrevious={
            playingClipIndex > 0
              ? () => setPlayingClip(playableClips[playingClipIndex - 1])
              : undefined
          }
          onNext={
            playingClipIndex < playableClips.length - 1
              ? () => setPlayingClip(playableClips[playingClipIndex + 1])
              : undefined
          }
        />
      )}

      {captionClip && (
        <CaptionEditorModal
          clip={captionClip}
          onClose={() => setCaptionClip(null)}
        />
      )}

      {distributionClip && (
        <ClipDistributionModal
          clip={distributionClip}
          onClose={() => setDistributionClip(null)}
        />
      )}

      {deleteCount > 0 && (
        <ModalDialog
          labelledBy="delete-clips-title"
          role="alertdialog"
          className="confirm-panel"
          onDismiss={
            deleteMutation.isPending
              ? undefined
              : () => {
                  setPendingDelete([]);
                  setClipActionError(null);
                }
          }
        >
          <h2 id="delete-clips-title">
            {deleteCount === 1 ? "Delete clip?" : `Delete ${deleteCount} clips?`}
          </h2>
          {deleteCount === 1 ? (
            <p>
              <strong>{pendingDelete[0].title}</strong> will be removed
              permanently, including its files.
            </p>
          ) : (
            <p>
              These {deleteCount} clips and their generated files will be
              removed permanently.
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setPendingDelete([]);
                setClipActionError(null);
              }}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary confirm-delete"
              onClick={() =>
                deleteMutation.mutate({
                  clips: pendingDelete,
                  bulk: selectingClips,
                })
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending
                ? "Deleting…"
                : deleteCount === 1
                  ? "Delete clip"
                  : `Delete ${deleteCount} clips`}
            </button>
          </div>
          {clipActionError && (
            <p className="job-error" role="alert">
              {clipActionError}
            </p>
          )}
        </ModalDialog>
      )}

      {pendingVideoDelete && data && (
        <ModalDialog
          labelledBy="delete-video-title"
          role="alertdialog"
          className="confirm-panel"
          onDismiss={
            deleteVideoMutation.isPending
              ? undefined
              : () => setPendingVideoDelete(false)
          }
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
        </ModalDialog>
      )}
    </main>
  );
}
