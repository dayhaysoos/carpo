import type { ClipQuality } from "../types";
import { formatTimestamp } from "../youtube";

export interface ManualClipInput {
  title: string;
  startSeconds: number;
  endSeconds: number;
  caption?: string;
  quality?: ClipQuality;
}

interface ClipApprovalCardProps {
  approvalId: string;
  input: ManualClipInput;
  onDecision: (approvalId: string, approved: boolean) => void;
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${rounded.toLocaleString()} ${rounded === 1 ? "second" : "seconds"}`;
}

export function ClipApprovalCard({
  approvalId,
  input,
  onDecision,
}: ClipApprovalCardProps) {
  const duration = Math.max(0, input.endSeconds - input.startSeconds);

  return (
    <section className="agent-approval-card" aria-label="Clip preview">
      <div className="agent-approval-status">Ready for your approval</div>
      <h3>{input.title}</h3>
      <div className="agent-approval-time">
        {formatTimestamp(input.startSeconds)}–{formatTimestamp(input.endSeconds)}
      </div>
      <div className="agent-approval-meta">
        <span>{formatDuration(duration)}</span>
        <span>{input.quality ?? "1080p"}</span>
      </div>
      {input.caption ? (
        <div className="agent-approval-caption">
          <span>Caption</span>
          <p>{input.caption}</p>
        </div>
      ) : null}
      <div className="agent-approval-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => onDecision(approvalId, true)}
        >
          Create clip
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => onDecision(approvalId, false)}
        >
          Reject
        </button>
      </div>
    </section>
  );
}
