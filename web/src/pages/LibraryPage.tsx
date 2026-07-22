import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { listSourceVideos } from "../api";
import { sourceVideosQueryKey } from "../queries";
import type { SourceVideoResponse } from "../types";

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

function VideoCard({ video }: { video: SourceVideoResponse }) {
  const clipLabel = `${video.clipCount} clip${video.clipCount === 1 ? "" : "s"}`;

  return (
    <article className="video">
      <Link
        to={`/library/videos/${video.id}`}
        className="video-link"
        aria-label={`Open ${video.title}, ${clipLabel}`}
      >
        <div className="video-thumb-wrap">
          {video.thumbnail ? (
            <img src={video.thumbnail} alt="" className="video-thumb" />
          ) : (
            <div className="video-thumb placeholder">No preview yet</div>
          )}
          {video.activeClipCount > 0 && (
            <span className="status-badge status-encoding">
              {video.activeClipCount} processing
            </span>
          )}
        </div>
        <div className="video-body">
          <div>
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
      </Link>
    </article>
  );
}

export function LibraryPage() {
  const [searchParams] = useSearchParams();
  const archived = searchParams.get("view") === "archived";
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
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
            <span className="library-total">
              {total} video{total === 1 ? "" : "s"}
            </span>
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
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
            {hasNextPage && (
              <div className="library-load-more">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? "Loading…" : "Load more videos"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
