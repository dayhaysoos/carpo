import { useMutation, useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  createClip,
  createClipFromSourceVideo,
  createSourceVideo,
  getSourceVideo,
  requestUploadUrl,
  retryRemoteSourceIngestion,
  sourceVideoUploadUrl,
  updateSourceVideoDuration,
  uploadFileWithProgress,
} from "../api";
import { useNativeVideoPlayer } from "../hooks/useNativeVideoPlayer";
import { useTrimRange } from "../hooks/useTrimRange";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import {
  MAX_CAPTION_LENGTH,
  MAX_CLIP_LENGTH_SECONDS,
  type ClipResponse,
  type ClipQuality,
  type CreateClipRequest,
  type CreateSourceVideoRequest,
  DEFAULT_CLIP_QUALITY,
} from "../types";
import {
  deriveUploadClipTitle,
  type OwnedUploadClipJourneyView,
} from "../owned-upload-clip-journey";
import {
  contentTypeForFile,
  formatUploadProgress,
  validateUploadFile,
} from "../upload";
import { extractYoutubeVideoId, isValidYoutubeUrl } from "../youtube";
import type { ClipWindowRequest } from "../timestamp-windows";
import { toExistingClipRanges } from "../timeline";
import { TranscriptPanel } from "./TranscriptPanel";
import { TrimSlider } from "./TrimSlider";
import { OwnedUploadClipResult } from "./OwnedUploadClipResult";
import { RemoteSourceFailureHint } from "./RemoteSourceFailureHint";

type SourceMode = "youtube" | "upload";

interface CreatorFormProps {
  onClipCreated: (clip: ClipResponse) => void;
  onVideoActivated: (videoId: string) => void;
  onPendingYoutubeVideoChange?: (youtubeVideoId: string | null) => void;
  clipWindowRequest?: ClipWindowRequest | null;
  ownedUploadJourney: OwnedUploadClipJourneyView;
}

const DEFAULT_MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

interface CreatorFormState {
  sourceMode: SourceMode;
  clipCreatedNotice: boolean;
  url: string;
  title: string;
  caption: string;
  quality: ClipQuality;
  urlTouched: boolean;
  selectedFile: File | null;
  uploadKey: string | null;
  uploadError: string | null;
  uploadProgress: string | null;
  maxUploadBytes: number;
  sourceActivationError: string | null;
}

type CreatorFormAction =
  | { type: "update"; patch: Partial<CreatorFormState> }
  | { type: "select-source-mode"; mode: SourceMode }
  | {
      type: "load-reusable-video";
      source: CreateSourceVideoRequest["source"];
      title: string;
    }
  | { type: "choose-another" }
  | { type: "select-file"; file: File | null; title: string }
  | { type: "clip-created" }
  | { type: "hide-clip-created-notice" };

const INITIAL_CREATOR_FORM_STATE: CreatorFormState = {
  sourceMode: "upload",
  clipCreatedNotice: false,
  url: "",
  title: "",
  caption: "",
  quality: DEFAULT_CLIP_QUALITY,
  urlTouched: false,
  selectedFile: null,
  uploadKey: null,
  uploadError: null,
  uploadProgress: null,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  sourceActivationError: null,
};

