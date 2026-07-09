import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listClips } from "../api";
import { CLIPS_QUERY_KEY } from "../queries";
import { isTerminalStatus, statusLabel, statusProgress } from "../status";
import type { ClipResponse } from "../types";

function JobCard({ clip }: { clip: ClipResponse }) {
  const progress = statusProgress(clip.status);

  return (
    <article className={`job-card status-${clip.status}`}>
      <div className="job-header">
        <div>
          <h3 className="job-title">{clip.title}</h3>
          <p className="job-meta">
            {clip.trimStart.toFixed(2)}s → {clip.trimEnd.toFixed(2)}s
          </p>
        </div>
      </div>

      <div className="job-status-row">
        <span className={`status-badge status-${clip.status}`}>
          {statusLabel(clip.status)}
        </span>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </article>
  );
}

export function StatusPanel() {
  const { data, error, isLoading } = useQuery({
    queryKey: CLIPS_QUERY_KEY,
    queryFn: () => listClips(),
    refetchInterval: (query) => {
      const clips = query.state.data?.clips ?? [];
      const hasInFlight = clips.some((clip) => !isTerminalStatus(clip.status));
      return hasInFlight ? 2000 : false;
    },
  });

  const inFlightClips =
    data?.clips.filter((clip) => !isTerminalStatus(clip.status)) ?? [];

  return (
    <section className="status-panel card">
      <div className="card-header">
        <h2>Jobs</h2>
        <p>
          {inFlightClips.length === 0
            ? "Created clips appear here while encoding."
            : `${inFlightClips.length} in progress`}
        </p>
      </div>

      {isLoading && !data && (
        <div className="empty-state">Loading jobs…</div>
      )}

      {error && !data && (
        <p className="job-error">{error.message}</p>
      )}

      {data && inFlightClips.length === 0 && (
        <div className="empty-state">
          No active jobs.{" "}
          <Link to="/library" className="inline-link">
            View your library
          </Link>
        </div>
      )}

      {inFlightClips.length > 0 && (
        <>
          <div className="job-list">
            {inFlightClips.map((clip) => (
              <JobCard key={clip.id} clip={clip} />
            ))}
          </div>
          <p className="status-panel-footer">
            Finished clips appear in the{" "}
            <Link to="/library" className="inline-link">
              library
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}
