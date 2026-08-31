import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getVideoTranscript,
  validateCaptionTrackProposal,
} from "../api";
import { useActiveVideoLifecycle } from "../active-video-lifecycle";
import { useClipProposalReviewIntake } from "../clip-proposal-review-intake";
import { createClipProposalReview } from "../create-clip-proposal-review";
import { CreatorForm } from "../components/CreatorForm";
import { CreatorWorkspaceAskCarpo } from "../components/CreatorWorkspaceAskCarpo";
import { CreatorWorkspaceSourceRibbon } from "../components/CreatorWorkspaceSourceRibbon";
import { StatusPanel } from "../components/StatusPanel";
import { VideoAgentChat } from "../components/VideoAgentChat";
import { CaptionEditorModal } from "../components/CaptionEditorModal";
import { VisualMomentSearchPanel } from "../components/VisualMomentSearchPanel";
import {
  CLIPS_QUERY_KEY,
  SOURCE_VIDEOS_QUERY_KEY,
} from "../queries";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useWebMcpClipTools } from "../hooks/useWebMcpClipTools";
import { useWebMcpVisualTools } from "../hooks/useWebMcpVisualTools";
import {
  getOwnedUploadClipJourneyView,
  INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  type OwnedUploadClipReference,
  updateOwnedUploadClipJourney,
} from "../owned-upload-clip-journey";
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
  const activeVideoLifecycle = useActiveVideoLifecycle();
  const { active, pendingYoutubeVideoId } = activeVideoLifecycle.view;
  const videoId = active.id ?? "";
  const [ownedUploadJourneyState, updateOwnedUploadJourney] = useReducer(
    updateOwnedUploadClipJourney,
    INITIAL_OWNED_UPLOAD_CLIP_JOURNEY_STATE,
  );
  const clipWindowSequence = useRef(0);
  const [proposalReview] = useState(createClipProposalReview);
  const [clipWindowRequest, setClipWindowRequest] =
    useState<ClipWindowRequest | null>(null);
  const [captionReview, setCaptionReview] = useState<{
    clip: ClipResponse;
    proposal: CaptionTrackProposal;
  } | null>(null);
  const sourceVideoData =
    active.status === "ready"
      ? { video: active.video, clips: active.clips }
      : undefined;
  const activeVideo = active.status === "ready" ? active.video : null;
  const activeClips = active.status === "ready" ? active.clips : [];
  const proposalIntake = useClipProposalReviewIntake({
    activeVideo: activeVideo
      ? { id: activeVideo.id, durationSeconds: activeVideo.durationSeconds }
      : null,
    review: proposalReview,
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
  const ownedUploadJourney = getOwnedUploadClipJourneyView({
    state: ownedUploadJourneyState,
    video: activeVideo,
    clips: activeClips,
  });

  useEffect(() => {
    updateOwnedUploadJourney({
      type: "source-changed",
      sourceVideoId: videoId || null,
    });
  }, [videoId]);

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
    clips: activeClips,
    transcript,
    transcriptError: transcriptError?.message ?? null,
    review: proposalReview,
    onCaptionProposal: (input) => openCaptionProposal(input, "webmcp"),
  });
  useWebMcpVisualTools(
    activeVideo?.source.type === "upload" ? activeVideo.id : null,
  );

  const handleClipCreated = (clip: OwnedUploadClipReference) => {
    const clipVideoId =
      "videoId" in clip && typeof clip.videoId === "string"
        ? clip.videoId
        : videoId;
    if (clipVideoId && clipVideoId === videoId) {
      updateOwnedUploadJourney({
        type: "clip-created",
        sourceVideoId: clipVideoId,
        clip,
      });
    }
    void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
    void activeVideoLifecycle.perform({
      type: "clip-created",
      videoId: clipVideoId,
      clip,
    });
  };

  const handleTimestampSelect = (window: TimestampWindow) => {
    clipWindowSequence.current += 1;
    setClipWindowRequest({
      ...window,
      requestId: clipWindowSequence.current,
    });
  };
  const existingClips = toExistingClipRanges(
    activeVideo ? activeClips : undefined,
  );
  return (
    <main className="app-main">
      {proposalIntake.view.issues.length > 0 && (
        <p className="form-error library-proposal-error" role="alert">
          {proposalIntake.view.issues.map((issue) => issue.message).join(" ")}
        </p>
      )}
      {activeVideo && (
        <CreatorWorkspaceSourceRibbon
          source={{
            title: activeVideo.title,
            sourceType: activeVideo.source.type,
            durationSeconds: activeVideo.durationSeconds,
            thumbnailUrl: activeVideo.thumbnail,
          }}
          onChooseAnother={() =>
            void activeVideoLifecycle.perform({ type: "clear" })
          }
        />
      )}
      <CreatorForm
        activeVideoLifecycle={activeVideoLifecycle}
        onClipCreated={handleClipCreated}
        clipWindowRequest={clipWindowRequest}
        ownedUploadJourney={ownedUploadJourney}
      />
      {activeVideo?.source.type === "upload" ? (
        <section className="creator-secondary-tool" aria-label="Visual search">
          <VisualMomentSearchPanel
            videoId={activeVideo.id}
            onPrepared={proposalIntake.presentVisual}
          />
        </section>
      ) : null}
      <CreatorWorkspaceAskCarpo>
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
      </CreatorWorkspaceAskCarpo>
      <details className="creator-other-jobs">
        <summary>Other clip jobs</summary>
        <StatusPanel excludeVideoId={videoId || undefined} />
      </details>
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
