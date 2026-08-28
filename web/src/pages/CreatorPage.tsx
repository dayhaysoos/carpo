import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSourceVideo, getVideoTranscript } from "../api";
import { createClipProposalReview } from "../create-clip-proposal-review";
import { CreatorForm } from "../components/CreatorForm";
import { StatusPanel } from "../components/StatusPanel";
import { VideoAgentChat } from "../components/VideoAgentChat";
import {
  CLIPS_QUERY_KEY,
  sourceVideoQueryKey,
  SOURCE_VIDEOS_QUERY_KEY,
} from "../queries";
import { useSearchParams } from "react-router-dom";
import { useRef, useState } from "react";
import { useWebMcpClipTools } from "../hooks/useWebMcpClipTools";
import type {
  ClipWindowRequest,
  TimestampWindow,
} from "../timestamp-windows";
import { toExistingClipRanges } from "../timeline";

export function CreatorPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const videoId = searchParams.get("video") ?? "";
  const clipWindowSequence = useRef(0);
  const [proposalReview] = useState(createClipProposalReview);
  const [clipWindowRequest, setClipWindowRequest] =
    useState<ClipWindowRequest | null>(null);
  const { data: sourceVideoData } = useQuery({
    queryKey: sourceVideoQueryKey(videoId),
    queryFn: () => getSourceVideo(videoId),
    enabled: Boolean(videoId),
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

  const activeVideo =
    sourceVideoData?.video.id === videoId ? sourceVideoData.video : null;
  useWebMcpClipTools({
    video: activeVideo,
    transcript,
    transcriptError: transcriptError?.message ?? null,
    review: proposalReview,
  });

  const handleClipCreated = () => {
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
      <CreatorForm
        onClipCreated={handleClipCreated}
        onVideoActivated={handleVideoActivated}
        clipWindowRequest={clipWindowRequest}
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
      />
      <StatusPanel />
    </main>
  );
}
