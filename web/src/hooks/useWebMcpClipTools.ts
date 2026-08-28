import { useEffect, useRef } from "react";
import {
  registerCarpoWebMcpTools,
  type WebMcpClipWorkspaceState,
  type WebMcpModelContext,
} from "../webmcp-clip-tools";

function currentModelContext(): WebMcpModelContext | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  if (window.top !== window) return null;
  const candidate = (document as Document & {
    modelContext?: Partial<WebMcpModelContext>;
  }).modelContext;
  return typeof candidate?.registerTool === "function"
    ? (candidate as WebMcpModelContext)
    : null;
}

export function useWebMcpClipTools(state: WebMcpClipWorkspaceState): void {
  const stateRef = useRef(state);
  const hasActiveWorkspace = Boolean(state.video);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const modelContext = currentModelContext();
    if (!modelContext) return;
    return registerCarpoWebMcpTools(
      modelContext,
      () => stateRef.current,
      hasActiveWorkspace,
      (error) => console.error("Carpo WebMCP tool registration failed", error),
    );
  }, [hasActiveWorkspace]);
}
