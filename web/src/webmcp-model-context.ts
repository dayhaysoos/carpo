export interface BrowserWebMcpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown) => Promise<unknown>;
}

export interface BrowserWebMcpModelContext {
  registerTool: (
    tool: BrowserWebMcpToolDefinition,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
}

export function currentWebMcpModelContext(): BrowserWebMcpModelContext | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  if (window.top !== window) return null;
  const documentCandidate = (document as Document & {
    modelContext?: Partial<BrowserWebMcpModelContext>;
  }).modelContext;
  if (typeof documentCandidate?.registerTool === "function") {
    return documentCandidate as BrowserWebMcpModelContext;
  }
  const navigatorCandidate = (navigator as Navigator & {
    modelContext?: Partial<BrowserWebMcpModelContext>;
  }).modelContext;
  return typeof navigatorCandidate?.registerTool === "function"
    ? (navigatorCandidate as BrowserWebMcpModelContext)
    : null;
}
