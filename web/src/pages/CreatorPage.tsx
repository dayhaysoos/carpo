import { useQueryClient } from "@tanstack/react-query";
import { CreatorForm } from "../components/CreatorForm";
import { StatusPanel } from "../components/StatusPanel";
import { CLIPS_QUERY_KEY, SOURCE_VIDEOS_QUERY_KEY } from "../queries";

export function CreatorPage() {
  const queryClient = useQueryClient();

  const handleClipCreated = () => {
    void queryClient.invalidateQueries({ queryKey: CLIPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SOURCE_VIDEOS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["source-video"] });
  };

  return (
    <main className="app-main">
      <CreatorForm onClipCreated={handleClipCreated} />
      <StatusPanel />
    </main>
  );
}
