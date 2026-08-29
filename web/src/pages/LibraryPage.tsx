import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  deleteSourceVideo,
  listSourceVideos,
  setSourceVideoArchived,
} from "../api";
import { ModalDialog } from "../components/ModalDialog";
import { VideoActionMenu } from "../components/VideoActionMenu";
import { CLIPS_QUERY_KEY, SOURCE_VIDEOS_QUERY_KEY, sourceVideosQueryKey } from "../queries";
import { settleWithConcurrency } from "../settleWithConcurrency";
import type { SourceVideoResponse } from "../types";
import { useSelection } from "../useSelection";

type LibraryAction = "archive" | "restore" | "delete";

interface ActionRequest {
  action: LibraryAction;
  videos: SourceVideoResponse[];
  bulk: boolean;
}

interface ActionFailure {
  video: SourceVideoResponse;
  message: string;
}

interface ActionResult extends ActionRequest {
  failures: ActionFailure[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sourceLabel(video: SourceVideoResponse): string {
  return video.source.type === "youtube" ? "YouTube" : "Upload";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The request failed";
}

async function performLibraryAction(request: ActionRequest): Promise<ActionResult> {
  const results = await settleWithConcurrency(
    request.videos,
    (video) => {
      if (request.action === "delete") return deleteSourceVideo(video.id);
      return setSourceVideoArchived(video.id, request.action === "archive");
    },
  );
  const failures = results.flatMap<ActionFailure>((result, index) =>
    result.status === "rejected"
      ? [{ video: request.videos[index], message: errorMessage(result.reason) }]
      : [],
  );
  return { ...request, failures };
}

function VideoCardContents({
  video,
  selecting,
  selected,
}: {
  video: SourceVideoResponse;
  selecting: boolean;
  selected: boolean;
}) {
  return (
    <>
      <div className="video-thumb-wrap">
        {video.thumbnail ? (
          <img src={video.thumbnail} alt="" className="video-thumb" />
        ) : (
          <div className="video-thumb placeholder">No preview yet</div>
        )}
        {selecting && (
          <span className="video-selection-mark" aria-hidden="true">
            {selected ? "✓" : ""}
          </span>
        )}
        {video.activeClipCount > 0 && (
          <span className="status-badge status-encoding">
            {video.activeClipCount} processing
          </span>
        )}
      </div>
      <div className="video-body">
        <div className="video-copy">
          <h3>{video.title}</h3>
          <p>
            {sourceLabel(video)}
            <span className="library-meta-sep">·</span>
            Updated {formatDate(video.updatedAt)}
          </p>
        </div>
        <div className="video-count">
          <strong>{video.clipCount}</strong>
          <span>{video.clipCount === 1 ? "clip" : "clips"}</span>
        </div>
      </div>
    </>
  );
}

function VideoCard({
  video,
  selecting,
  selected,
  actionPending,
  onToggle,
  onArchive,
  onDelete,
}: {
  video: SourceVideoResponse;
  selecting: boolean;
  selected: boolean;
  actionPending: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const clipLabel = `${video.clipCount} clip${video.clipCount === 1 ? "" : "s"}`;

  return (
    <article className={`video${selected ? " selected" : ""}`}>
      {selecting ? (
        <button
          type="button"
          className="video-link video-select-target"
          aria-label={`${selected ? "Deselect" : "Select"} ${video.title}, ${clipLabel}`}
          aria-pressed={selected}
          onClick={onToggle}
        >
          <VideoCardContents video={video} selecting selected={selected} />
        </button>
      ) : (
        <>
          <Link
            to={`/library/videos/${video.id}`}
            className="video-link"
            aria-label={`Open ${video.title}, ${clipLabel}`}
          >
            <VideoCardContents video={video} selecting={false} selected={false} />
          </Link>
          <VideoActionMenu
            videoTitle={video.title}
            archived={Boolean(video.archivedAt)}
            disabled={actionPending}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        </>
      )}
    </article>
  );
}

export function LibraryPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const archived = searchParams.get("view") === "archived";
  const [pendingDelete, setPendingDelete] = useState<SourceVideoResponse[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: sourceVideosQueryKey(archived),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listSourceVideos(24, pageParam, archived),
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce(
        (count, page) => count + page.videos.length,
        0,
      );
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: (query) => {
      const videos = query.state.data?.pages.flatMap((page) => page.videos) ?? [];
      return videos.some((video) => video.activeClipCount > 0) ? 1000 : false;
    },
  });
  const videos = data?.pages.flatMap((page) => page.videos) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const {
    allSelected: allLoadedSelected,
    cancelSelection,
    clearSelection,
    replaceSelection,
    selectedIds,
    selectedItems: selectedVideos,
    selecting,
    startSelection,
    toggleAll,
    toggleSelection,
  } = useSelection(videos);
  const selectedClipCount = selectedVideos.reduce(
    (count, video) => count + video.clipCount,
    0,
  );

  useEffect(() => {
    cancelSelection();
    setPendingDelete([]);
    setActionError(null);
    // The library view is a new selection context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived]);

  const resetSelection = () => {
    cancelSelection();
    setActionError(null);
  };

  const actionMutation = useMutation({
    mutationFn: performLibraryAction,
    onMutate: () => setActionError(null),
    onSuccess: (result) => {
      const failedIds = new Set(result.failures.map(({ video }) => video.id));
      const succeeded = result.videos.length - result.failures.length;
      void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
      if (result.action === "delete") {
        void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
      }

      if (result.failures.length === 0) {
        setPendingDelete([]);
        if (result.bulk) resetSelection();
        else {
          clearSelection();
          setActionError(null);
        }
        return;
      }

      if (result.bulk) replaceSelection(failedIds);
      else clearSelection();
      if (result.action === "delete") {
        setPendingDelete(result.failures.map(({ video }) => video));
      }
      const verb = result.action === "delete" ? "delete" : result.action;
      const prefix = succeeded > 0 ? `${succeeded} succeeded. ` : "";
      setActionError(
        `${prefix}Could not ${verb} ${result.failures.length} video${result.failures.length === 1 ? "" : "s"}. ${result.failures[0].message}`,
      );
    },
  });

  const toggleSelected = (videoId: string) => {
    setActionError(null);
    toggleSelection(videoId);
  };

  const deleteCount = pendingDelete.length;
  const deleteClipCount = pendingDelete.reduce(
    (count, video) => count + video.clipCount,
    0,
  );

  return (
    <main className="library-main">
      <section className="library-panel card">
        <div className="card-header library-heading">
          <div>
            <h2>{archived ? "Archived videos" : "Library"}</h2>
            <p>
              {archived
                ? "Videos hidden from your main library. Originals and clips are retained."
                : "Your source videos and the clips created from each one."}
            </p>
          </div>
          {total > 0 && (
            <div className="library-heading-actions">
              <span className="library-total">
                {total} video{total === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className="btn-secondary library-select-toggle"
                aria-label={selecting ? "Cancel video selection" : "Select videos"}
                onClick={() => {
                  if (selecting) resetSelection();
                  else {
                    startSelection();
                    setActionError(null);
                  }
                }}
                disabled={actionMutation.isPending}
              >
                {selecting ? "Cancel" : "Select"}
              </button>
            </div>
          )}
        </div>

        <div className="library-view-switch" aria-label="Library views">
          <Link
            to="/library"
            className={!archived ? "active" : undefined}
            aria-current={!archived ? "page" : undefined}
          >
            Videos
          </Link>
          <Link
            to="/library?view=archived"
            className={archived ? "active" : undefined}
            aria-current={archived ? "page" : undefined}
          >
            Archived
          </Link>
        </div>

        {selecting && videos.length > 0 && (
          <div className="library-bulk-bar" role="toolbar" aria-label="Selected video actions">
            <div className="library-selection-count" aria-live="polite">
              <strong>{selectedVideos.length} selected</strong>
              <span>
                {selectedClipCount} clip{selectedClipCount === 1 ? "" : "s"}
                {` · ${videos.length} videos loaded`}
              </span>
            </div>
            <div className="library-bulk-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={toggleAll}
                disabled={actionMutation.isPending}
              >
                {allLoadedSelected ? "Clear all" : "Select all loaded"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  actionMutation.mutate({
                    action: archived ? "restore" : "archive",
                    videos: selectedVideos,
                    bulk: true,
                  })
                }
                disabled={selectedVideos.length === 0 || actionMutation.isPending}
              >
                {actionMutation.isPending
                  ? "Working…"
                  : archived
                    ? "Restore"
                    : "Archive"}
              </button>
              <button
                type="button"
                className="btn-ghost library-bulk-delete"
                aria-label="Delete selected"
                onClick={() => setPendingDelete(selectedVideos)}
                disabled={selectedVideos.length === 0 || actionMutation.isPending}
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {actionError && pendingDelete.length === 0 && (
          <p className="form-error library-action-error" role="alert">
            {actionError}
          </p>
        )}

        {isLoading && !data && (
          <div className="empty-state">Loading your videos…</div>
        )}

        {error && !data && <div className="form-error">{error.message}</div>}

        {data && videos.length === 0 && (
          <div className="empty-state">
            <p>{archived ? "No archived videos." : "No videos yet."}</p>
            {!archived && (
              <Link to="/" className="inline-link">
                Create your first clip
              </Link>
            )}
          </div>
        )}

        {videos.length > 0 && (
          <>
            <div className="video-list">
              {videos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selecting={selecting}
                  selected={selectedIds.has(video.id)}
                  actionPending={actionMutation.isPending}
                  onToggle={() => toggleSelected(video.id)}
                  onArchive={() =>
                    actionMutation.mutate({
                      action: video.archivedAt ? "restore" : "archive",
                      videos: [video],
                      bulk: false,
                    })
                  }
                  onDelete={() => {
                    setActionError(null);
                    setPendingDelete([video]);
                  }}
                />
              ))}
            </div>
            {isFetchNextPageError && (
              <p className="form-error" role="alert">
                Could not load more videos. {error?.message}
              </p>
            )}
            {hasNextPage && (
              <div className="library-load-more">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage || actionMutation.isPending}
                >
                  {isFetchingNextPage
                    ? "Loading…"
                    : isFetchNextPageError
                      ? "Retry loading videos"
                      : "Load more videos"}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {deleteCount > 0 && (
        <ModalDialog
          labelledBy="delete-library-videos-title"
          role="alertdialog"
          className="confirm-panel"
          onDismiss={
            actionMutation.isPending
              ? undefined
              : () => {
                  setPendingDelete([]);
                  setActionError(null);
                }
          }
        >
          <h2 id="delete-library-videos-title">
            {deleteCount === 1 ? "Delete video?" : `Delete ${deleteCount} videos?`}
          </h2>
          {deleteCount === 1 ? (
            <p>
              <strong>{pendingDelete[0].title}</strong>, its {deleteClipCount} clip
              {deleteClipCount === 1 ? "" : "s"}, generated files, and any uploaded
              original will be removed permanently.
            </p>
          ) : (
            <p>
              These videos, their {deleteClipCount} clips, generated files, and any
              uploaded originals will be removed permanently.
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setPendingDelete([]);
                setActionError(null);
              }}
              disabled={actionMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary confirm-delete"
              onClick={() =>
                actionMutation.mutate({
                  action: "delete",
                  videos: pendingDelete,
                  bulk: selecting,
                })
              }
              disabled={actionMutation.isPending}
            >
              {actionMutation.isPending
                ? "Deleting…"
                : deleteCount === 1
                  ? "Delete video"
                  : `Delete ${deleteCount} videos`}
            </button>
          </div>
          {actionError && (
            <p className="job-error" role="alert">
              {actionError}
            </p>
          )}
        </ModalDialog>
      )}
    </main>
  );
}
