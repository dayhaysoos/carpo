import { useSessionActive } from "../session-activity";
import { useEffect } from "react";
import { registerCarpoLibraryWebMcpTools } from "../webmcp-library-tools";
import { currentWebMcpModelContext } from "../webmcp-model-context";

export function useWebMcpLibraryTools({ archived }: { archived: boolean }): void {
  const sessionActive = useSessionActive();
  useEffect(() => {
    const modelContext = currentWebMcpModelContext();
    if (!sessionActive || !modelContext) return;
    return registerCarpoLibraryWebMcpTools(
      modelContext,
      archived,
      (error) => console.error("Carpo Library WebMCP registration failed", error),
    );
  }, [archived, sessionActive]);
}
