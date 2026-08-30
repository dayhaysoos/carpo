import { useEffect } from "react";
import { currentWebMcpModelContext } from "../webmcp-model-context";
import { registerCarpoVisualWebMcpTools } from "../webmcp-visual-tools";

export function useWebMcpVisualTools(videoId: string | null): void {
  useEffect(() => {
    const modelContext = currentWebMcpModelContext();
    if (!modelContext || !videoId) return;
    return registerCarpoVisualWebMcpTools(
      modelContext,
      videoId,
      (error) => console.error("Carpo visual WebMCP registration failed", error),
    );
  }, [videoId]);
}
