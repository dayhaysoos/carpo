import { useQuery } from "@tanstack/react-query";
import { getClip } from "../api";
import { removeJobId } from "../jobStorage";
import { isTerminalStatus, statusLabel, statusProgress } from "../status";
import type { ClipResponse } from "../types";

interface JobCardProps {
  clipId: string;
  onDismiss: (id: string) => void;
}

function JobCard({ clipId, onDismiss }: JobCardProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["clip", clipId],
    queryFn: () => getClip(clipId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || isTerminalStatus(status)) return false;
      return 2000;
    },
  });

  if (isLoading && !data) {
    return (
      <article className="job-card loading">
        <div className="job-title">Loading…</div>
      </article>
    );
  }

  if (error && !data) {
    return (
      <article className="job-card failed">
        <div className="job-header">
          <span className="job-title">Unknown job</span>
          <button type="button" className="btn-ghost" onClick={() => onDismiss(clipId)}>
            Dismiss
          </button>
        </div>
        <p className="job-error">{error.message}</p>
      </article>
    );
  }

  const clip = data as ClipResponse;
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
        {isTerminalStatus(clip.status) && (
          <button type="button" className="btn-ghost" onClick={() => onDismiss(clipId)}>
            Dismiss
          </button>
        )}
      </div>

      <div className="job-status-row">
        <span className={`status-badge status-${clip.status}`}>
          {statusLabel(clip.status)}
        </span>
        {!isTerminalStatus(clip.status) && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      {clip.status === "failed" && clip.errorMessage && (
        <p className="job-error">{clip.errorMessage}</p>
      )}

      {clip.status === "complete" && clip.outputs.mp4 && (
        <div className="job-output">
          <video
            src={clip.outputs.mp4}
            poster={clip.outputs.thumbnail ?? undefined}
            controls
            loop
            playsInline
            className="clip-preview"
          />
          <a href={clip.outputs.mp4} download className="btn-secondary">
            Download MP4
          </a>
        </div>
      )}
    </article>
  );
}

interface StatusPanelProps {
  jobIds: string[];
  onDismiss: (id: string) => void;
}

export function StatusPanel({ jobIds, onDismiss }: StatusPanelProps) {
  const handleDismiss = (id: string) => {
    removeJobId(id);
    onDismiss(id);
  };

  return (
    <section className="status-panel card">
      <div className="card-header">
        <h2>Jobs</h2>
        <p>
          {jobIds.length === 0
            ? "Created clips appear here with live status."
            : `${jobIds.length} clip${jobIds.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {jobIds.length === 0 ? (
        <div className="empty-state">No clips yet — create one to get started.</div>
      ) : (
        <div className="job-list">
          {jobIds.map((id) => (
            <JobCard key={id} clipId={id} onDismiss={handleDismiss} />
          ))}
        </div>
      )}
    </section>
  );
}
