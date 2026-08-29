import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSourceVideo,
  getVideoTranscript,
  getPreparedLibraryMomentReview,
  validateCaptionTrackProposal,
} from "../api";
import { createClipProposalReview } from "../create-clip-proposal-review";
import { CreatorForm } from "../components/CreatorForm";
import { StatusPanel } from "../components/StatusPanel";
import { VideoAgentChat } from "../components/VideoAgentChat";
import { CaptionEditorModal } from "../components/CaptionEditorModal";
import {
  CLIPS_QUERY_KEY,
  sourceVideoQueryKey,
  SOURCE_VIDEOS_QUERY_KEY,
} from "../queries";
import { useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useWebMcpClipTools } from "../hooks/useWebMcpClipTools";
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
  const [ownedUploadJourneyState, updateOwnedUploadJourney] = useReducer(
    updateOwnedUploadClipJourney,
    INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  );
  const clipWindowSequence = useRef(0);
  const admittedLibraryProposals = useRef(new Set<string>());
  const [proposalReview] = useState(createClipProposalReview);
  const [libraryProposalError, setLibraryProposalError] = useState<string | null>(null);
  const [clipWindowRequest, setClipWindowRequest] =
    useState<ClipWindowRequest | null>(null);
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
    if (!preparedLibraryProposal || activeVideo?.id !== preparedLibraryProposal.videoId) {
      return;
    }
    if (admittedLibraryProposals.current.has(preparedLibraryProposal.proposalId)) {
      return;
    }
    proposalReview.activate({
      id: activeVideo.id,
      durationSeconds: activeVideo.durationSeconds,
    });
    const admission = proposalReview.admit({
      adapter: "library",
      requestId: preparedLibraryProposal.proposalId,
      videoId: preparedLibraryProposal.videoId,
      atomic: true,
      proposals: [
        {
          proposalId: preparedLibraryProposal.searchResultId,
          input: { ...preparedLibraryProposal.input },
          evidence: { ...preparedLibraryProposal.evidence },
          settle: () => undefined,
        },
      ],
    });
    const issues = [
      ...admission.issues,
      ...admission.items.flatMap((item) => item.issues),
    ];
    if (issues.length > 0) {
      setLibraryProposalError(issues.map((issue) => issue.message).join(" "));
      return;
    }
    admittedLibraryProposals.current.add(preparedLibraryProposal.proposalId);
    setLibraryProposalError(null);
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("libraryProposal");
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    activeVideo,
    preparedLibraryProposal,
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

  return (
    <main className="app-main">
      {(preparedLibraryProposalError || libraryProposalError) && (
        <p className="form-error library-proposal-error" role="alert">
          {libraryProposalError ?? preparedLibraryProposalError?.message}
        </p>
      )}
      <CreatorForm
        onClipCreated={handleClipCreated}
        onVideoActivated={handleVideoActivated}
        clipWindowRequest={clipWindowRequest}
        ownedUploadJourney={ownedUploadJourney}
      />
      <VideoAgentChat
        videoId={videoId}
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
