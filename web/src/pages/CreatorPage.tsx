import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSourceVideo,
  getVideoTranscript,
  getPreparedLibraryMomentReview,
  getPreparedVisualMomentReview,
  validateCaptionTrackProposal,
} from "../api";
import { createClipProposalReview } from "../create-clip-proposal-review";
import { CreatorForm } from "../components/CreatorForm";
import { StatusPanel } from "../components/StatusPanel";
import { VideoAgentChat } from "../components/VideoAgentChat";
import { CaptionEditorModal } from "../components/CaptionEditorModal";
import { VisualMomentSearchPanel } from "../components/VisualMomentSearchPanel";
import {
  CLIPS_QUERY_KEY,
  sourceVideoQueryKey,
  SOURCE_VIDEOS_QUERY_KEY,
} from "../queries";
import { useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PreparedClipProposalHandoff } from "../clip-proposal-review";
import { useWebMcpClipTools } from "../hooks/useWebMcpClipTools";
import { useWebMcpVisualTools } from "../hooks/useWebMcpVisualTools";
import {
  getOwnedUploadClipJourneyView,
  INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  type OwnedUploadClipReference,
  updateOwnedUploadClipJourney,
} from "../owned-upload-clip-journey";
import { isTerminalStatus } from "../status";
import type {
  ClipWindowRequest,
  TimestampWindow,
} from "../timestamp-windows";
import { toExistingClipRanges } from "../timeline";
import type {
  CaptionTrackProposal,
  CaptionTrackProposalInput,
  ClipResponse,
} from "../types";

