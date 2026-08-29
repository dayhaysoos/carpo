import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  captionTrackVttUrl,
  getCaptionTrack,
  saveCaptionTrack,
} from "../api";
import type { CaptionCue, CaptionTrackAvailable, ClipResponse } from "../types";
import { ModalDialog } from "./ModalDialog";

interface CaptionEditorModalProps {
  clip: ClipResponse;
  onClose: () => void;
}

function formattedSeconds(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}

function nextCue(duration: number, cues: CaptionCue[]): CaptionCue {
  const previousEnd = cues.at(-1)?.endSeconds ?? 0;
  const startSeconds = Math.min(previousEnd, Math.max(0, duration - 0.5));
  const endSeconds = Math.min(duration, Math.max(startSeconds + 0.5, previousEnd + 2));
  return {
    id: `cue-${crypto.randomUUID()}`,
    startSeconds,
    endSeconds,
    text: "New caption",
  };
}

export function CaptionEditorModal({ clip, onClose }: CaptionEditorModalProps) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cues, setCues] = useState<CaptionCue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [manualTrack, setManualTrack] = useState<CaptionTrackAvailable | null>(
    null,
  );

  const trackQuery = useQuery({
    queryKey: ["caption-track", clip.id],
    queryFn: () => getCaptionTrack(clip.id),
    refetchInterval: (query) => {
      const result = query.state.data;
      return result?.captionStatus === "checking"
        ? result.retryAfterMs
        : false;
    },
  });
  const available: CaptionTrackAvailable | null =
    manualTrack ??
    (trackQuery.data?.captionStatus === "available" ? trackQuery.data : null);

  useEffect(() => {
    if (!available) return;
    setCues(available.cues);
    setDirty(false);
  }, [available?.clipId, available?.saved, available?.updatedAt]);

  const saveMutation = useMutation({
    mutationFn: () => saveCaptionTrack(clip.id, cues),
    onSuccess: (saved) => {
      queryClient.setQueryData(["caption-track", clip.id], saved);
      setManualTrack(null);
      setCues(saved.cues);
      setDirty(false);
    },
  });

  const startBlankTrack = () => {
    const blank: CaptionTrackAvailable = {
      captionStatus: "available",
      clipId: clip.id,
      clipDurationSeconds: clip.trimEnd - clip.trimStart,
      saved: false,
      sourceLanguage: null,
      sourceAutomatic: null,
      cues: [],
      updatedAt: null,
    };
    setManualTrack(blank);
    setCues([]);
    setDirty(false);
  };

  const activeCue = useMemo(
    () =>
      cues.find(
        (cue) =>
          currentTime >= cue.startSeconds && currentTime < cue.endSeconds,
      ) ?? null,
    [cues, currentTime],
  );

  const updateCue = (index: number, update: Partial<CaptionCue>) => {
    setCues((current) =>
      current.map((cue, cueIndex) =>
        cueIndex === index ? { ...cue, ...update } : cue,
      ),
    );
    setDirty(true);
  };

  const dismiss = () => {
    if (dirty && !window.confirm("Discard unsaved caption changes?")) return;
    onClose();
  };

  return (
    <ModalDialog
      labelledBy="caption-editor-title"
      className="caption-editor-modal"
      onDismiss={dismiss}
    >
      <div className="modal-header caption-editor-header">
        <div>
          <h2 id="caption-editor-title">Captions</h2>
          <p>{clip.title}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={dismiss}>
          Close
        </button>
      </div>

      {trackQuery.isLoading && (
        <div className="empty-state">Loading captions…</div>
      )}
      {trackQuery.error && (
        <div className="caption-manual-fallback">
          <p className="form-error" role="alert">
            {trackQuery.error.message}
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={startBlankTrack}
          >
            Start with a blank track
          </button>
        </div>
      )}
      {trackQuery.data?.captionStatus === "checking" && !manualTrack && (
        <div className="caption-manual-fallback" role="status">
          <p>
            Preparing the source transcript… This will update automatically.
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={startBlankTrack}
          >
            Start with a blank track
          </button>
        </div>
      )}

      {available && clip.outputs.mp4 && (
        <>
          <div className="caption-editor-layout">
            <div className="caption-preview-column">
              <div className="caption-preview-shell">
                <video
                  ref={videoRef}
                  src={clip.outputs.mp4}
                  poster={clip.outputs.thumbnail ?? undefined}
                  aria-label={`${clip.title} caption preview`}
                  controls
                  playsInline
                  onTimeUpdate={(event) =>
                    setCurrentTime(event.currentTarget.currentTime)
                  }
                />
                {activeCue && (
                  <div className="caption-preview-text" aria-live="polite">
                    {activeCue.text}
                  </div>
                )}
              </div>
              <p className="caption-track-origin">
                {available.sourceLanguage
                  ? `Drafted from the ${available.sourceLanguage} transcript. `
                  : "Manual caption track. "}
                Review every word and timing before export.
              </p>
              <div className="caption-editor-status" aria-live="polite">
                <span>
                  {dirty
                    ? "Unsaved changes"
                    : available.saved
                      ? "All changes saved"
                      : available.sourceLanguage
                        ? "Transcript draft — save your review"
                        : "Manual track — save your work"}
                </span>
                <span>{formattedSeconds(available.clipDurationSeconds)}s clip</span>
              </div>
            </div>

            <div className="caption-cue-column">
              <div className="caption-cue-heading">
                <div>
                  <h3>Timed cues</h3>
                  <p>Edit the text and clip-relative timing.</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setCues((current) => [
                      ...current,
                      nextCue(available.clipDurationSeconds, current),
                    ]);
                    setDirty(true);
                  }}
                >
                  Add cue
                </button>
              </div>

              {cues.length === 0 ? (
                <div className="caption-cue-empty">
                  No cues in this range. Add one to caption the clip manually.
                </div>
              ) : (
                <ol className="caption-cue-list">
                  {cues.map((cue, index) => (
                    <li key={cue.id} className="caption-cue-row">
                      <div className="caption-time-fields">
                        <label>
                          <span>Start</span>
                          <input
                            aria-label={`Cue ${index + 1} start`}
                            type="number"
                            min="0"
                            max={available.clipDurationSeconds}
                            step="0.1"
                            value={cue.startSeconds}
                            onChange={(event) =>
                              updateCue(index, {
                                startSeconds: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          <span>End</span>
                          <input
                            aria-label={`Cue ${index + 1} end`}
                            type="number"
                            min="0"
                            max={available.clipDurationSeconds}
                            step="0.1"
                            value={cue.endSeconds}
                            onChange={(event) =>
                              updateCue(index, {
                                endSeconds: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                      <label className="caption-cue-text-field">
                        <span>Caption {index + 1}</span>
                        <textarea
                          aria-label={`Cue ${index + 1} text`}
                          rows={2}
                          maxLength={500}
                          value={cue.text}
                          onChange={(event) =>
                            updateCue(index, { text: event.target.value })
                          }
                        />
                      </label>
                      <div className="caption-cue-actions">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.currentTime = cue.startSeconds;
                              setCurrentTime(cue.startSeconds);
                            }
                          }}
                        >
                          Go to start
                        </button>
                        <button
                          type="button"
                          className="btn-ghost caption-cue-remove"
                          onClick={() => {
                            setCues((current) =>
                              current.filter((_, cueIndex) => cueIndex !== index),
                            );
                            setDirty(true);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          {saveMutation.error && (
            <p className="form-error" role="alert">
              {saveMutation.error.message}
            </p>
          )}
          <div className="caption-editor-footer">
            {available.saved && !dirty ? (
              <a
                href={captionTrackVttUrl(clip.id)}
                download
                className="btn-secondary"
              >
                Download VTT
              </a>
            ) : (
              <button type="button" className="btn-secondary" disabled>
                Download VTT
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={!dirty || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Saving…" : "Save captions"}
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}