function creatorFormReducer(
  state: CreatorFormState,
  action: CreatorFormAction,
): CreatorFormState {
  switch (action.type) {
    case "update":
      return { ...state, ...action.patch };
    case "select-source-mode":
      return {
        ...state,
        sourceMode: action.mode,
        urlTouched: false,
        uploadError: null,
        uploadProgress: null,
        sourceActivationError: null,
        ...(action.mode === "youtube"
          ? { selectedFile: null, uploadKey: null }
          : { url: "" }),
      };
    case "load-reusable-video":
      return {
        ...state,
        sourceMode: action.source.type,
        selectedFile: null,
        uploadKey: null,
        url: action.source.type === "youtube" ? action.source.url : "",
        ...(action.source.type === "upload" && state.title.trim().length === 0
          ? { title: deriveUploadClipTitle(action.title) }
          : {}),
      };
    case "choose-another":
      return {
        ...state,
        url: "",
        selectedFile: null,
        uploadKey: null,
      };
    case "select-file":
      return {
        ...state,
        selectedFile: action.file,
        title:
          action.file && action.file === state.selectedFile
            ? state.title
            : action.title,
        uploadKey: null,
        uploadError: null,
        uploadProgress: null,
      };
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
  onClipCreated,
  onVideoActivated,
  onPendingYoutubeVideoChange,
  clipWindowRequest,
  ownedUploadJourney,
}: CreatorFormProps) {
  const [searchParams] = useSearchParams();
  const reusableVideoId = searchParams.get("video") ?? "";
  const [form, dispatch] = useReducer(
    creatorFormReducer,
    INITIAL_CREATOR_FORM_STATE,
  );
  const {
    sourceMode,
    clipCreatedNotice,
    url,
    title,
    caption,
    quality,
    urlTouched,
    selectedFile,
    uploadKey,
    uploadError,
    uploadProgress,
    maxUploadBytes,
    sourceActivationError,
  } = form;
  const appliedClipWindowRequest = useRef<number | null>(null);
  const durationUpdateKey = useRef<string | null>(null);
  const sourceActivationKey = useRef<string | null>(null);
  const uploadGeneration = useRef(0);
  const youtubeMetadata = useRef({ title: "", duration: 0 });
  const activateVideo = useCallback(
    async (
      request: CreateSourceVideoRequest,
      shouldActivate: () => boolean = () => true,
    ) => {
      const video = await createSourceVideo(request);
      if (shouldActivate()) {
        onVideoActivated(video.id);
      }
    },
    [onVideoActivated],
  );

  const {
    data: reusableVideoData,
    error: reusableVideoError,
    isLoading: reusableVideoLoading,
    refetch: refetchReusableVideo,
  } = useQuery({
    queryKey: ["source-video", reusableVideoId],
    queryFn: () => getSourceVideo(reusableVideoId),
    enabled: Boolean(reusableVideoId),
    refetchInterval: (query) => {
      const status = query.state.data?.video.remoteIngestion?.status;
      return status === "pending" || status === "importing" ? 1000 : false;
    },
  });
  const reusableVideo = reusableVideoData?.video ?? null;
  const existingClips = useMemo(
    () => toExistingClipRanges(reusableVideoData?.clips),
    [reusableVideoData?.clips],
  );

  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl.length > 0 && isValidYoutubeUrl(trimmedUrl);
  const urlInvalid = urlTouched && trimmedUrl.length > 0 && !urlValid;
  const videoId = sourceMode === "youtube" && urlValid ? extractYoutubeVideoId(trimmedUrl) : null;

  useEffect(() => {
    onPendingYoutubeVideoChange?.(
      !reusableVideoId && sourceMode === "youtube" ? videoId : null,
    );
  }, [
    onPendingYoutubeVideoChange,
    reusableVideoId,
    sourceMode,
    videoId,
  ]);

  const filePreviewUrl = useMemo(
    () => (selectedFile ? URL.createObjectURL(selectedFile) : null),
    [selectedFile],
  );
  const useRetainedRemotePlayer = Boolean(
    sourceMode === "youtube" &&
      reusableVideo?.source.type === "youtube" &&
      reusableVideo.retainedSourceReady &&
      (!reusableVideo.remoteIngestion ||
        reusableVideo.remoteIngestion.status === "ready"),
  );
  const reusableNativePreviewUrl =
    reusableVideo &&
    (reusableVideo.source.type === "upload" || useRetainedRemotePlayer)
      ? sourceVideoUploadUrl(reusableVideo.id)
      : null;
  const nativePreviewUrl = reusableNativePreviewUrl ?? filePreviewUrl;

  useEffect(() => {
    return () => {
      if (filePreviewUrl) {
        URL.revokeObjectURL(filePreviewUrl);
      }
    };
  }, [filePreviewUrl]);

  const youtube = useYoutubePlayer(
    sourceMode === "youtube" && !useRetainedRemotePlayer ? videoId : null,
  );
  youtubeMetadata.current = {
    title: youtube.title,
    duration: youtube.duration,
  };

  const fileValidationError =
    sourceMode === "upload" && selectedFile
      ? validateUploadFile(selectedFile, maxUploadBytes)
      : null;

  const native = useNativeVideoPlayer(
    (sourceMode === "upload" || useRetainedRemotePlayer) &&
      nativePreviewUrl &&
      (!selectedFile || !fileValidationError)
      ? nativePreviewUrl
      : null,
  );

  const ready =
    sourceMode === "youtube" && !useRetainedRemotePlayer
      ? youtube.ready
      : Boolean(
          (selectedFile || reusableNativePreviewUrl) &&
            !fileValidationError &&
            native.ready,
        );
  const duration =
    sourceMode === "youtube" && !useRetainedRemotePlayer
      ? youtube.duration
      : native.duration;
  const currentTime =
    sourceMode === "youtube" && !useRetainedRemotePlayer
      ? youtube.currentTime
      : native.currentTime;
  const seekTo =
    sourceMode === "youtube" && !useRetainedRemotePlayer
      ? youtube.seekTo
      : native.seekTo;
  const trim = useTrimRange({ duration, onSeek: seekTo });
  const durationMatchesActiveSource =
    (sourceMode === "youtube" && !useRetainedRemotePlayer) ||
    (nativePreviewUrl !== null &&
      native.mediaStateSourceUrl === nativePreviewUrl);

  useEffect(() => {
    if (
      !reusableVideoId ||
      !ready ||
      duration <= 0 ||
      !durationMatchesActiveSource
    ) {
      return;
    }
    if (
      reusableVideo?.durationSeconds &&
      Math.abs(reusableVideo.durationSeconds - duration) < 0.01
    ) {
      return;
    }
    const normalizedDuration = Math.round(duration * 1000) / 1000;
    const updateKey = `${reusableVideoId}:${normalizedDuration}`;
    if (durationUpdateKey.current === updateKey) return;
    durationUpdateKey.current = updateKey;
    void updateSourceVideoDuration(
      reusableVideoId,
      normalizedDuration,
    ).catch(() => {
      durationUpdateKey.current = null;
    });
  }, [
    duration,
    durationMatchesActiveSource,
    ready,
    reusableVideo?.durationSeconds,
    reusableVideoId,
  ]);

  useEffect(() => {
    if (
      reusableVideoId ||
      sourceMode !== "youtube" ||
      !urlValid ||
      !videoId
    ) {
      return;
    }
    const activationKey = `youtube:${videoId}`;
    if (sourceActivationKey.current === activationKey) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      sourceActivationKey.current = activationKey;
      dispatch({
        type: "update",
        patch: { sourceActivationError: null },
      });
      const metadata = youtubeMetadata.current;
      void activateVideo(
        {
          source: { type: "youtube", url: trimmedUrl },
          title: metadata.title || `YouTube video ${videoId}`,
          ...(metadata.duration > 0
            ? {
                durationSeconds:
                  Math.round(metadata.duration * 1000) / 1000,
              }
            : {}),
        },
        () =>
          !cancelled && sourceActivationKey.current === activationKey,
      )
        .catch((error) => {
          if (cancelled) return;
          sourceActivationKey.current = null;
          dispatch({
            type: "update",
            patch: {
              sourceActivationError:
                error instanceof Error
                  ? error.message
                  : "Failed to prepare video",
            },
          });
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (sourceActivationKey.current === activationKey) {
        sourceActivationKey.current = null;
      }
    };
  }, [
    activateVideo,
    reusableVideoId,
    sourceMode,
    trimmedUrl,
    urlValid,
    videoId,
  ]);

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
  const remoteSourceReadyForClip =
    sourceMode !== "youtube" ||
    Boolean(
      reusableVideo?.retainedSourceReady &&
        (!reusableVideo.remoteIngestion ||
          reusableVideo.remoteIngestion.status === "ready"),
    );
  const canCreate =
    ready &&
    remoteSourceReadyForClip &&
    title.trim().length > 0 &&
    clipDuration > 0 &&
    clipDuration <= MAX_CLIP_LENGTH_SECONDS &&
    (reusableVideo
      ? true
      : (sourceMode === "youtube" && urlValid && videoId) ||
        (sourceMode === "upload" && uploadKey && !fileValidationError));

  const retryIngestion = useMutation({
    mutationFn: () => retryRemoteSourceIngestion(reusableVideoId),
    onSuccess: () => {
      window.setTimeout(() => void refetchReusableVideo(), 250);
    },
  });

  const mutation = useMutation({
    mutationFn: (request: CreateClipRequest) => {
      if (reusableVideoId && reusableVideo) {
        const { source: _source, sourceTitle: _sourceTitle, ...clipRequest } =
          request;
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

  const handleSourceModeChange = (mode: SourceMode) => {
    uploadGeneration.current += 1;
    dispatch({ type: "select-source-mode", mode });
    sourceActivationKey.current = null;
  };

  useEffect(() => {
    if (!reusableVideo) return;
    dispatch({
      type: "load-reusable-video",
      source: reusableVideo.source,
      title: reusableVideo.title,
    });
  }, [reusableVideo]);

  useEffect(() => {
    if (!reusableVideoId && searchParams.get("source") === "upload") {
      handleSourceModeChange("upload");
    }
  }, [searchParams]);

  const handleFileChange = async (file: File | null) => {
    const generation = uploadGeneration.current + 1;
    uploadGeneration.current = generation;
    const isCurrentUpload = () => uploadGeneration.current === generation;
    dispatch({
      type: "select-file",
      file,
      title: file ? deriveUploadClipTitle(file.name) : "",
    });

    if (!file) {
      return;
    }

    const validationError = validateUploadFile(file, maxUploadBytes);
    if (validationError) {
      dispatch({ type: "update", patch: { uploadError: validationError } });
      return;
    }

    const contentType = contentTypeForFile(file);
    if (!contentType) {
      dispatch({
        type: "update",
        patch: { uploadError: "Unsupported video file type" },
      });
      return;
    }

    try {
      dispatch({
        type: "update",
        patch: { uploadProgress: "Preparing upload…" },
      });
      const slot = await requestUploadUrl({
        contentType,
        sizeBytes: file.size,
        filename: file.name,
      });
      if (!isCurrentUpload()) return;
      dispatch({
        type: "update",
        patch: { maxUploadBytes: slot.maxSizeBytes },
      });

      const slotValidation = validateUploadFile(file, slot.maxSizeBytes);
      if (slotValidation) {
        dispatch({
          type: "update",
          patch: { uploadError: slotValidation, uploadProgress: null },
        });
        return;
      }

      await uploadFileWithProgress(
        slot.uploadUrl,
        file,
        slot.contentType,
        (loaded, total) => {
          if (isCurrentUpload()) {
            dispatch({
              type: "update",
              patch: { uploadProgress: formatUploadProgress(loaded, total) },
            });
          }
        },
      );
      if (!isCurrentUpload()) return;

      dispatch({
        type: "update",
        patch: { uploadKey: slot.key, uploadProgress: "Upload complete" },
      });
      await activateVideo(
        {
          source: { type: "upload", key: slot.key },
          title: deriveUploadClipTitle(file.name),
        },
        isCurrentUpload,
      );
    } catch (error) {
      if (!isCurrentUpload()) return;
      dispatch({
        type: "update",
        patch: {
          uploadError:
            error instanceof Error ? error.message : "Upload failed",
          uploadProgress: null,
        },
      });
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;

    if (sourceMode === "youtube" && videoId) {
      mutation.mutate({
        title: title.trim(),
        sourceTitle: reusableVideo?.title || youtube.title || undefined,
        source: { type: "youtube", url: trimmedUrl },
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

    const reusableUploadKey =
      reusableVideo?.source.type === "upload"
        ? reusableVideo.source.key
        : null;
    if (sourceMode === "upload" && (uploadKey || reusableUploadKey)) {
      mutation.mutate({
        title: title.trim(),
        sourceTitle:
          reusableVideo?.title ||
          (selectedFile ? deriveUploadClipTitle(selectedFile.name) : undefined),
        source: { type: "upload", key: uploadKey || reusableUploadKey! },
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

  return (
    <form className="creator-form card" onSubmit={handleSubmit}>
      <div className="card-header">
        <h2>New clip</h2>
        <p>
          {reusableVideo
            ? `Create another clip from ${reusableVideo.title}.`
            : "Paste a YouTube URL or upload a video, mark the moment, and create."}
        </p>
      </div>

      {reusableVideoLoading && (
        <div className="reuse-source-banner">Loading video…</div>
      )}

      {reusableVideoError && (
        <div className="form-error" role="alert">
          {reusableVideoError.message}
        </div>
      )}

      {reusableVideo && (
        <div className="reuse-source-banner">
          <div>
            <strong>{reusableVideo.title}</strong>
            <span>
              {reusableVideo.source.type === "youtube"
                ? "YouTube video"
                : "Uploaded video"}
            </span>
          </div>
          <Link
            to="/"
            className="btn-ghost"
            onClick={() => {
              dispatch({ type: "choose-another" });
              sourceActivationKey.current = null;
              uploadGeneration.current += 1;
            }}
          >
            Choose another
          </Link>
        </div>
      )}

      {reusableVideo?.remoteIngestion &&
        reusableVideo.remoteIngestion.status !== "ready" && (
          <div
            className={
              reusableVideo.remoteIngestion.status === "failed"
                ? "form-error"
                : "reuse-source-banner"
            }
            role={
              reusableVideo.remoteIngestion.status === "failed"
                ? "alert"
                : "status"
            }
          >
            {reusableVideo.remoteIngestion.failure ? (
              <>
                <p>{reusableVideo.remoteIngestion.failure.message}</p>
                <RemoteSourceFailureHint
                  failure={reusableVideo.remoteIngestion.failure}
                />
                {reusableVideo.remoteIngestion.failure.retryable && (
                  <button
                    type="button"
                    className="btn-ghost upload-retry"
                    disabled={retryIngestion.isPending}
                    onClick={() => retryIngestion.mutate()}
                  >
                    {retryIngestion.isPending ? "Retrying…" : "Retry import"}
                  </button>
                )}
              </>
            ) : (
              <p>
                Importing this YouTube video into your private library. You can
                mark the moment now; clip creation unlocks when import finishes.
              </p>
            )}
          </div>
        )}

      {!reusableVideoId && (
        <div className="source-picker" role="tablist" aria-label="Source type">
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === "youtube"}
          className={`source-tab ${sourceMode === "youtube" ? "active" : ""}`}
          onClick={() => handleSourceModeChange("youtube")}
        >
          YouTube URL
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === "upload"}
          className={`source-tab ${sourceMode === "upload" ? "active" : ""}`}
          onClick={() => handleSourceModeChange("upload")}
        >
          Upload file
        </button>
        </div>
      )}

      {!reusableVideoId && (sourceMode === "youtube" ? (
        <label className="field">
          <span>YouTube URL</span>
          <input
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(event) =>
              dispatch({
                type: "update",
                patch: { url: event.target.value },
              })
            }
            onBlur={() =>
              dispatch({ type: "update", patch: { urlTouched: true } })
            }
            autoComplete="off"
            spellCheck={false}
          />
          {urlInvalid && (
            <span className="field-error">
              Enter a valid YouTube URL (youtube.com or youtu.be)
            </span>
          )}
          {urlValid && <span className="field-ok">Valid YouTube URL</span>}
        </label>
      ) : (
        <>
          <label className="field">
            <span>Video file</span>
            <input
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
              onChange={(e) =>
                void handleFileChange(e.target.files?.[0] ?? null)
              }
            />
            {selectedFile && !fileValidationError && !uploadError && (
              <span className="field-ok">
                {selectedFile.name} ({Math.round(selectedFile.size / 1024)} KB)
              </span>
            )}
            {fileValidationError && (
              <span className="field-error">{fileValidationError}</span>
            )}
            {uploadError && <span className="field-error">{uploadError}</span>}
            {uploadProgress && (
              <span className="field-hint">{uploadProgress}</span>
            )}
          </label>
          {uploadError && selectedFile && !fileValidationError && (
            <button
              type="button"
              className="btn-ghost upload-retry"
              onClick={() => void handleFileChange(selectedFile)}
            >
              Retry upload
            </button>
          )}
        </>
      ))}

      {sourceMode === "youtube" && videoId && !useRetainedRemotePlayer && (
        <div className="player-section">
          <div className="player-frame">
            <div id={youtube.containerId} className="player-embed" />
            {!youtube.ready && <div className="player-loading">Loading player…</div>}
          </div>
          <TrimSlider
            duration={duration}
            ready={ready}
            trim={trim}
            existingClips={existingClips}
          />
          <div className="quality-picker" role="group" aria-label="Output quality">
            <span className="quality-label">Quality</span>
            <div className="quality-options">
              <button
                type="button"
                className={`quality-option ${quality === "1080p" ? "active" : ""}`}
                aria-pressed={quality === "1080p"}
                onClick={() =>
                  dispatch({ type: "update", patch: { quality: "1080p" } })
                }
              >
                1080p
              </button>
              <button
                type="button"
                className={`quality-option ${quality === "720p" ? "active" : ""}`}
                aria-pressed={quality === "720p"}
                onClick={() =>
                  dispatch({ type: "update", patch: { quality: "720p" } })
                }
              >
                720p
              </button>
            </div>
          </div>
        </div>
      )}

      {(sourceMode === "upload" || useRetainedRemotePlayer) &&
        (selectedFile || reusableNativePreviewUrl) &&
        !fileValidationError && (
        <div className="player-section">
          <div className="player-frame">
            <video
              ref={native.videoRef}
              className="native-player"
              controls
              playsInline
              preload="metadata"
            />
            {!ready && (
              <div className="player-loading">
                {native.error
                  ? "Original uploaded video is unavailable"
                  : "Loading preview…"}
              </div>
            )}
          </div>
          <TrimSlider
            duration={duration}
            ready={ready}
            trim={trim}
            existingClips={existingClips}
          />
          <div className="quality-picker" role="group" aria-label="Output quality">
            <span className="quality-label">Quality</span>
            <div className="quality-options">
              <button
                type="button"
                className={`quality-option ${quality === "1080p" ? "active" : ""}`}
                aria-pressed={quality === "1080p"}
                onClick={() =>
                  dispatch({ type: "update", patch: { quality: "1080p" } })
                }
              >
                1080p
              </button>
              <button
                type="button"
                className={`quality-option ${quality === "720p" ? "active" : ""}`}
                aria-pressed={quality === "720p"}
                onClick={() =>
                  dispatch({ type: "update", patch: { quality: "720p" } })
                }
              >
                720p
              </button>
            </div>
          </div>
        </div>
      )}

      {reusableVideoId && (
        <TranscriptPanel
          videoId={reusableVideoId}
          currentTime={currentTime}
          editorReady={ready && duration > 0}
          onSeek={seekTo}
          onRangeSelect={({ startSeconds, endSeconds }) =>
            trim.setClipWindow(startSeconds, endSeconds)
          }
        />
      )}

      <label className="field">
        <span>Title</span>
        <input
          type="text"
          placeholder="Name this clip"
          value={title}
          onChange={(event) =>
            dispatch({
              type: "update",
              patch: { title: event.target.value },
            })
          }
          maxLength={200}
        />
      </label>

      <label className="field">
        <span>Overlay text (optional)</span>
        <input
          type="text"
          placeholder="Show static text throughout the clip"
          value={caption}
          onChange={(event) =>
            dispatch({
              type: "update",
              patch: { caption: event.target.value },
            })
          }
          maxLength={MAX_CAPTION_LENGTH}
        />
      </label>

      {mutation.error && (
        <div className="form-error" role="alert">
          {mutation.error.message}
        </div>
      )}

      {sourceActivationError && (
        <div className="form-error" role="alert">
          {sourceActivationError}
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={!canCreate || mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create clip"}
      </button>

      {clipCreatedNotice && (
        <p className="form-success" role="status">
          Clip queued below.
        </p>
      )}

      <OwnedUploadClipResult journey={ownedUploadJourney} />
    </form>
  );
}