export function CreatorPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const videoId = searchParams.get("video") ?? "";
  const libraryProposalId = searchParams.get("libraryProposal") ?? "";
  const visualProposalId = searchParams.get("visualProposal") ?? "";
  const [ownedUploadJourneyState, updateOwnedUploadJourney] = useReducer(
    updateOwnedUploadClipJourney,
    INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  );
  const clipWindowSequence = useRef(0);
  const [proposalReview] = useState(createClipProposalReview);
  const [preparedProposalError, setPreparedProposalError] = useState<string | null>(null);
  const [clipWindowRequest, setClipWindowRequest] =
    useState<ClipWindowRequest | null>(null);
  const [pendingYoutubeVideoId, setPendingYoutubeVideoId] = useState<
    string | null
  >(null);
  const [captionReview, setCaptionReview] = useState<{
    clip: ClipResponse;
    proposal: CaptionTrackProposal;
  } | null>(null);
  const { data: sourceVideoData } = useQuery({
    queryKey: sourceVideoQueryKey(videoId),
    queryFn: () => getSourceVideo(videoId),
    enabled: Boolean(videoId),
    refetchInterval: (query) => {
      const clips = query.state.data?.clips ?? [];
      const trackedStatus = ownedUploadJourneyState.createdClip?.status;
      const trackedClip = trackedStatus
        ? clips.find(
            ({ id }) => id === ownedUploadJourneyState.createdClip?.id,
          )
        : null;
      const trackedClipInFlight = trackedClip
        ? !isTerminalStatus(trackedClip.status)
        : trackedStatus
          ? !isTerminalStatus(trackedStatus)
          : false;
      return clips.some((clip) => !isTerminalStatus(clip.status)) ||
        trackedClipInFlight
        ? 1000
        : false;
    },
  });
  const {
    data: transcript = null,
    error: transcriptError,
  } = useQuery({
    queryKey: ["video-transcript", videoId],
    queryFn: () => getVideoTranscript(videoId),
    enabled: Boolean(videoId),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const result = query.state.data;
      return result?.transcriptStatus === "checking"
        ? result.retryAfterMs
        : false;
    },
  });
  const {
    data: preparedVisualProposal,
    error: preparedVisualProposalError,
  } = useQuery({
    queryKey: ["visual-moment-proposal", visualProposalId],
    queryFn: () => getPreparedVisualMomentReview(visualProposalId),
    enabled: Boolean(visualProposalId),
    retry: false,
  });
  const {
    data: preparedLibraryProposal,
    error: preparedLibraryProposalError,
  } = useQuery({
    queryKey: ["library-moment-proposal", libraryProposalId],
    queryFn: () => getPreparedLibraryMomentReview(libraryProposalId),
    enabled: Boolean(libraryProposalId),
    retry: false,
  });

  const activeVideo =
    sourceVideoData?.video.id === videoId ? sourceVideoData.video : null;
  const ownedUploadJourney = getOwnedUploadClipJourneyView({
    state: ownedUploadJourneyState,
    video: activeVideo,
    clips: sourceVideoData?.clips ?? [],
  });

  useEffect(() => {
    updateOwnedUploadJourney({
      type: "source-changed",
      sourceVideoId: videoId || null,
    });
  }, [videoId]);

  useEffect(() => {
    if (!activeVideo) {
      setPreparedProposalError(null);
      return;
    }
    if (
      libraryProposalId &&
      !preparedLibraryProposal &&
      !preparedLibraryProposalError
    ) {
      setPreparedProposalError(null);
      return;
    }
    const handoffs: Array<{
      parameter: "libraryProposal" | "visualProposal";
      handoff: PreparedClipProposalHandoff;
    }> = [];
    if (preparedLibraryProposal) {
      handoffs.push({
        parameter: "libraryProposal",
        handoff: {
          adapter: "library",
          requestId: preparedLibraryProposal.proposalId,
          videoId: preparedLibraryProposal.videoId,
          proposalId: preparedLibraryProposal.searchResultId,
          input: { ...preparedLibraryProposal.input },
          evidence: { ...preparedLibraryProposal.evidence },
        },
      });
    }
    if (preparedVisualProposal) {
      handoffs.push({
        parameter: "visualProposal",
        handoff: {
          adapter: "visual",
          requestId: preparedVisualProposal.proposalId,
          videoId: preparedVisualProposal.videoId,
          proposalId: preparedVisualProposal.searchResultId,
          input: { ...preparedVisualProposal.input },
          evidence: { ...preparedVisualProposal.evidence },
        },
      });
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    const errors: string[] = [];
    let consumed = false;
    for (const candidate of handoffs) {
      const result = proposalReview.intakePrepared(
        { id: activeVideo.id, durationSeconds: activeVideo.durationSeconds },
        candidate.handoff,
      );
      if (result.consumable) {
        nextSearchParams.delete(candidate.parameter);
        consumed = true;
      } else {
        errors.push(...result.issues.map((issue) => issue.message));
      }
    }

    setPreparedProposalError(errors.length > 0 ? errors.join(" ") : null);
    if (consumed) setSearchParams(nextSearchParams, { replace: true });
  }, [
    activeVideo,
    libraryProposalId,
    preparedLibraryProposal,
    preparedLibraryProposalError,
    preparedVisualProposal,
    proposalReview,
    searchParams,
    setSearchParams,
  ]);
  const openCaptionProposal = useCallback(
    async (
      input: CaptionTrackProposalInput,
      source: "think" | "webmcp" = "think",
    ) => {
      const clip = sourceVideoData?.clips.find(
        (candidate) => candidate.id === input.clipId,
      );
      if (!clip || clip.status !== "complete") {
        throw new Error("Choose a completed clip from the current video");
      }
      const proposal = await validateCaptionTrackProposal(clip.id, {
        source,
        baseRevision: input.baseRevision,
        cues: input.cues,
        theme: input.theme,
      });
      setCaptionReview({ clip, proposal });
      return proposal;
    },
    [sourceVideoData?.clips],
  );

  useWebMcpClipTools({
    video: activeVideo,
    clips: sourceVideoData?.clips ?? [],
    transcript,
    transcriptError: transcriptError?.message ?? null,
    review: proposalReview,
    onCaptionProposal: (input) => openCaptionProposal(input, "webmcp"),
  });
  useWebMcpVisualTools(
    activeVideo?.source.type === "upload" ? activeVideo.id : null,
  );

  const handleClipCreated = (clip: OwnedUploadClipReference) => {
    if (videoId) {
      updateOwnedUploadJourney({
        type: "clip-created",
        sourceVideoId: videoId,
        clip,
      });
    }
    void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["source-video"] });
  };

  const handleVideoActivated = (activatedVideoId: string) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("video", activatedVideoId);
    nextSearchParams.delete("source");
    setSearchParams(nextSearchParams, { replace: true });
  };

  const handleTimestampSelect = (window: TimestampWindow) => {
    clipWindowSequence.current += 1;
    setClipWindowRequest({
      ...window,
      requestId: clipWindowSequence.current,
    });
  };
  const existingClips = toExistingClipRanges(
    activeVideo ? sourceVideoData?.clips : undefined,
  );
  const handleVisualProposalPrepared = (proposalId: string) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("visualProposal", proposalId);
    setSearchParams(nextSearchParams);
  };

  return (
    <main className="app-main">
      {(preparedLibraryProposalError || preparedVisualProposalError || preparedProposalError) && (
        <p className="form-error library-proposal-error" role="alert">
          {preparedProposalError ?? preparedLibraryProposalError?.message ?? preparedVisualProposalError?.message}
        </p>
      )}
      <CreatorForm
        onClipCreated={handleClipCreated}
        onVideoActivated={handleVideoActivated}
        onPendingYoutubeVideoChange={setPendingYoutubeVideoId}
        clipWindowRequest={clipWindowRequest}
        ownedUploadJourney={ownedUploadJourney}
      />
      {activeVideo?.source.type === "upload" && (
        <VisualMomentSearchPanel
          videoId={activeVideo.id}
          onPrepared={handleVisualProposalPrepared}
        />
      )}
      <VideoAgentChat
        videoId={videoId}
        pendingYoutubeVideoId={pendingYoutubeVideoId}
        source={activeVideo?.source}
        retainedSourceReady={activeVideo?.retainedSourceReady ?? false}
        videoDurationSeconds={activeVideo?.durationSeconds ?? null}
        onClipCreated={handleClipCreated}
        onTimestampSelect={handleTimestampSelect}
        existingClips={existingClips}
        proposalReview={proposalReview}
        onCaptionProposal={openCaptionProposal}
      />
      <StatusPanel
        excludeVideoId={
          activeVideo?.source.type === "upload" ? videoId : undefined
        }
        includeBlockedFailureVideoId={
          activeVideo?.source.type === "youtube" ? videoId : undefined
        }
      />
      {captionReview && (
        <CaptionEditorModal
          clip={captionReview.clip}
          initialProposal={captionReview.proposal}
          onClose={() => setCaptionReview(null)}
        />
      )}
    </main>
  );
}
