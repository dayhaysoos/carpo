import { useSessionActive } from "../session-activity";
import { useEffect } from "react";
import { currentWebMcpModelContext } from "../webmcp-model-context";
import { registerCarpoVisualWebMcpTools } from "../webmcp-visual-tools";

export function useWebMcpVisualTools(videoId: string | null): void {
  const sessionActive = useSessionActive();
  useEffect(() => {
    const modelContext = currentWebMcpModelContext();
    if (!sessionActive || !modelContext || !videoId) return;
    return registerCarpoVisualWebMcpTools(
      modelContext,
      videoId,
      (error) => console.error("Carpo visual WebMCP registration failed", error),
    );
  }, [videoId, sessionActive]);
}
