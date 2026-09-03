import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  captionTrackSrtUrl,
  captionTrackVttUrl,
  getCaptionTrack,
  renderCaptionTrack,
  saveCaptionTrack,
} from "../api";
import type {
  CaptionCue,
  CaptionProposalSource,
  CaptionThemeId,
  CaptionTrackAvailable,
  CaptionTrackProposal,
  ClipResponse,
} from "../types";
import { ModalDialog } from "./ModalDialog";

interface CaptionEditorModalProps {
  clip: ClipResponse;
  onClose: () => void;
  initialProposal?: CaptionTrackProposal | null;
}

interface CaptionDraft {
  cues: CaptionCue[];
  theme: CaptionThemeId;
  source: CaptionProposalSource | null;
  dirty: boolean;
}

type CaptionDraftAction =
  | { type: "add-cue"; cue: CaptionCue }
  | { type: "remove-cue"; index: number }
  | { type: "update-cue"; index: number; update: Partial<CaptionCue> }
  | { type: "select-theme"; theme: CaptionThemeId }
  | { type: "refreshed"; track: CaptionTrackAvailable }
  | { type: "saved"; track: CaptionTrackAvailable };

const CAPTION_THEME_OPTIONS: Array<{ value: CaptionThemeId; label: string }> = [
  { value: "classic", label: "Classic" },
  { value: "high-contrast-box", label: "High-contrast box" },
  { value: "bold-yellow", label: "Bold yellow" },
];

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

function createDraft(
  track: CaptionTrackAvailable,
  proposal: CaptionTrackProposal | null,
): CaptionDraft {
  if (proposal) {
    return {
      cues: proposal.cues,
      theme: proposal.theme,
      source: proposal.source,
      dirty: true,
    };
  }
  return {
    cues: track.cues,
    theme: track.theme,
    source: null,
    dirty: false,
  };
}

function captionDraftReducer(
  state: CaptionDraft,
  action: CaptionDraftAction,
): CaptionDraft {
  switch (action.type) {
    case "add-cue":
      return { ...state, cues: [...state.cues, action.cue], dirty: true };
    case "remove-cue":
      return {
        ...state,
        cues: state.cues.filter((_, index) => index !== action.index),
        dirty: true,
      };
    case "update-cue":
      return {
        ...state,
        cues: state.cues.map((cue, index) =>
          index === action.index ? { ...cue, ...action.update } : cue,
        ),
        dirty: true,
      };
    case "select-theme":
      return { ...state, theme: action.theme, dirty: true };
    case "refreshed":
      return state.dirty ? state : createDraft(action.track, null);
    case "saved":
      return createDraft(action.track, null);
  }
}

function CaptionEditorFrame({
  clip,
  onDismiss,
  children,
}: {
  clip: ClipResponse;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <ModalDialog
      labelledBy="caption-editor-title"
      className="caption-editor-modal"
      onDismiss={onDismiss}
    >
      <div className="modal-header caption-editor-header">
        <div>
          <h2 id="caption-editor-title">Captions</h2>
          <p>{clip.title}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={onDismiss}>
          Close
        </button>
      </div>
      {children}
    </ModalDialog>
  );
}

