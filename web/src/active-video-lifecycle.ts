import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  createSourceVideo,
  getSourceVideo,
  requestUploadUrl,
  retryRemoteSourceIngestion,
  sourceVideoUploadUrl,
  updateSourceVideoDuration,
  uploadFileWithProgress,
} from "./api";
import { deriveUploadClipTitle } from "./owned-upload-clip-journey";
import { sourceVideoQueryKey } from "./queries";
import { isTerminalStatus } from "./status";
import type {
  ClipResponse,
  ClipSource,
  CreateSourceVideoRequest,
  SourceVideoDetailResponse,
  SourceVideoResponse,
  UploadUrlResponse,
} from "./types";
import {
  contentTypeForFile,
  formatUploadProgress,
  validateUploadFile,
} from "./upload";
import { extractYoutubeVideoId, isValidYoutubeUrl } from "./youtube";

export type ActiveVideoSourceMode = "youtube" | "upload";

export interface ActiveVideoIssue {
  area:
    | "load"
    | "activation"
    | "upload"
    | "ingestion-retry"
    | "duration-sync";
  code: string;
  message: string;
  retryable: boolean;
}

export type ActiveVideoSelection =
  | { status: "none"; id: null }
  | { status: "loading"; id: string }
  | { status: "ready"; id: string; video: SourceVideoResponse; clips: ClipResponse[] }
  | { status: "failed"; id: string; issue: ActiveVideoIssue };

export interface ActiveVideoUploadView {
  fileName: string;
  sizeBytes: number;
  previewUrl: string | null;
}

export type ActiveVideoPreview =
  | { type: "none" }
  | { type: "youtube"; videoId: string }
  | { type: "native"; url: string };

export interface ActiveVideoManualSourceView {
  mode: ActiveVideoSourceMode;
  youtubeUrl: string;
  youtubeVideoId: string | null;
  youtubeValidity: "empty" | "valid" | "invalid";
  upload: ActiveVideoUploadView | null;
  phase: "idle" | "settling" | "uploading" | "activating" | "failed";
  progress: string | null;
  preparedSource: ClipSource | null;
  issue: ActiveVideoIssue | null;
}

export interface ActiveVideoView {
  active: ActiveVideoSelection;
  manualSource: ActiveVideoManualSourceView;
  pendingYoutubeVideoId: string | null;
  preview: ActiveVideoPreview;
  readyForClip: boolean;
  refresh: "idle" | "polling";
  refreshIssue: ActiveVideoIssue | null;
}

export type ActiveVideoCommand =
  | { type: "source-mode-changed"; mode: ActiveVideoSourceMode }
  | { type: "youtube-url-changed"; value: string }
  | {
      type: "youtube-metadata-observed";
      title: string;
      durationSeconds: number;
    }
  | { type: "upload-selected"; file: File | null }
  | { type: "retry-upload" }
  | { type: "retry-ingestion" }
  | {
      type: "active-duration-observed";
      videoId: string;
      durationSeconds: number;
    }
  | {
      type: "clip-created";
      videoId: string;
      clip: Pick<ClipResponse, "id" | "status">;
    }
  | { type: "clear" };

export type ActiveVideoResult =
  | { ok: true; outcome: "applied" | "scheduled" | "activated" | "cleared" | "noop" }
  | { ok: false; outcome: "superseded" }
  | { ok: false; outcome: "failed"; issue: ActiveVideoIssue };

export interface ActiveVideoLifecycle {
  view: ActiveVideoView;
  perform(command: ActiveVideoCommand): Promise<ActiveVideoResult>;
}

