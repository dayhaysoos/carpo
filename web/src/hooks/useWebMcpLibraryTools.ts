import { useEffect } from "react";
import { registerCarpoLibraryWebMcpTools } from "../webmcp-library-tools";
import { currentWebMcpModelContext } from "../webmcp-model-context";

export function useWebMcpLibraryTools({ archived }: { archived: boolean }): void {
  useEffect(() => {
    const modelContext = currentWebMcpModelContext();
    if (!modelContext) return;
    return registerCarpoLibraryWebMcpTools(
      modelContext,
      archived,
      (error) => console.error("Carpo Library WebMCP registration failed", error),
    );
  }, [archived]);
}
