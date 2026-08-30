import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listClips } from "../api";
import { isYoutubeBlockedError } from "../errors";
import { CLIPS_QUERY_KEY } from "../queries";
import { isTerminalStatus, statusLabel, statusProgress } from "../status";
import type { ClipResponse } from "../types";
import { ClipFailureMessage } from "./ClipFailureMessage";

interface StatusPanelScope {
  excludeVideoId?: string;
  includeBlockedFailureVideoId?: string;
}

export function visibleStatusPanelClips(
  clips: readonly ClipResponse[],
  scope: StatusPanelScope,
) {
  const inFlightClips = clips.filter(
    (clip) =>
      !isTerminalStatus(clip.status) && clip.videoId !== scope.excludeVideoId,
  );
  const blockedFailureClips = scope.includeBlockedFailureVideoId
    ? clips.filter(
        (clip) =>
          clip.videoId === scope.includeBlockedFailureVideoId &&
          clip.status === "failed" &&
          (Boolean(clip.sourceFailure) ||
            isYoutubeBlockedError(clip.errorMessage)),
      )
    : [];
  return {
    inFlightClips,
    blockedFailureClips,
    visibleClips: [...inFlightClips, ...blockedFailureClips],
  };
}

function JobCard({ clip }: { clip: ClipResponse }) {
  const progress = statusProgress(clip.status);

  return (
    <article className={`job-card status-${clip.status}`}>
      <div className="job-header">
        <div>
          <h3 className="job-title">{clip.title}</h3>
          <p className="job-meta">
            {clip.trimStart.toFixed(2)}s → {clip.trimEnd.toFixed(2)}s
            <span className="job-meta-sep">·</span>
            {clip.quality}
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

      {clip.status === "failed" && clip.errorMessage && (
        <ClipFailureMessage
          message={clip.errorMessage}
          failure={clip.sourceFailure}
        />
      )}
    </article>
  );
}

export function StatusPanel({
  excludeVideoId,
  includeBlockedFailureVideoId,
}: StatusPanelScope) {
  const { data, error, isLoading } = useQuery({
    queryKey: CLIPS_QUERY_KEY,
    queryFn: () => listClips(),
    refetchInterval: (query) => {
      const clips = query.state.data?.clips ?? [];
      const hasInFlight = clips.some((clip) => !isTerminalStatus(clip.status));
      return hasInFlight ? 1000 : false;
    },
  });

  const { inFlightClips, visibleClips } = visibleStatusPanelClips(
    data?.clips ?? [],
    {
      excludeVideoId,
      includeBlockedFailureVideoId,
    },
  );

  return (
    <section className="status-panel card">
      <div className="card-header">
        <h2>{excludeVideoId ? "Other jobs" : "Jobs"}</h2>
        <p>
          {visibleClips.length === 0
            ? excludeVideoId
              ? "Background work from your other videos appears here."
              : "Created clips appear here while encoding."
            : inFlightClips.length > 0
              ? `${inFlightClips.length} in progress`
              : "Current YouTube clip needs attention"}
        </p>
      </div>

      {isLoading && !data && (
        <div className="empty-state">Loading jobs…</div>
      )}

      {error && !data && (
        <p className="job-error">{error.message}</p>
      )}

      {data && visibleClips.length === 0 && (
        <div className="empty-state">
          No active jobs.{" "}
          <Link to="/library" className="inline-link">
            View your library
          </Link>
        </div>
      )}

      {visibleClips.length > 0 && (
        <>
          <div className="job-list">
            {visibleClips.map((clip) => (
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
