import { useQuery } from "@tanstack/react-query";
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

function VideoProjectCard({ video }: { video: SourceVideoResponse }) {
  const clipLabel = `${video.clipCount} clip${video.clipCount === 1 ? "" : "s"}`;

  return (
    <article className="video-project">
      <Link
        to={`/library/videos/${video.id}`}
        className="video-project-link"
        aria-label={`Open ${video.title}, ${clipLabel}`}
      >
        <div className="video-project-thumb-wrap">
          {video.thumbnail ? (
            <img src={video.thumbnail} alt="" className="video-project-thumb" />
          ) : (
            <div className="video-project-thumb placeholder">No preview yet</div>
          )}
          {video.activeClipCount > 0 && (
            <span className="status-badge status-encoding">
              {video.activeClipCount} processing
            </span>
          )}
        </div>
        <div className="video-project-body">
          <div>
            <h3>{video.title}</h3>
            <p>
              {sourceLabel(video)}
              <span className="library-meta-sep">·</span>
              Updated {formatDate(video.updatedAt)}
            </p>
          </div>
          <div className="video-project-count">
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
  const { data, error, isLoading } = useQuery({
    queryKey: sourceVideosQueryKey(archived),
    queryFn: () => listSourceVideos(50, 0, archived),
    refetchInterval: (query) => {
      const videos = query.state.data?.videos ?? [];
      return videos.some((video) => video.activeClipCount > 0) ? 1000 : false;
    },
  });

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
          {data && data.total > 0 && (
            <span className="library-total">
              {data.total} video{data.total === 1 ? "" : "s"}
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

        {data?.videos.length === 0 && (
          <div className="empty-state">
            <p>{archived ? "No archived videos." : "No videos yet."}</p>
            {!archived && (
              <Link to="/" className="inline-link">
                Create your first clip
              </Link>
            )}
          </div>
        )}

        {data && data.videos.length > 0 && (
          <div className="video-project-list">
            {data.videos.map((video) => (
              <VideoProjectCard key={video.id} video={video} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
