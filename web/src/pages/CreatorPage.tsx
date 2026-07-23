import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSourceVideo } from "../api";
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
import type {
  ClipWindowRequest,
  TimestampWindow,
} from "../timestamp-windows";

export function CreatorPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const videoId = searchParams.get("video") ?? "";
  const clipWindowSequence = useRef(0);
  const [clipWindowRequest, setClipWindowRequest] =
    useState<ClipWindowRequest | null>(null);
  const { data: sourceVideoData } = useQuery({
    queryKey: sourceVideoQueryKey(videoId),
    queryFn: () => getSourceVideo(videoId),
    enabled: Boolean(videoId),
  });

  const handleClipCreated = () => {
    void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["source-video"] });
  };

  const handleTimestampSelect = (window: TimestampWindow) => {
    clipWindowSequence.current += 1;
    setClipWindowRequest({
      ...window,
      requestId: clipWindowSequence.current,
    });
  };

  return (
    <main className="app-main">
      <CreatorForm
        onClipCreated={handleClipCreated}
        clipWindowRequest={clipWindowRequest}
      />
      {videoId ? (
        <VideoAgentChat
          videoId={videoId}
          sourceTitle={sourceVideoData?.video.title}
          source={sourceVideoData?.video.source}
          onClipCreated={handleClipCreated}
          onTimestampSelect={handleTimestampSelect}
        />
      ) : null}
      <StatusPanel />
    </main>
  );
}