function CaptionPreview({
  clip,
  track,
  draft,
  currentTime,
  videoRef,
  onTimeUpdate,
  onThemeChange,
}: {
  clip: ClipResponse;
  track: CaptionTrackAvailable;
  draft: CaptionDraft;
  currentTime: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTimeUpdate: (time: number) => void;
  onThemeChange: (theme: CaptionThemeId) => void;
}) {
  const activeCue = useMemo(
    () =>
      draft.cues.find(
        (cue) =>
          currentTime >= cue.startSeconds && currentTime < cue.endSeconds,
      ) ?? null,
    [currentTime, draft.cues],
  );

  return (
    <div className="caption-preview-column">
      <div className="caption-preview-shell">
        <video
          ref={videoRef}
          src={clip.outputs.mp4 ?? undefined}
          poster={clip.outputs.thumbnail ?? undefined}
          aria-label={`${clip.title} caption preview`}
          controls
          playsInline
          onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
        />
        {activeCue && (
          <div
            className={`caption-preview-text caption-theme-${draft.theme}`}
            aria-live="polite"
          >
            {activeCue.text}
          </div>
        )}
      </div>
      {draft.source && (
        <div className="caption-proposal-notice" role="status">
          <strong>
            {draft.source === "think" ? "Think" : "WebMCP"} suggestion
          </strong>
          <span>
            Unsaved and unrendered. Review every cue, then save it yourself.
          </span>
        </div>
      )}
      <p className="caption-track-origin">
        {track.sourceLanguage
          ? `Drafted from the ${track.sourceLanguage} transcript. `
          : "Manual caption track. "}
        Review every word and timing before export.
      </p>
      <div className="caption-editor-status" aria-live="polite">
        <span>
          {draft.dirty
            ? "Unsaved changes"
            : track.saved
              ? "All changes saved"
              : track.sourceLanguage
                ? "Transcript draft — save your review"
                : "Manual track — save your work"}
        </span>
        <span>{formattedSeconds(track.clipDurationSeconds)}s clip</span>
      </div>
      <label className="caption-theme-field">
        <span>Caption theme</span>
        <select
          value={draft.theme}
          onChange={(event) =>
            onThemeChange(event.currentTarget.value as CaptionThemeId)
          }
        >
          {CAPTION_THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function CaptionCueEditor({
  cues,
  duration,
  videoRef,
  onAdd,
  onRemove,
  onUpdate,
  onSeek,
}: {
  cues: CaptionCue[];
  duration: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, update: Partial<CaptionCue>) => void;
  onSeek: (time: number) => void;
}) {
  const updateTime = (
    index: number,
    field: "startSeconds" | "endSeconds",
    value: number,
  ) => {
    if (Number.isFinite(value)) onUpdate(index, { [field]: value });
  };

  return (
    <div className="caption-cue-column">
      <div className="caption-cue-heading">
        <div>
          <h3>Timed cues</h3>
          <p>Edit the text and clip-relative timing.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onAdd}>
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
                    max={duration}
                    step="0.1"
                    value={cue.startSeconds}
                    onChange={(event) =>
                      updateTime(
                        index,
                        "startSeconds",
                        event.currentTarget.valueAsNumber,
                      )
                    }
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    aria-label={`Cue ${index + 1} end`}
                    type="number"
                    min="0"
                    max={duration}
                    step="0.1"
                    value={cue.endSeconds}
                    onChange={(event) =>
                      updateTime(
                        index,
                        "endSeconds",
                        event.currentTarget.valueAsNumber,
                      )
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
                    onUpdate(index, { text: event.currentTarget.value })
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
                    }
                    onSeek(cue.startSeconds);
                  }}
                >
                  Go to start
                </button>
                <button
                  type="button"
                  className="btn-ghost caption-cue-remove"
                  onClick={() => onRemove(index)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CaptionEditorFooter({
  clipId,
  track,
  draft,
  isSaving,
  isRendering,
  onSave,
  onRender,
}: {
  clipId: string;
  track: CaptionTrackAvailable;
  draft: CaptionDraft;
  isSaving: boolean;
  isRendering: boolean;
  onSave: () => void;
  onRender: () => void;
}) {
  const rendering = track.renderStatus === "encoding" || isRendering;
  return (
    <div className="caption-editor-footer">
      <div className="caption-export-actions">
        {track.saved && !draft.dirty ? (
          <>
            <a href={captionTrackVttUrl(clipId)} download className="btn-secondary">
              Download VTT
            </a>
            <a href={captionTrackSrtUrl(clipId)} download className="btn-secondary">
              Download SRT
            </a>
          </>
        ) : (
          <button type="button" className="btn-secondary" disabled>
            Save to export
          </button>
        )}
        {track.outputCaptionedMp4 && !draft.dirty && (
          <a href={track.outputCaptionedMp4} download className="btn-secondary">
            Download captioned MP4
          </a>
        )}
      </div>
      <div className="caption-save-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={
            draft.dirty ||
            !track.saved ||
            rendering ||
            track.renderStatus === "complete"
          }
          onClick={onRender}
        >
          {rendering
            ? "Rendering…"
            : track.renderStatus === "complete"
              ? "Rendered"
              : "Render captioned MP4"}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!draft.dirty || isSaving}
          onClick={onSave}
        >
          {isSaving ? "Saving…" : "Save captions"}
        </button>
      </div>
    </div>
  );
}

