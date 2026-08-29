import type {
  ClipResponse,
  ClipStatus,
  SourceVideoResponse,
} from "./types";

export interface OwnedUploadClipReference {
  id: string;
  title: string;
  status: ClipStatus;
}

export interface OwnedUploadClipJourneyState {
  sourceVideoId: string | null;
  createdClip: OwnedUploadClipReference | null;
}

export type OwnedUploadClipJourneyEvent =
  | { type: "source-changed"; sourceVideoId: string | null }
  | {
      type: "clip-created";
      sourceVideoId: string;
      clip: OwnedUploadClipReference;
    };

export interface OwnedUploadClipJourneyView {
  sourceVideoId: string | null;
  phase: "inactive" | "editing" | "rendering" | "complete" | "failed";
  clip: ClipResponse | null;
  createdClip: OwnedUploadClipReference | null;
}

export const INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE: OwnedUploadClipJourneyState =
  {
    sourceVideoId: null,
    createdClip: null,
  };

export function deriveUploadClipTitle(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1)?.trim() ?? "";
  const withoutExtension = basename.replace(/\.(mp4|webm|mov|mkv)$/i, "");
  const readable = withoutExtension
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return readable || "Untitled clip";
}

export function updateOwnedUploadClipJourney(
  state: OwnedUploadClipJourneyState,
  event: OwnedUploadClipJourneyEvent,
): OwnedUploadClipJourneyState {
  if (event.type === "source-changed") {
    if (state.sourceVideoId === event.sourceVideoId) return state;
    return {
      sourceVideoId: event.sourceVideoId,
      createdClip: null,
    };
  }

  return {
    sourceVideoId: event.sourceVideoId,
    createdClip: event.clip,
  };
}

export function getOwnedUploadClipJourneyView(input: {
  state: OwnedUploadClipJourneyState;
  video: SourceVideoResponse | null;
  clips: readonly ClipResponse[];
}): OwnedUploadClipJourneyView {
  const { state, video, clips } = input;
  const ownsActiveSource =
    video?.source.type === "upload" && video.id === state.sourceVideoId;

  if (!ownsActiveSource) {
    return {
      sourceVideoId: null,
      phase: "inactive",
      clip: null,
      createdClip: null,
    };
  }

  const trackedClip = state.createdClip
    ? clips.find(({ id }) => id === state.createdClip?.id) ?? null
    : null;
  const latestClip = state.createdClip
    ? null
    : clips.reduce<ClipResponse | null>(
        (latest, candidate) =>
          !latest || candidate.createdAt > latest.createdAt
            ? candidate
            : latest,
        null,
      );
  const clip = trackedClip ?? latestClip;
  const createdClip = clip ?? state.createdClip;

  if (!createdClip) {
    return {
      sourceVideoId: video.id,
      phase: "editing",
      clip: null,
      createdClip: null,
    };
  }

  const phase =
    createdClip.status === "complete"
      ? "complete"
      : createdClip.status === "failed"
        ? "failed"
        : "rendering";

  return {
    sourceVideoId: video.id,
    phase,
    clip,
    createdClip,
  };
}
