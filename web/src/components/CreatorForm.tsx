import { useMutation } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createClip, createClipFromSourceVideo } from "../api";
import type { ActiveVideoLifecycle } from "../active-video-lifecycle";
import { useNativeVideoPlayer } from "../hooks/useNativeVideoPlayer";
import { useTrimRange } from "../hooks/useTrimRange";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import {
  MAX_CAPTION_LENGTH,
  type ClipResponse,
  type ClipQuality,
  type CreateClipRequest,
  DEFAULT_CLIP_QUALITY,
} from "../types";
import {
  deriveUploadClipTitle,
  type OwnedUploadClipJourneyView,
} from "../owned-upload-clip-journey";
import type { ClipWindowRequest } from "../timestamp-windows";
import { toExistingClipRanges } from "../timeline";
import { formatTimestamp } from "../youtube";
import { YOUTUBE_SOURCE_ENABLED } from "../source-options";
import { carpoIdentityTokens } from "../styles/carpoIdentityTokens.stylex";
import {
  CreatorWorkspaceClipPreview,
  CreatorWorkspaceClipReel,
  getCreatorWorkspaceClipItems,
} from "./CreatorWorkspaceClipReel";
import { TranscriptPanel } from "./TranscriptPanel";
import { TrimSlider } from "./TrimSlider";
import { RemoteSourceFailureHint } from "./RemoteSourceFailureHint";

interface CreatorFormProps {
  activeVideoLifecycle: ActiveVideoLifecycle;
  onClipCreated: (clip: ClipResponse) => void;
  clipWindowRequest?: ClipWindowRequest | null;
  ownedUploadJourney: OwnedUploadClipJourneyView;
}

interface CreatorFormState {
  clipCreatedNotice: boolean;
  title: string;
  caption: string;
  quality: ClipQuality;
  urlTouched: boolean;
}

type CreatorFormAction =
  | { type: "update"; patch: Partial<CreatorFormState> }
  | { type: "source-ui-reset" }
  | { type: "seed-upload-title"; title: string }
  | { type: "clip-created" }
  | { type: "hide-clip-created-notice" };

const INITIAL_CREATOR_FORM_STATE: CreatorFormState = {
  clipCreatedNotice: false,
  title: "",
  caption: "",
  quality: DEFAULT_CLIP_QUALITY,
  urlTouched: false,
};

function creatorFormReducer(
  state: CreatorFormState,
  action: CreatorFormAction,
): CreatorFormState {
  switch (action.type) {
    case "update":
      return { ...state, ...action.patch };
    case "source-ui-reset":
      return { ...state, urlTouched: false };
    case "seed-upload-title":
      return state.title.trim().length === 0
        ? { ...state, title: deriveUploadClipTitle(action.title) }
        : state;
    case "clip-created":
      return {
        ...state,
        clipCreatedNotice: true,
      };
    case "hide-clip-created-notice":
      return { ...state, clipCreatedNotice: false };
  }
}