function CaptionEditorWorkspace({
  clip,
  track,
  initialProposal,
  onClose,
  onTrackSaved,
}: {
  clip: ClipResponse;
  track: CaptionTrackAvailable;
  initialProposal: CaptionTrackProposal | null;
  onClose: () => void;
  onTrackSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [draft, dispatch] = useReducer(
    captionDraftReducer,
    createDraft(track, initialProposal),
  );
  useEffect(() => {
    dispatch({ type: "refreshed", track });
  }, [track]);
  const dismiss = () => {
    if (draft.dirty && !window.confirm("Discard unsaved caption changes?")) return;
    onClose();
  };
  const saveMutation = useMutation({
    mutationFn: () =>
      saveCaptionTrack(clip.id, draft.cues, {
        theme: draft.theme,
        ...(draft.source ? { proposalSource: draft.source } : {}),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["caption-track", clip.id], saved);
      dispatch({ type: "saved", track: saved });
      onTrackSaved();
    },
  });
  const renderMutation = useMutation({
    mutationFn: () => renderCaptionTrack(clip.id),
    onSuccess: (renderingTrack) => {
      queryClient.setQueryData(["caption-track", clip.id], renderingTrack);
    },
  });

  return (
    <CaptionEditorFrame clip={clip} onDismiss={dismiss}>
      <div className="caption-editor-layout">
        <CaptionPreview
          clip={clip}
          track={track}
          draft={draft}
          currentTime={currentTime}
          videoRef={videoRef}
          onTimeUpdate={setCurrentTime}
          onThemeChange={(theme) => dispatch({ type: "select-theme", theme })}
        />
        <CaptionCueEditor
          cues={draft.cues}
          duration={track.clipDurationSeconds}
          videoRef={videoRef}
          onAdd={() =>
            dispatch({
              type: "add-cue",
              cue: nextCue(track.clipDurationSeconds, draft.cues),
            })
          }
          onRemove={(index) => dispatch({ type: "remove-cue", index })}
          onUpdate={(index, update) =>
            dispatch({ type: "update-cue", index, update })
          }
          onSeek={setCurrentTime}
        />
      </div>
      {saveMutation.error && (
        <p className="form-error" role="alert">
          {saveMutation.error.message}
        </p>
      )}
      {renderMutation.error && (
        <p className="form-error" role="alert">
          {renderMutation.error.message}
        </p>
      )}
      {track.renderErrorMessage && (
        <p className="form-error" role="alert">
          {track.renderErrorMessage}
        </p>
      )}
      <CaptionEditorFooter
        clipId={clip.id}
        track={track}
        draft={draft}
        isSaving={saveMutation.isPending}
        isRendering={renderMutation.isPending}
        onSave={() => saveMutation.mutate()}
        onRender={() => renderMutation.mutate()}
      />
    </CaptionEditorFrame>
  );
}

function blankTrack(clip: ClipResponse): CaptionTrackAvailable {
  return {
    captionStatus: "available",
    clipId: clip.id,
    clipDurationSeconds: clip.trimEnd - clip.trimStart,
    saved: false,
    sourceLanguage: null,
    sourceAutomatic: null,
    cues: [],
    theme: "classic",
    lastProposalSource: null,
    renderStatus: "none",
    renderErrorMessage: null,
    outputCaptionedMp4: null,
    revision: null,
    updatedAt: null,
  };
}

export function CaptionEditorModal({
  clip,
  onClose,
  initialProposal = null,
}: CaptionEditorModalProps) {
  const [manualTrack, setManualTrack] = useState<CaptionTrackAvailable | null>(null);
  const trackQuery = useQuery({
    queryKey: ["caption-track", clip.id],
    queryFn: () => getCaptionTrack(clip.id),
    refetchInterval: (query) => {
      const result = query.state.data;
      if (result?.captionStatus === "checking") return result.retryAfterMs;
      return result?.captionStatus === "available" && result.renderStatus === "encoding"
        ? 1000
        : false;
    },
  });
  const available =
    manualTrack ??
    (trackQuery.data?.captionStatus === "available" ? trackQuery.data : null);

  if (available && clip.outputs.mp4) {
    // Saving changes the server revision, not the identity of the editable draft.
    const proposalKey = initialProposal ? JSON.stringify(initialProposal) : "saved";
    return (
      <CaptionEditorWorkspace
        key={`${available.clipId}:${proposalKey}`}
        clip={clip}
        track={available}
        initialProposal={initialProposal}
        onClose={onClose}
        onTrackSaved={() => setManualTrack(null)}
      />
    );
  }

  return (
    <CaptionEditorFrame clip={clip} onDismiss={onClose}>
      {trackQuery.isLoading && <div className="empty-state">Loading captions…</div>}
      {trackQuery.error && (
        <div className="caption-manual-fallback">
          <p className="form-error" role="alert">
            {trackQuery.error.message}
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setManualTrack(blankTrack(clip))}
          >
            {initialProposal ? "Review proposed captions" : "Start with a blank track"}
          </button>
        </div>
      )}
      {trackQuery.data?.captionStatus === "checking" && (
        <div className="caption-manual-fallback" role="status">
          <p>Preparing the source transcript… This will update automatically.</p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setManualTrack(blankTrack(clip))}
          >
            {initialProposal ? "Review proposed captions" : "Start with a blank track"}
          </button>
        </div>
      )}
    </CaptionEditorFrame>
  );
}
