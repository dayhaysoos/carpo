import { useEffect, useRef } from "react";
import {
  registerCarpoWebMcpTools,
  type WebMcpClipWorkspaceState,
} from "../webmcp-clip-tools";
import { currentWebMcpModelContext } from "../webmcp-model-context";

export function useWebMcpClipTools(state: WebMcpClipWorkspaceState): void {
  const stateRef = useRef(state);
  const hasActiveWorkspace = Boolean(state.video);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const modelContext = currentWebMcpModelContext();
    if (!modelContext) return;
    return registerCarpoWebMcpTools(
      modelContext,
      () => stateRef.current,
      hasActiveWorkspace,
      (error) => console.error("Carpo WebMCP tool registration failed", error),
    );
  }, [hasActiveWorkspace]);
}