export function CreatorForm({
  activeVideoLifecycle,
  onClipCreated,
  clipWindowRequest,
  ownedUploadJourney,
}: CreatorFormProps) {
  const { perform } = activeVideoLifecycle;
  const { active, manualSource, preview, readyForClip, refreshIssue } =
    activeVideoLifecycle.view;
  const reusableVideoId = active.id ?? "";
  const reusableVideo = active.status === "ready" ? active.video : null;
  const reusableVideoClips = active.status === "ready" ? active.clips : [];
  const [form, dispatch] = useReducer(
    creatorFormReducer,
    INITIAL_CREATOR_FORM_STATE,
  );
  const { clipCreatedNotice, title, caption, quality, urlTouched } = form;
  const sourceMode = manualSource.mode;
  const url = manualSource.youtubeUrl;
  const selectedUpload = manualSource.upload;
  const uploadError =
    manualSource.issue?.area === "upload" ? manualSource.issue.message : null;
  const sourceActivationError =
    manualSource.issue?.area === "activation" ||
    manualSource.issue?.area === "ingestion-retry"
      ? manualSource.issue.message
      : null;
  const uploadProgress = manualSource.progress;
  const appliedClipWindowRequest = useRef<number | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const previousActiveVideoId = useRef(reusableVideoId);
  const selectedClipTrigger = useRef<HTMLButtonElement | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const existingClips = useMemo(
    () => toExistingClipRanges(reusableVideoClips),
    [reusableVideoClips],
  );

  const trimmedUrl = url.trim();
  const urlValid = manualSource.youtubeValidity === "valid";
  const urlInvalid = urlTouched && trimmedUrl.length > 0 && !urlValid;
  const youtube = useYoutubePlayer(
    preview.type === "youtube" ? preview.videoId : null,
  );

  useEffect(() => {
    void perform({
      type: "youtube-metadata-observed",
      title: youtube.title,
      durationSeconds: youtube.duration,
    });
  }, [perform, youtube.duration, youtube.title]);

  const native = useNativeVideoPlayer(
    preview.type === "native" ? preview.url : null,
  );

  const ready =
    preview.type === "youtube"
      ? youtube.ready
      : preview.type === "native"
        ? native.ready
        : false;
  const duration =
    preview.type === "youtube" ? youtube.duration : native.duration;
  const currentTime =
    preview.type === "youtube" ? youtube.currentTime : native.currentTime;
  const seekTo = preview.type === "youtube" ? youtube.seekTo : native.seekTo;
  const trim = useTrimRange({ duration, onSeek: seekTo });
  const durationMatchesActiveSource =
    preview.type === "youtube" ||
    (preview.type === "native" && native.mediaStateSourceUrl === preview.url);

  useEffect(() => {
    if (
      !reusableVideoId ||
      !ready ||
      duration <= 0 ||
      !durationMatchesActiveSource
    ) {
      return;
    }
    void perform({
      type: "active-duration-observed",
      videoId: reusableVideoId,
      durationSeconds: duration,
    });
  }, [duration, durationMatchesActiveSource, perform, ready, reusableVideoId]);

  useEffect(() => {
    if (reusableVideo?.source.type !== "upload") return;
    dispatch({ type: "seed-upload-title", title: reusableVideo.title });
  }, [reusableVideo]);

  useEffect(() => {
    const previousVideoId = previousActiveVideoId.current;
    previousActiveVideoId.current = reusableVideoId;
    if (previousVideoId && !reusableVideoId) {
      dispatch({ type: "source-ui-reset" });
    }
  }, [reusableVideoId]);

  useEffect(() => {
    if (
      !ready ||
      !clipWindowRequest ||
      appliedClipWindowRequest.current === clipWindowRequest.requestId
    ) {
      return;
    }
    trim.setClipWindow(
      clipWindowRequest.startSeconds,
      clipWindowRequest.endSeconds,
    );
    appliedClipWindowRequest.current = clipWindowRequest.requestId;
  }, [clipWindowRequest, ready, trim.setClipWindow]);

  const clipDuration = trim.range.end - trim.range.start;
  const remoteSourceReadyForClip = readyForClip;
  const canCreate =
    ready &&
    remoteSourceReadyForClip &&
    title.trim().length > 0 &&
    Number.isFinite(trim.range.start) &&
    Number.isFinite(trim.range.end) &&
    trim.range.start >= 0 &&
    clipDuration > 0 &&
    duration > 0 &&
    trim.range.end <= duration &&
    Boolean(reusableVideo || manualSource.preparedSource);
  const clipItems = useMemo(
    () =>
      getCreatorWorkspaceClipItems(
        reusableVideoClips,
        ownedUploadJourney,
        reusableVideo?.thumbnail ?? null,
      ),
    [ownedUploadJourney, reusableVideo?.thumbnail, reusableVideoClips],
  );
  const selectedClip =
    clipItems.find((item) => item.id === selectedClipId) ?? null;

  useEffect(() => {
    if (selectedClipId && !selectedClip) {
      setSelectedClipId(null);
    }
  }, [selectedClip, selectedClipId]);

  useEffect(() => {
    if (!selectedClipId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSelectedClipId(null);
      requestAnimationFrame(() => selectedClipTrigger.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedClipId]);

  const mutation = useMutation({
    mutationFn: (request: CreateClipRequest) => {
      if (reusableVideoId && reusableVideo) {
        const {
          source: _source,
          sourceTitle: _sourceTitle,
          ...clipRequest
        } = request;
        return createClipFromSourceVideo(reusableVideoId, clipRequest);
      }
      return createClip(request);
    },
    onSuccess: (clip) => {
      onClipCreated(clip);
      dispatch({ type: "clip-created" });
    },
  });

  useEffect(() => {
    if (!clipCreatedNotice) {
      return;
    }
    const timeout = setTimeout(
      () => dispatch({ type: "hide-clip-created-notice" }),
      5000,
    );
    return () => clearTimeout(timeout);
  }, [clipCreatedNotice]);

  const handleSourceModeChange = (mode: "youtube" | "upload") => {
    if (mode !== sourceMode && uploadInput.current) {
      uploadInput.current.value = "";
    }
    dispatch({ type: "source-ui-reset" });
    void perform({ type: "source-mode-changed", mode });
  };

  const handleFileChange = (file: File | null) => {
    if (file) {
      dispatch({
        type: "update",
        patch: { title: deriveUploadClipTitle(file.name) },
      });
    }
    void perform({ type: "upload-selected", file });
  };

  const handleUseOwnFile = async () => {
    await perform({ type: "clear" });
    await perform({ type: "source-mode-changed", mode: "upload" });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;

    const preparedSource = reusableVideo?.source ?? manualSource.preparedSource;
    if (sourceMode === "youtube" && preparedSource?.type === "youtube") {
      mutation.mutate({
        title: title.trim(),
        sourceTitle: reusableVideo?.title || youtube.title || undefined,
        source: preparedSource,
        trimStart: trim.range.start,
        trimEnd: trim.range.end,
        filters:
          caption.trim().length > 0
            ? [{ type: "caption", text: caption.trim() }]
            : [],
        quality,
      });
      return;
    }

    if (sourceMode === "upload" && preparedSource?.type === "upload") {
      mutation.mutate({
        title: title.trim(),
        sourceTitle:
          reusableVideo?.title ||
          (selectedUpload
            ? deriveUploadClipTitle(selectedUpload.fileName)
            : undefined),
        source: preparedSource,
        trimStart: trim.range.start,
        trimEnd: trim.range.end,
        filters:
          caption.trim().length > 0
            ? [{ type: "caption", text: caption.trim() }]
            : [],
        quality,
      });
    }
  };

  const builderPanel = (
    <aside aria-label="Clip builder" {...stylex.props(styles.builder)}>
      <h1 {...stylex.props(styles.builderTitle)}>New clip</h1>

      {!reusableVideoId && YOUTUBE_SOURCE_ENABLED ? (
        <div
          role="tablist"
          aria-label="Source type"
          {...stylex.props(styles.sourceTabs)}
        >
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === "youtube"}
            onClick={() => handleSourceModeChange("youtube")}
            {...stylex.props(
              styles.sourceTab,
              sourceMode === "youtube" && styles.sourceTabActive,
            )}
          >
            YouTube URL
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === "upload"}
            onClick={() => handleSourceModeChange("upload")}
            {...stylex.props(
              styles.sourceTab,
              sourceMode === "upload" && styles.sourceTabActive,
            )}
          >
            Upload file
          </button>
        </div>
      ) : null}

      {!reusableVideoId && YOUTUBE_SOURCE_ENABLED && sourceMode === "youtube" ? (
        <label {...stylex.props(styles.field)}>
          <span {...stylex.props(styles.fieldLabel)}>YouTube URL</span>
          <input
            type="url"
            placeholder="https://youtube.com/watch?v=…"
            value={url}
            onChange={(event) =>
              void perform({
                type: "youtube-url-changed",
                value: event.target.value,
              })
            }
            onBlur={() =>
              dispatch({ type: "update", patch: { urlTouched: true } })
            }
            autoComplete="off"
            spellCheck={false}
            {...stylex.props(styles.input)}
          />
          {urlInvalid ? (
            <span {...stylex.props(styles.fieldError)}>
              Enter a valid YouTube URL.
            </span>
          ) : null}
          {urlValid ? (
            <span {...stylex.props(styles.fieldOk)}>Valid YouTube URL</span>
          ) : null}
        </label>
      ) : null}

      {!reusableVideoId ? (
        <>
          <label
            hidden={sourceMode !== "upload"}
            {...stylex.props(
              styles.field,
              sourceMode !== "upload" && styles.hiddenField,
            )}
          >
            <span {...stylex.props(styles.fieldLabel)}>Video file</span>
            <input
              ref={uploadInput}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
              onChange={(event) =>
                handleFileChange(event.target.files?.[0] ?? null)
              }
              {...stylex.props(styles.fileInput)}
            />
            {selectedUpload && !uploadError ? (
              <span {...stylex.props(styles.fieldOk)}>
                {selectedUpload.fileName} (
                {Math.round(selectedUpload.sizeBytes / 1024)} KB)
              </span>
            ) : null}
            {uploadError ? (
              <span {...stylex.props(styles.fieldError)}>{uploadError}</span>
            ) : null}
            {uploadProgress ? (
              <span {...stylex.props(styles.fieldHint)}>{uploadProgress}</span>
            ) : null}
          </label>
          {sourceMode === "upload" &&
          uploadError &&
          selectedUpload &&
          manualSource.issue?.retryable ? (
            <button
              type="button"
              onClick={() => void perform({ type: "retry-upload" })}
              {...stylex.props(styles.secondaryButton)}
            >
              Retry upload
            </button>
          ) : null}
        </>
      ) : null}

      <label {...stylex.props(styles.field)}>
        <span {...stylex.props(styles.fieldLabel)}>Title</span>
        <input
          type="text"
          placeholder="Name this clip"
          value={title}
          onChange={(event) =>
            dispatch({ type: "update", patch: { title: event.target.value } })
          }
          maxLength={200}
          {...stylex.props(styles.input)}
        />
      </label>

      <label {...stylex.props(styles.field)}>
        {/* prettier-ignore */}
        <span {...stylex.props(styles.fieldLabel)}>Overlay text (optional)</span>
        <input
          type="text"
          placeholder="Show static text throughout"
          value={caption}
          onChange={(event) =>
            dispatch({ type: "update", patch: { caption: event.target.value } })
          }
          maxLength={MAX_CAPTION_LENGTH}
          {...stylex.props(styles.input)}
        />
      </label>

      <div
        role="group"
        aria-label="Output quality"
        {...stylex.props(styles.field)}
      >
        <span {...stylex.props(styles.fieldLabel)}>Quality</span>
        <div {...stylex.props(styles.qualityOptions)}>
          {(["1080p", "720p"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={quality === option}
              onClick={() =>
                dispatch({ type: "update", patch: { quality: option } })
              }
              {...stylex.props(
                styles.qualityButton,
                quality === option && styles.qualityButtonActive,
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {mutation.error ? (
        <div role="alert" {...stylex.props(styles.inlineError)}>
          {mutation.error.message}
        </div>
      ) : null}
      {sourceActivationError ? (
        <div role="alert" {...stylex.props(styles.inlineError)}>
          {sourceActivationError}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={!canCreate || mutation.isPending}
        {...stylex.props(styles.createButton)}
      >
        {mutation.isPending ? "Creating…" : "Create clip"}
      </button>
      {clipCreatedNotice ? (
        <span className="sr-only" role="status">
          Clip queued.
        </span>
      ) : null}
    </aside>
  );

  const stagePanel = (
    <section aria-label="Moment workspace" {...stylex.props(styles.stage)}>
      <div {...stylex.props(styles.stageHeading)}>
        <div>
          <h2 {...stylex.props(styles.stageTitle)}>Mark a moment</h2>
          <p {...stylex.props(styles.stageInstructions)}>
            Drag the handles or select words below.
          </p>
        </div>
        {ready ? (
          <span {...stylex.props(styles.stageTime)}>
            {formatTimestamp(Math.max(0, clipDuration))} selected
          </span>
        ) : null}
      </div>

      {active.status === "loading" ? (
        <div role="status" {...stylex.props(styles.sourceStatus)}>
          Loading video…
        </div>
      ) : null}
      {active.status === "failed" ? (
        <div
          role="alert"
          {...stylex.props(styles.sourceStatus, styles.sourceStatusFailed)}
        >
          {active.issue.message}
        </div>
      ) : null}
      {active.status === "ready" && refreshIssue ? (
        <div
          role="alert"
          {...stylex.props(styles.sourceStatus, styles.sourceStatusFailed)}
        >
          {refreshIssue.message}
        </div>
      ) : null}

      {reusableVideo?.remoteIngestion &&
      reusableVideo.remoteIngestion.status !== "ready" ? (
        <div
          role={
            reusableVideo.remoteIngestion.status === "failed"
              ? "alert"
              : "status"
          }
          {...stylex.props(
            styles.sourceStatus,
            reusableVideo.remoteIngestion.status === "failed" &&
              styles.sourceStatusFailed,
          )}
        >
          {reusableVideo.remoteIngestion.failure ? (
            <>
              <strong>Import blocked</strong>
              <p>{reusableVideo.remoteIngestion.failure.message}</p>
              <RemoteSourceFailureHint
                failure={reusableVideo.remoteIngestion.failure}
              />
              <div {...stylex.props(styles.recoveryActions)}>
                {reusableVideo.remoteIngestion.failure.retryable ? (
                  <button
                    type="button"
                    disabled={manualSource.phase === "activating"}
                    onClick={() => void perform({ type: "retry-ingestion" })}
                    {...stylex.props(styles.dangerButton)}
                  >
                    {manualSource.phase === "activating"
                      ? "Retrying…"
                      : "Retry import"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleUseOwnFile()}
                  {...stylex.props(styles.secondaryButton)}
                >
                  Upload your file
                </button>
              </div>
            </>
          ) : (
            <strong>Importing source</strong>
          )}
        </div>
      ) : null}

      {preview.type === "youtube" ? (
        <div {...stylex.props(styles.playerSection)}>
          <div {...stylex.props(styles.playerFrame)}>
            <div id={youtube.containerId} className="player-embed" />
            {!youtube.ready ? (
              <div className="player-loading">Loading player…</div>
            ) : null}
          </div>
          <div {...stylex.props(styles.timelineSurface)}>
            <TrimSlider
              duration={duration}
              ready={ready}
              trim={trim}
              existingClips={existingClips}
            />
          </div>
        </div>
      ) : preview.type === "native" ? (
        <div {...stylex.props(styles.playerSection)}>
          <div {...stylex.props(styles.playerFrame)}>
            <video
              ref={native.videoRef}
              className="native-player"
              controls
              playsInline
              preload="metadata"
            />
            {!ready ? (
              <div className="player-loading">
                {native.error
                  ? "Original uploaded video is unavailable"
                  : "Loading preview…"}
              </div>
            ) : null}
          </div>
          <div {...stylex.props(styles.timelineSurface)}>
            <TrimSlider
              duration={duration}
              ready={ready}
              trim={trim}
              existingClips={existingClips}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={
            Boolean(reusableVideoId) ||
            manualSource.phase === "uploading" ||
            manualSource.phase === "activating"
          }
          onClick={() => {
            if (sourceMode !== "upload") handleSourceModeChange("upload");
            uploadInput.current?.click();
          }}
          {...stylex.props(styles.emptyStage)}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            {...stylex.props(styles.emptyStageIcon)}
          >
            <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
          </svg>
          <span>Upload a video</span>
        </button>
      )}

      {reusableVideoId ? (
        <div {...stylex.props(styles.transcriptSurface)}>
          <TranscriptPanel
            videoId={reusableVideoId}
            currentTime={currentTime}
            editorReady={ready && duration > 0}
            onSeek={seekTo}
            onRangeSelect={({ startSeconds, endSeconds }) =>
              trim.setClipWindow(startSeconds, endSeconds)
            }
          />
        </div>
      ) : null}

      {selectedClip ? (
        <CreatorWorkspaceClipPreview
          item={selectedClip}
          onClose={() => {
            setSelectedClipId(null);
            requestAnimationFrame(() => selectedClipTrigger.current?.focus());
          }}
        />
      ) : null}
    </section>
  );

  return (
    <form
      role="region"
      aria-label="Creator workspace"
      onSubmit={handleSubmit}
      {...stylex.props(
        styles.workspace,
        reusableVideo
          ? styles.workspaceWithSource
          : styles.workspaceWithoutSource,
      )}
    >
      {stagePanel}
      {builderPanel}
      <CreatorWorkspaceClipReel
        items={clipItems}
        selectedClipId={selectedClipId}
        onSelect={(clipId, trigger) => {
          selectedClipTrigger.current = trigger;
          setSelectedClipId((current) => (current === clipId ? null : clipId));
        }}
      />
    </form>
  );
}

const controlFocus = {
  outlineWidth: "2px",
  outlineStyle: "solid",
  outlineColor: carpoIdentityTokens.focus,
  outlineOffset: "2px",
} as const;

const styles = stylex.create({
  workspace: {
    gridColumn: "1 / -1",
    width: "100%",
    minHeight: "620px",
    display: "grid",
    gridTemplateColumns:
      "minmax(286px, 310px) minmax(440px, 1fr) minmax(238px, 276px)",
    gridTemplateAreas: '"builder stage reel"',
    margin: 0,
    borderWidth: 0,
    backgroundColor: carpoIdentityTokens.carbon,
    color: carpoIdentityTokens.ink,
    fontFamily: carpoIdentityTokens.fontUi,
    "@media (max-width: 1080px)": {
      gridTemplateColumns: "260px minmax(360px, 1fr) 260px",
    },
    "@media (max-width: 900px)": {
      minHeight: 0,
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateAreas: '"stage" "builder" "reel"',
    },
  },
  workspaceWithSource: {
    height: "calc(100vh - 152px)",
    "@media (max-width: 900px)": { height: "auto" },
  },
  workspaceWithoutSource: {
    height: "calc(100vh - 70px)",
    "@media (max-width: 900px)": { height: "auto" },
  },
  builder: {
    gridArea: "builder",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    paddingBlock: "22px 36px",
    paddingInline: "18px",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: carpoIdentityTokens.lineMuted,
    backgroundColor: carpoIdentityTokens.builderSurface,
    scrollbarColor: "#5c6982 transparent",
    "@media (max-width: 900px)": {
      overflowY: "visible",
      borderRightWidth: 0,
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: carpoIdentityTokens.lineMuted,
    },
    "@media (max-width: 560px)": { paddingInline: "14px" },
  },
  builderTitle: {
    position: "relative",
    margin: 0,
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "27px",
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: "0.035em",
    textTransform: "uppercase",
    "::after": {
      content: '""',
      width: "36px",
      height: "4px",
      display: "block",
      marginTop: "7px",
      backgroundColor: carpoIdentityTokens.vermilion,
      transform: "skewX(-24deg)",
      transformOrigin: "left",
    },
  },
  sourceTabs: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: carpoIdentityTokens.line,
  },
  sourceTab: {
    minHeight: "44px",
    padding: "8px 4px",
    borderWidth: 0,
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    backgroundColor: "transparent",
    color: carpoIdentityTokens.inkFaint,
    cursor: "pointer",
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "0.025em",
    textTransform: "uppercase",
    ":hover": { color: carpoIdentityTokens.ink },
    ":focus-visible": controlFocus,
  },
  sourceTabActive: {
    borderBottomColor: carpoIdentityTokens.vermilion,
    color: carpoIdentityTokens.ink,
  },
  field: { display: "grid", gap: "7px" },
  hiddenField: { display: "none" },
  fieldLabel: {
    color: carpoIdentityTokens.inkDim,
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "16px",
    fontWeight: 600,
    letterSpacing: "0.025em",
    lineHeight: 1.4,
  },
  input: {
    width: "100%",
    minWidth: 0,
    minHeight: "46px",
    paddingBlock: "9px",
    paddingInline: "11px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineControl,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.carbonRaised,
    color: carpoIdentityTokens.ink,
    caretColor: carpoIdentityTokens.vermilion,
    "::placeholder": { color: carpoIdentityTokens.inkFaint },
    ":hover": { borderColor: "#777d8b" },
    ":focus-visible": controlFocus,
  },
  fileInput: {
    width: "100%",
    minWidth: 0,
    minHeight: "46px",
    padding: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineControl,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.carbonRaised,
    color: carpoIdentityTokens.inkDim,
    fontSize: "13px",
    ":hover": { borderColor: "#777d8b" },
    ":focus-visible": controlFocus,
  },
  fieldError: {
    color: carpoIdentityTokens.red,
    fontSize: "12px",
    lineHeight: 1.4,
  },
  fieldOk: {
    color: carpoIdentityTokens.green,
    fontSize: "12px",
    lineHeight: 1.4,
  },
  fieldHint: {
    color: carpoIdentityTokens.inkFaint,
    fontSize: "12px",
    lineHeight: 1.4,
  },
  qualityOptions: { display: "flex", gap: "8px" },
  qualityButton: {
    minWidth: "82px",
    minHeight: "44px",
    paddingInline: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineInteractive,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.controlSurface,
    color: carpoIdentityTokens.inkDim,
    cursor: "pointer",
    fontWeight: 700,
    ":hover": {
      borderColor: "#7d8494",
      backgroundColor: carpoIdentityTokens.controlHover,
    },
    ":focus-visible": controlFocus,
  },
  qualityButtonActive: {
    borderColor: carpoIdentityTokens.vermilion,
    backgroundColor: carpoIdentityTokens.vermilion,
    color: carpoIdentityTokens.paperInk,
  },
  createButton: {
    width: "100%",
    minHeight: "56px",
    marginTop: "4px",
    paddingInline: "18px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ff6c5c",
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.vermilion,
    boxShadow: "4px 4px 0 #791f16",
    color: carpoIdentityTokens.paperInk,
    cursor: "pointer",
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "19px",
    fontWeight: 700,
    letterSpacing: "0.035em",
    textTransform: "uppercase",
    transitionDuration: "150ms",
    transitionProperty: "background-color, border-color, transform, box-shadow",
    transitionTimingFunction: "ease-out",
    ":hover:not(:disabled)": {
      backgroundColor: carpoIdentityTokens.vermilionHover,
      transform: "translate(-1px, -1px)",
      boxShadow: "5px 5px 0 #791f16",
    },
    ":disabled": {
      borderColor: carpoIdentityTokens.lineInteractive,
      backgroundColor: carpoIdentityTokens.navyRaised,
      boxShadow: "none",
      color: carpoIdentityTokens.inkFaint,
      cursor: "not-allowed",
      opacity: 0.58,
    },
    ":focus-visible": controlFocus,
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0ms",
    },
  },
  secondaryButton: {
    minHeight: "44px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: "13px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineInteractive,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.controlSurface,
    color: carpoIdentityTokens.ink,
    cursor: "pointer",
    fontWeight: 600,
    ":hover": {
      borderColor: "#7d8494",
      backgroundColor: carpoIdentityTokens.controlHover,
    },
    ":focus-visible": controlFocus,
  },
  dangerButton: {
    minHeight: "44px",
    paddingInline: "13px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ff7a6a",
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.vermilionSoft,
    color: carpoIdentityTokens.ink,
    cursor: "pointer",
    fontWeight: 700,
    ":focus-visible": controlFocus,
  },
  inlineError: {
    padding: "10px 11px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#7d3235",
    backgroundColor: carpoIdentityTokens.redDeep,
    color: "#ffb0a8",
    fontSize: "13px",
    lineHeight: 1.45,
  },
  stage: {
    gridArea: "stage",
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    overflowY: "auto",
    paddingBlock: "22px 36px",
    paddingInline: "22px",
    backgroundColor: carpoIdentityTokens.carbonRaised,
    scrollbarColor: "#5c6982 transparent",
    "@media (max-width: 900px)": { overflowY: "visible" },
    "@media (max-width: 560px)": { paddingInline: "14px" },
  },
  stageHeading: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "18px",
    marginBottom: "14px",
    "@media (max-width: 560px)": { alignItems: "flex-start" },
  },
  stageTitle: {
    position: "relative",
    margin: 0,
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "clamp(27px, 2.4vw, 36px)",
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: "0.035em",
    textTransform: "uppercase",
    "::after": {
      content: '""',
      width: "36px",
      height: "4px",
      display: "block",
      marginTop: "7px",
      backgroundColor: carpoIdentityTokens.vermilion,
      transform: "skewX(-24deg)",
      transformOrigin: "left",
    },
  },
  stageInstructions: {
    marginBlock: "7px 0",
    color: carpoIdentityTokens.inkDim,
    lineHeight: 1.45,
  },
  stageTime: {
    color: carpoIdentityTokens.time,
    fontFamily: carpoIdentityTokens.fontTime,
    fontSize: "13px",
    whiteSpace: "nowrap",
    "@media (max-width: 560px)": { display: "none" },
  },
  sourceStatus: {
    marginBottom: "14px",
    padding: "12px 14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineStrong,
    backgroundColor: carpoIdentityTokens.navy,
    color: carpoIdentityTokens.inkDim,
    fontSize: "13px",
    lineHeight: 1.5,
  },
  sourceStatusFailed: {
    borderColor: "#7d3235",
    backgroundColor: carpoIdentityTokens.redDeep,
    color: "#ffb0a8",
  },
  recoveryActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "10px",
  },
  playerSection: { width: "100%" },
  playerFrame: {
    width: "min(100%, calc(56vh * 16 / 9))",
    aspectRatio: "16 / 9",
    position: "relative",
    marginInline: "auto",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#454a57",
    backgroundColor: carpoIdentityTokens.mediaSurface,
    boxShadow: "9px 9px 0 #08090c",
    clipPath:
      "polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%)",
  },
  timelineSurface: {
    marginTop: "14px",
    paddingBlock: "16px 12px",
    paddingInline: "18px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: carpoIdentityTokens.lineMuted,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: carpoIdentityTokens.lineMuted,
    backgroundColor: carpoIdentityTokens.timelineSurface,
  },
  transcriptSurface: {
    marginTop: "16px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: carpoIdentityTokens.lineMuted,
  },
  emptyStage: {
    width: "100%",
    minHeight: "min(52vh, 520px)",
    padding: "24px",
    display: "grid",
    placeContent: "center",
    justifyItems: "center",
    gap: "12px",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: carpoIdentityTokens.lineInteractive,
    borderRadius: 0,
    backgroundColor: carpoIdentityTokens.navySoft,
    color: carpoIdentityTokens.ink,
    fontFamily: carpoIdentityTokens.fontUi,
    fontSize: "16px",
    fontWeight: 600,
    cursor: "pointer",
    ":hover:not(:disabled)": {
      borderColor: carpoIdentityTokens.vermilion,
      backgroundColor: carpoIdentityTokens.navyRaised,
    },
    ":focus-visible": controlFocus,
    ":disabled": {
      cursor: "default",
      color: carpoIdentityTokens.inkFaint,
    },
  },
  emptyStageIcon: {
    width: "44px",
    height: "44px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
});