export interface ActiveVideoGateway {
  load(videoId: string): Promise<SourceVideoDetailResponse>;
  create(request: CreateSourceVideoRequest): Promise<SourceVideoResponse>;
  requestUpload(input: {
    contentType: string;
    sizeBytes: number;
    filename: string;
  }): Promise<UploadUrlResponse>;
  upload(
    uploadUrl: string,
    file: File,
    contentType: string,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<void>;
  retryIngestion(videoId: string): Promise<SourceVideoResponse>;
  updateDuration(videoId: string, durationSeconds: number): Promise<SourceVideoResponse>;
}

const productionActiveVideoGateway: ActiveVideoGateway = {
  load: getSourceVideo,
  create: createSourceVideo,
  requestUpload: requestUploadUrl,
  upload: uploadFileWithProgress,
  retryIngestion: retryRemoteSourceIngestion,
  updateDuration: updateSourceVideoDuration,
};

const DEFAULT_MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const DEFAULT_SETTLE_MS = 300;

interface AcquisitionState {
  mode: ActiveVideoSourceMode;
  youtubeUrl: string;
  youtubeMetadata: { title: string; durationSeconds: number };
  file: File | null;
  maxUploadBytes: number;
  phase: ActiveVideoManualSourceView["phase"];
  progress: string | null;
  preparedSource: ClipSource | null;
  issue: ActiveVideoIssue | null;
  trackedClip: Pick<ClipResponse, "id" | "status"> | null;
}

interface IngestionRetryState {
  videoId: string | null;
  failureKey: string | null;
  phase: "idle" | "activating" | "failed";
  issue: ActiveVideoIssue | null;
}

const idleIngestionRetryState: IngestionRetryState = {
  videoId: null,
  failureKey: null,
  phase: "idle",
  issue: null,
};

type AcquisitionAction =
  | { type: "select-mode"; mode: ActiveVideoSourceMode }
  | { type: "edit-youtube-url"; value: string }
  | {
      type: "observe-youtube-metadata";
      title: string;
      durationSeconds: number;
    }
  | { type: "select-upload"; file: File | null }
  | { type: "set-max-upload-bytes"; maxUploadBytes: number }
  | {
      type: "set-operation";
      phase: AcquisitionState["phase"];
      progress?: string | null;
      issue?: ActiveVideoIssue | null;
      preparedSource?: ClipSource | null;
    }
  | { type: "load-active-source"; source: ClipSource }
  | { type: "track-clip"; clip: Pick<ClipResponse, "id" | "status"> }
  | { type: "reset"; mode: ActiveVideoSourceMode };

function initialAcquisitionState(mode: ActiveVideoSourceMode): AcquisitionState {
  return {
    mode,
    youtubeUrl: "",
    youtubeMetadata: { title: "", durationSeconds: 0 },
    file: null,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    phase: "idle",
    progress: null,
    preparedSource: null,
    issue: null,
    trackedClip: null,
  };
}

function acquisitionReducer(
  state: AcquisitionState,
  action: AcquisitionAction,
): AcquisitionState {
  switch (action.type) {
    case "select-mode":
      return {
        ...initialAcquisitionState(action.mode),
        trackedClip: state.trackedClip,
      };
    case "edit-youtube-url":
      return {
        ...state,
        youtubeUrl: action.value,
        file: null,
        progress: null,
        preparedSource: null,
        issue: null,
        phase: "idle",
      };
    case "observe-youtube-metadata":
      if (
        state.youtubeMetadata.title === action.title &&
        state.youtubeMetadata.durationSeconds === action.durationSeconds
      ) {
        return state;
      }
      return {
        ...state,
        youtubeMetadata: {
          title: action.title,
          durationSeconds: action.durationSeconds,
        },
      };
    case "select-upload":
      return {
        ...state,
        file: action.file,
        youtubeUrl: "",
        progress: null,
        preparedSource: null,
        issue: null,
        phase: "idle",
      };
    case "set-max-upload-bytes":
      return { ...state, maxUploadBytes: action.maxUploadBytes };
    case "set-operation":
      return {
        ...state,
        phase: action.phase,
        ...(action.progress !== undefined ? { progress: action.progress } : {}),
        ...(action.issue !== undefined ? { issue: action.issue } : {}),
        ...(action.preparedSource !== undefined
          ? { preparedSource: action.preparedSource }
          : {}),
      };
    case "load-active-source":
      if (
        state.file === null &&
        state.phase === "idle" &&
        state.progress === null &&
        state.issue === null &&
        state.preparedSource?.type === action.source.type &&
        (action.source.type === "youtube"
          ? state.preparedSource.type === "youtube" &&
            state.preparedSource.url === action.source.url &&
            state.youtubeUrl === action.source.url
          : state.preparedSource.type === "upload" &&
            state.preparedSource.key === action.source.key)
      ) {
        return state;
      }
      return {
        ...state,
        mode: action.source.type,
        youtubeUrl: action.source.type === "youtube" ? action.source.url : "",
        file: null,
        progress: null,
        preparedSource: action.source,
        issue: null,
        phase: "idle",
      };
    case "track-clip":
      return { ...state, trackedClip: action.clip };
    case "reset":
      return initialAcquisitionState(action.mode);
  }
}

function issue(
  area: ActiveVideoIssue["area"],
  error: unknown,
  retryable = true,
): ActiveVideoIssue {
  return {
    area,
    code: error instanceof Error ? error.name || "error" : "error",
    message: error instanceof Error ? error.message : "Unexpected failure",
    retryable,
  };
}

function retryableIngestionFailureKey(
  video: SourceVideoResponse,
): string | null {
  const ingestion = video.remoteIngestion;
  if (
    ingestion?.status !== "failed" ||
    !ingestion.failure?.retryable
  ) {
    return null;
  }
  return `${ingestion.failure.code}\u0000${ingestion.failure.message}`;
}

function isRefreshRequired(
  detail: SourceVideoDetailResponse | undefined,
  trackedClip: Pick<ClipResponse, "id" | "status"> | null,
): boolean {
  if (!detail) return false;
  const ingestionStatus = detail.video.remoteIngestion?.status;
  if (ingestionStatus === "pending" || ingestionStatus === "importing") {
    return true;
  }
  if (
    detail.video.activeClipCount > 0 ||
    detail.clips.some((clip) => !isTerminalStatus(clip.status))
  ) {
    return true;
  }
  if (!trackedClip) return false;
  const returnedClip = detail.clips.find(({ id }) => id === trackedClip.id);
  return !isTerminalStatus(returnedClip?.status ?? trackedClip.status);
}

interface UseActiveVideoLifecycleOptions {
  gateway?: ActiveVideoGateway;
  settleMs?: number;
}

export function useActiveVideoLifecycle(
  options: UseActiveVideoLifecycleOptions = {},
): ActiveVideoLifecycle {
  const gateway = options.gateway ?? productionActiveVideoGateway;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const videoId = searchParams.get("video") ?? "";
  const sourceHint = searchParams.get("source");
  const [acquisition, dispatch] = useReducer(
    acquisitionReducer,
    sourceHint === "upload" ? "upload" : "upload",
    initialAcquisitionState,
  );
  const [ingestionRetry, setIngestionRetry] = useState<IngestionRetryState>(
    idleIngestionRetryState,
  );
  const acquisitionRef = useRef(acquisition);
  acquisitionRef.current = acquisition;
  const operationGeneration = useRef(0);
  const activationKey = useRef<string | null>(null);
  const durationUpdateKey = useRef<string | null>(null);
  const ingestionRetryVideoId = useRef<string | null>(null);
  const previousVideoId = useRef(videoId);
  const currentVideoId = useRef(videoId);
  currentVideoId.current = videoId;
  const committedActivationId = useRef<string | null>(null);
  const metadata = useRef(acquisition.youtubeMetadata);
  metadata.current = acquisition.youtubeMetadata;

  useEffect(
    () => () => {
      operationGeneration.current += 1;
      activationKey.current = null;
    },
    [],
  );

  const detailQuery = useQuery({
    queryKey: sourceVideoQueryKey(videoId),
    queryFn: () => gateway.load(videoId),
    enabled: Boolean(videoId),
    refetchInterval: (query) =>
      isRefreshRequired(query.state.data, acquisition.trackedClip)
        ? 1000
        : false,
  });

  const detail =
    detailQuery.data?.video.id === videoId ? detailQuery.data : undefined;
  const mismatchedDetail =
    Boolean(videoId) &&
    Boolean(detailQuery.data) &&
    detailQuery.data?.video.id !== videoId;

  const active: ActiveVideoSelection = !videoId
    ? { status: "none", id: null }
    : mismatchedDetail
        ? {
            status: "failed",
            id: videoId,
            issue: {
              area: "load",
              code: "video_mismatch",
              message: "The loaded Video does not match the active Video.",
              retryable: true,
            },
          }
        : detail
          ? {
              status: "ready",
              id: videoId,
              video: detail.video,
              clips: detail.clips,
            }
          : detailQuery.error
            ? {
                status: "failed",
                id: videoId,
                issue: issue("load", detailQuery.error),
              }
          : { status: "loading", id: videoId };
  const activeRef = useRef(active);
  activeRef.current = active;
  const activeRetryableFailureKey =
    active.status === "ready"
      ? retryableIngestionFailureKey(active.video)
      : null;

  useEffect(() => {
    if (
      ingestionRetry.phase === "idle" ||
      ingestionRetry.videoId !== videoId ||
      active.status !== "ready" ||
      ingestionRetry.failureKey === activeRetryableFailureKey
    ) {
      return;
    }
    setIngestionRetry(idleIngestionRetryState);
  }, [
    active.status,
    activeRetryableFailureKey,
    ingestionRetry.failureKey,
    ingestionRetry.phase,
    ingestionRetry.videoId,
    videoId,
  ]);

  const trimmedYoutubeUrl = acquisition.youtubeUrl.trim();
  const youtubeVideoId = isValidYoutubeUrl(trimmedYoutubeUrl)
    ? extractYoutubeVideoId(trimmedYoutubeUrl)
    : null;
  const youtubeValidity: ActiveVideoManualSourceView["youtubeValidity"] =
    trimmedYoutubeUrl.length === 0
      ? "empty"
      : youtubeVideoId
        ? "valid"
        : "invalid";

  const previewUrl = useMemo(
    () => (acquisition.file ? URL.createObjectURL(acquisition.file) : null),
    [acquisition.file],
  );

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    const priorVideoId = previousVideoId.current;
    previousVideoId.current = videoId;
    if (priorVideoId === videoId) return;

    operationGeneration.current += 1;
    activationKey.current = null;
    setIngestionRetry(idleIngestionRetryState);
    if (!videoId) {
      committedActivationId.current = null;
      dispatch({
        type: "reset",
        mode: sourceHint === "upload" ? "upload" : "upload",
      });
      return;
    }

    if (committedActivationId.current !== videoId) {
      dispatch({
        type: "reset",
        mode: sourceHint === "upload" ? "upload" : "upload",
      });
    }
    committedActivationId.current = null;
  }, [sourceHint, videoId]);

  useEffect(() => {
    if (active.status !== "ready") return;
    dispatch({ type: "load-active-source", source: active.video.source });
  }, [active.status, active.status === "ready" ? active.video : null]);

  const commitActivation = useCallback(
    (activatedVideoId: string) => {
      committedActivationId.current = activatedVideoId;
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("video", activatedVideoId);
          next.delete("source");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const activateYoutube = useCallback(
    async (
      expectedGeneration: number,
      expectedKey: string,
      expectedRouteVideoId: string,
    ): Promise<ActiveVideoResult> => {
      const currentMetadata = metadata.current;
      dispatch({
        type: "set-operation",
        phase: "activating",
        progress: null,
        issue: null,
      });
      try {
        const request: CreateSourceVideoRequest = {
          source: { type: "youtube", url: trimmedYoutubeUrl },
          title:
            currentMetadata.title || `YouTube video ${youtubeVideoId ?? ""}`,
          ...(currentMetadata.durationSeconds > 0
            ? {
                durationSeconds:
                  Math.round(currentMetadata.durationSeconds * 1000) / 1000,
              }
            : {}),
        };
        const video = await gateway.create(request);
        if (
          operationGeneration.current !== expectedGeneration ||
          activationKey.current !== expectedKey ||
          currentVideoId.current !== expectedRouteVideoId
        ) {
          return { ok: false, outcome: "superseded" };
        }
        dispatch({
          type: "set-operation",
          phase: "idle",
          preparedSource: request.source,
          issue: null,
        });
        commitActivation(video.id);
        return { ok: true, outcome: "activated" };
      } catch (error) {
        if (
          operationGeneration.current !== expectedGeneration ||
          activationKey.current !== expectedKey ||
          currentVideoId.current !== expectedRouteVideoId
        ) {
          return { ok: false, outcome: "superseded" };
        }
        activationKey.current = null;
        const problem = issue("activation", error);
        dispatch({
          type: "set-operation",
          phase: "failed",
          issue: problem,
          progress: null,
        });
        return { ok: false, outcome: "failed", issue: problem };
      }
    },
    [commitActivation, gateway, trimmedYoutubeUrl, youtubeVideoId],
  );

  useEffect(() => {
    if (
      videoId ||
      acquisition.mode !== "youtube" ||
      youtubeValidity !== "valid" ||
      !youtubeVideoId
    ) {
      return;
    }
    const key = `youtube:${youtubeVideoId}`;
    if (activationKey.current === key) return;
    const generation = operationGeneration.current;
    const expectedRouteVideoId = currentVideoId.current;
    dispatch({
      type: "set-operation",
      phase: "settling",
      issue: null,
      progress: null,
    });
    const timeout = window.setTimeout(() => {
      if (
        operationGeneration.current !== generation ||
        currentVideoId.current !== expectedRouteVideoId
      ) {
        return;
      }
      activationKey.current = key;
      void activateYoutube(generation, key, expectedRouteVideoId);
    }, settleMs);
    return () => window.clearTimeout(timeout);
  }, [
    acquisition.mode,
    activateYoutube,
    settleMs,
    videoId,
    youtubeValidity,
    youtubeVideoId,
  ]);

  const uploadAndActivate = useCallback(
    async (
      file: File,
      generation: number,
      expectedRouteVideoId: string,
    ): Promise<ActiveVideoResult> => {
      const isCurrent = () =>
        operationGeneration.current === generation &&
        currentVideoId.current === expectedRouteVideoId;
      const fail = (problem: ActiveVideoIssue): ActiveVideoResult => {
        dispatch({
          type: "set-operation",
          phase: "failed",
          issue: problem,
          progress: null,
        });
        return { ok: false, outcome: "failed", issue: problem };
      };
      const validationError = validateUploadFile(
        file,
        acquisitionRef.current.maxUploadBytes,
      );
      if (validationError) {
        return fail(issue("upload", new Error(validationError), false));
      }
      const contentType = contentTypeForFile(file);
      if (!contentType) {
        return fail(
          issue("upload", new Error("Unsupported video file type"), false),
        );
      }

      try {
        dispatch({
          type: "set-operation",
          phase: "uploading",
          progress: "Preparing upload…",
          issue: null,
        });
        const slot = await gateway.requestUpload({
          contentType,
          sizeBytes: file.size,
          filename: file.name,
        });
        if (!isCurrent()) {
          return { ok: false, outcome: "superseded" };
        }
        dispatch({
          type: "set-max-upload-bytes",
          maxUploadBytes: slot.maxSizeBytes,
        });
        const slotValidation = validateUploadFile(file, slot.maxSizeBytes);
        if (slotValidation) {
          return fail(issue("upload", new Error(slotValidation), false));
        }

        await gateway.upload(
          slot.uploadUrl,
          file,
          slot.contentType,
          (loaded, total) => {
            if (isCurrent()) {
              dispatch({
                type: "set-operation",
                phase: "uploading",
                progress: formatUploadProgress(loaded, total),
              });
            }
          },
        );
        if (!isCurrent()) {
          return { ok: false, outcome: "superseded" };
        }

        const source: ClipSource = { type: "upload", key: slot.key };
        dispatch({
          type: "set-operation",
          phase: "activating",
          progress: "Upload complete",
          preparedSource: source,
          issue: null,
        });
        const video = await gateway.create({
          source,
          title: deriveUploadClipTitle(file.name),
        });
        if (!isCurrent()) {
          return { ok: false, outcome: "superseded" };
        }
        dispatch({
          type: "set-operation",
          phase: "idle",
          progress: "Upload complete",
          preparedSource: source,
          issue: null,
        });
        commitActivation(video.id);
        return { ok: true, outcome: "activated" };
      } catch (error) {
        if (!isCurrent()) {
          return { ok: false, outcome: "superseded" };
        }
        return fail(issue("upload", error));
      }
    },
    [commitActivation, gateway],
  );

  const perform = useCallback(
    async (command: ActiveVideoCommand): Promise<ActiveVideoResult> => {
      switch (command.type) {
        case "source-mode-changed":
          operationGeneration.current += 1;
          activationKey.current = null;
          setIngestionRetry(idleIngestionRetryState);
          dispatch({ type: "select-mode", mode: command.mode });
          return { ok: true, outcome: "applied" };
        case "youtube-url-changed":
          operationGeneration.current += 1;
          activationKey.current = null;
          setIngestionRetry(idleIngestionRetryState);
          dispatch({ type: "edit-youtube-url", value: command.value });
          return { ok: true, outcome: "scheduled" };
        case "youtube-metadata-observed":
          dispatch({
            type: "observe-youtube-metadata",
            title: command.title,
            durationSeconds: command.durationSeconds,
          });
          return { ok: true, outcome: "applied" };
        case "upload-selected": {
          const generation = operationGeneration.current + 1;
          operationGeneration.current = generation;
          activationKey.current = null;
          setIngestionRetry(idleIngestionRetryState);
          dispatch({ type: "select-upload", file: command.file });
          if (!command.file) return { ok: true, outcome: "applied" };
          return uploadAndActivate(
            command.file,
            generation,
            currentVideoId.current,
          );
        }
        case "retry-upload": {
          const file = acquisitionRef.current.file;
          if (!file) return { ok: true, outcome: "noop" };
          const generation = operationGeneration.current + 1;
          operationGeneration.current = generation;
          setIngestionRetry(idleIngestionRetryState);
          return uploadAndActivate(file, generation, currentVideoId.current);
        }
        case "retry-ingestion": {
          const currentActive = activeRef.current;
          if (currentActive.status !== "ready") {
            return { ok: true, outcome: "noop" };
          }
          const failureKey = retryableIngestionFailureKey(currentActive.video);
          if (!failureKey) return { ok: true, outcome: "noop" };
          const expectedVideoId = currentActive.id;
          if (ingestionRetryVideoId.current === expectedVideoId) {
            return { ok: true, outcome: "noop" };
          }
          ingestionRetryVideoId.current = expectedVideoId;
          const generation = operationGeneration.current;
          setIngestionRetry({
            videoId: expectedVideoId,
            failureKey,
            phase: "activating",
            issue: null,
          });
          try {
            await gateway.retryIngestion(expectedVideoId);
            if (
              operationGeneration.current !== generation ||
              currentVideoId.current !== expectedVideoId
            ) {
              return { ok: false, outcome: "superseded" };
            }
            setIngestionRetry({
              videoId: expectedVideoId,
              failureKey,
              phase: "idle",
              issue: null,
            });
            window.setTimeout(
              () =>
                void queryClient.invalidateQueries({
                  queryKey: sourceVideoQueryKey(expectedVideoId),
                }),
              250,
            );
            return { ok: true, outcome: "applied" };
          } catch (error) {
            if (
              operationGeneration.current !== generation ||
              currentVideoId.current !== expectedVideoId
            ) {
              return { ok: false, outcome: "superseded" };
            }
            const problem = issue("ingestion-retry", error);
            setIngestionRetry({
              videoId: expectedVideoId,
              failureKey,
              phase: "failed",
              issue: problem,
            });
            return { ok: false, outcome: "failed", issue: problem };
          } finally {
            if (ingestionRetryVideoId.current === expectedVideoId) {
              ingestionRetryVideoId.current = null;
            }
          }
        }
        case "active-duration-observed": {
          const currentActive = activeRef.current;
          if (
            command.videoId !== currentVideoId.current ||
            currentActive.status !== "ready" ||
            command.durationSeconds <= 0 ||
            (currentActive.video.durationSeconds !== null &&
              Math.abs(
                currentActive.video.durationSeconds - command.durationSeconds,
              ) <
                0.01)
          ) {
            return { ok: true, outcome: "noop" };
          }
          const normalizedDuration =
            Math.round(command.durationSeconds * 1000) / 1000;
          const key = `${command.videoId}:${normalizedDuration}`;
          if (durationUpdateKey.current === key) {
            return { ok: true, outcome: "noop" };
          }
          durationUpdateKey.current = key;
          try {
            await gateway.updateDuration(command.videoId, normalizedDuration);
            return { ok: true, outcome: "applied" };
          } catch (error) {
            durationUpdateKey.current = null;
            return {
              ok: false,
              outcome: "failed",
              issue: issue("duration-sync", error),
            };
          }
        }
        case "clip-created":
          if (command.videoId !== currentVideoId.current) {
            return { ok: true, outcome: "noop" };
          }
          dispatch({ type: "track-clip", clip: command.clip });
          if (command.videoId) {
            void queryClient.invalidateQueries({
              queryKey: sourceVideoQueryKey(command.videoId),
            });
          }
          return { ok: true, outcome: "applied" };
        case "clear":
          operationGeneration.current += 1;
          activationKey.current = null;
          committedActivationId.current = null;
          dispatch({ type: "reset", mode: "upload" });
          setSearchParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.delete("video");
              next.delete("source");
              return next;
            },
            { replace: true },
          );
          return { ok: true, outcome: "cleared" };
      }
    },
    [
      gateway,
      queryClient,
      setSearchParams,
      uploadAndActivate,
    ],
  );

  const refreshRequired = isRefreshRequired(detail, acquisition.trackedClip);
  const activeVideo = active.status === "ready" ? active.video : null;
  const retainedRemoteReady = Boolean(
    activeVideo?.source.type === "youtube" &&
      activeVideo.retainedSourceReady &&
      (!activeVideo.remoteIngestion ||
        activeVideo.remoteIngestion.status === "ready"),
  );
  const uploadPreviewUrl =
    acquisition.issue?.area === "upload" && !acquisition.issue.retryable
      ? null
      : previewUrl;
  const preview: ActiveVideoPreview =
    activeVideo &&
    (activeVideo.source.type === "upload" || retainedRemoteReady)
      ? { type: "native", url: sourceVideoUploadUrl(activeVideo.id) }
      : acquisition.mode === "youtube" && youtubeVideoId
        ? { type: "youtube", videoId: youtubeVideoId }
        : acquisition.mode === "upload" && uploadPreviewUrl
          ? { type: "native", url: uploadPreviewUrl }
          : { type: "none" };
  const readyForClip = activeVideo
    ? activeVideo.source.type === "upload" || retainedRemoteReady
    : acquisition.preparedSource?.type === "upload";
  const activeIngestionRetry =
    active.status === "ready" &&
    ingestionRetry.videoId === active.id &&
    ingestionRetry.failureKey === activeRetryableFailureKey
      ? ingestionRetry
      : idleIngestionRetryState;
  const view = useMemo<ActiveVideoView>(
    () => ({
      active,
      manualSource: {
        mode: acquisition.mode,
        youtubeUrl: acquisition.youtubeUrl,
        youtubeVideoId,
        youtubeValidity,
        upload:
          acquisition.file && previewUrl
            ? {
                fileName: acquisition.file.name,
                sizeBytes: acquisition.file.size,
                previewUrl: uploadPreviewUrl,
              }
            : null,
        phase:
          activeIngestionRetry.phase === "idle"
            ? acquisition.phase
            : activeIngestionRetry.phase,
        progress: acquisition.progress,
        preparedSource: acquisition.preparedSource,
        issue: activeIngestionRetry.issue ?? acquisition.issue,
      },
      pendingYoutubeVideoId:
        !videoId && acquisition.mode === "youtube" ? youtubeVideoId : null,
      preview,
      readyForClip,
      refresh: refreshRequired ? "polling" : "idle",
      refreshIssue:
        detail && detailQuery.error ? issue("load", detailQuery.error) : null,
    }),
    [
      acquisition,
      active,
      activeIngestionRetry,
      preview,
      readyForClip,
      refreshRequired,
      uploadPreviewUrl,
      videoId,
      youtubeValidity,
      youtubeVideoId,
    ],
  );

  return useMemo(() => ({ view, perform }), [perform, view]);
}
