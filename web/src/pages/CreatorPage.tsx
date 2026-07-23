import { useQueryClient } from "@tanstack/react-query";
import { CreatorForm } from "../components/CreatorForm";
import { StatusPanel } from "../components/StatusPanel";
import { VideoAgentChat } from "../components/VideoAgentChat";
import { CLIPS_QUERY_KEY, SOURCE_VIDEOS_QUERY_KEY } from "../queries";
import { useSearchParams } from "react-router-dom";

export function CreatorPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const videoId = searchParams.get("video") ?? "";

  const handleClipCreated = () => {
    void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["source-video"] });
  };

  return (
    <main className="app-main">
      <CreatorForm onClipCreated={handleClipCreated} />
      {videoId ? (
        <VideoAgentChat videoId={videoId} onClipCreated={handleClipCreated} />
      ) : null}
      <StatusPanel />
    </main>
  );
}
