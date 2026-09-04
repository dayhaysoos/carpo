import type { ClipOutputs } from "./types";

export function preferredClipMp4(outputs: ClipOutputs): string | null {
  return outputs.captionedMp4 ?? outputs.mp4;
}

/** Ask the server for an attachment instead of depending on browser download attributes. */
export function clipDownloadUrl(url: string): string {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("download", "1");
  return url.startsWith("/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
}
