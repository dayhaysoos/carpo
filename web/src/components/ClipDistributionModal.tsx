import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createClipExport,
  createClipShare,
  getClipDistribution,
  revokeClipShare,
} from "../api";
import type {
  ClipDistributionExport,
  ClipResponse,
  ClipShareSummary,
  ShareExpirationPreset,
} from "../types";
import { ModalDialog } from "./ModalDialog";

interface ClipDistributionModalProps {
  clip: ClipResponse;
  onClose: () => void;
}

const EXPIRATION_OPTIONS: Array<{
  value: ShareExpirationPreset;
  label: string;
}> = [
  { value: "day", label: "1 day" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
  { value: "never", label: "No expiration" },
];

function distributionQueryKey(clipId: string) {
  return ["clip-distribution", clipId] as const;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shareDescription(share: ClipShareSummary): string {
  if (share.status === "revoked") {
    return `Revoked ${share.revokedAt ? formatDate(share.revokedAt) : ""}`.trim();
  }
  if (share.status === "expired") return "Expired";
  return share.expiresAt ? `Expires ${formatDate(share.expiresAt)}` : "No expiration";
}

function ExportAction({
  item,
  pending,
  onCreate,
}: {
  item: ClipDistributionExport;
  pending: boolean;
  onCreate: () => void;
}) {
  if (item.status === "ready" && item.downloadUrl) {
    return (
      <a className="btn-secondary" href={item.downloadUrl} download>
        Download
      </a>
    );
  }
  if (item.status === "preparing" || pending) {
    return (
      <button className="btn-secondary" type="button" disabled>
        Preparing…
      </button>
    );
  }
  if (item.id === "looping-gif") {
    return (
      <button className="btn-secondary" type="button" onClick={onCreate}>
        {item.status === "failed" ? "Retry GIF" : "Create GIF"}
      </button>
    );
  }
  return <span className="distribution-unavailable">Not ready</span>;
}

export function ClipDistributionModal({
  clip,
  onClose,
}: ClipDistributionModalProps) {
  const queryClient = useQueryClient();
  const [expiration, setExpiration] =
    useState<ShareExpirationPreset>("week");
  const [newShareUrl, setNewShareUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const queryKey = distributionQueryKey(clip.id);
  const query = useQuery({
    queryKey,
    queryFn: () => getClipDistribution(clip.id),
    refetchInterval: (result) =>
      result.state.data?.exports.some((item) => item.status === "preparing")
        ? 1000
        : false,
  });
  const createShareMutation = useMutation({
    mutationFn: () => createClipShare(clip.id, expiration),
    onSuccess: (result) => {
      setNewShareUrl(result.url);
      setCopyStatus(null);
      queryClient.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? { ...current, shares: [result.share, ...current.shares] }
          : current,
      );
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (shareId: string) => revokeClipShare(clip.id, shareId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? {
              ...current,
              shares: current.shares.map((share) =>
                share.id === result.share.id ? result.share : share,
              ),
            }
          : current,
      );
    },
  });
  const exportMutation = useMutation({
    mutationFn: (preset: ClipDistributionExport["id"]) =>
      createClipExport(clip.id, preset),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? {
              ...current,
              exports: current.exports.map((item) =>
                item.id === result.export.id ? result.export : item,
              ),
            }
          : current,
      );
    },
  });

  const copyShareLink = async () => {
    if (!newShareUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(newShareUrl);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Select and copy the link manually.");
    }
  };

  const mutationError =
    createShareMutation.error ?? revokeMutation.error ?? exportMutation.error;

  return (
    <ModalDialog
      labelledBy="clip-distribution-title"
      className="clip-distribution-modal"
      onDismiss={onClose}
    >
      <div className="modal-header">
        <div>
          <p className="distribution-eyebrow">Share and export</p>
          <h2 id="clip-distribution-title">{clip.title}</h2>
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {query.isLoading && <p className="distribution-loading">Loading options…</p>}
      {query.error && <p className="form-error">{query.error.message}</p>}

      {query.data && (
        <div className="distribution-sections">
          <section aria-labelledby="clip-share-title">
            <div className="distribution-section-heading">
              <div>
                <h3 id="clip-share-title">Private share links</h3>
                <p>
                  Each link reveals only this finished clip. Revoke it whenever
                  you want.
                </p>
              </div>
            </div>
            <div className="distribution-share-create">
              <label>
                Expires
                <select
                  aria-label="Share expiration"
                  value={expiration}
                  onChange={(event) =>
                    setExpiration(event.target.value as ShareExpirationPreset)
                  }
                >
                  {EXPIRATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-primary"
                onClick={() => createShareMutation.mutate()}
                disabled={createShareMutation.isPending}
              >
                {createShareMutation.isPending ? "Creating…" : "Create share link"}
              </button>
            </div>

            {newShareUrl && (
              <div className="distribution-new-share" role="status">
                <p>
                  Copy this link now. Carpo stores only its secure hash, not the
                  secret needed to reconstruct it later.
                </p>
                <div>
                  <input
                    aria-label="New share link"
                    readOnly
                    value={newShareUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void copyShareLink()}
                  >
                    Copy link
                  </button>
                </div>
                {copyStatus && <span>{copyStatus}</span>}
              </div>
            )}

            {query.data.shares.length === 0 ? (
              <p className="distribution-empty">No share links yet.</p>
            ) : (
              <ul className="distribution-share-list">
                {query.data.shares.map((share) => (
                  <li key={share.id}>
                    <div>
                      <strong>{share.status === "active" ? "Active link" : `${share.status[0].toUpperCase()}${share.status.slice(1)} link`}</strong>
                      <span>
                        Created {formatDate(share.createdAt)} by {share.createdByEmail}
                      </span>
                      <span>{shareDescription(share)}</span>
                    </div>
                    {share.status === "active" && (
                      <button
                        type="button"
                        className="btn-ghost distribution-revoke"
                        onClick={() => revokeMutation.mutate(share.id)}
                        disabled={
                          revokeMutation.isPending &&
                          revokeMutation.variables === share.id
                        }
                      >
                        {revokeMutation.isPending &&
                        revokeMutation.variables === share.id
                          ? "Revoking…"
                          : "Revoke"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="clip-export-title">
            <div className="distribution-section-heading">
              <div>
                <h3 id="clip-export-title">Export presets</h3>
                <p>Download the original or an already reviewed derivative.</p>
              </div>
            </div>
            <ul className="distribution-export-list">
              {query.data.exports.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.description}</span>
                    {item.id === "captioned-mp4" &&
                      item.status === "unavailable" && (
                        <span>Render it from Captions first.</span>
                      )}
                    {item.errorMessage && <span>{item.errorMessage}</span>}
                  </div>
                  <ExportAction
                    item={item}
                    pending={
                      exportMutation.isPending &&
                      exportMutation.variables === item.id
                    }
                    onCreate={() => exportMutation.mutate(item.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {mutationError && (
        <p className="form-error" role="alert">
          {mutationError.message}
        </p>
      )}
    </ModalDialog>
  );
}
