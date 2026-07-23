import type { ClipSource } from "./types";

const RETAINED_YOUTUBE_SOURCE_KEY_PREFIX = "sources/youtube/";

export function extractYoutubeVideoId(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }
    if (url.pathname.startsWith("/watch")) {
      return url.searchParams.get("v");
    }
    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/")[2] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeClipSource(source: ClipSource): ClipSource {
  if (source.type === "upload") {
    return { type: "upload", key: source.key.trim() };
  }

  const videoId = extractYoutubeVideoId(source.url);
  return videoId
    ? { type: "youtube", url: `https://www.youtube.com/watch?v=${videoId}` }
    : { type: "youtube", url: source.url.trim() };
}

export function sourceReference(source: ClipSource): string {
  return source.type === "youtube" ? source.url : source.key;
}

export function youtubeRetainedSourceKey(videoId: string): string {
  return `${RETAINED_YOUTUBE_SOURCE_KEY_PREFIX}${videoId}/source.mp4`;
}

export function isYoutubeRetainedSourceKey(key: string): boolean {
  return key.startsWith(RETAINED_YOUTUBE_SOURCE_KEY_PREFIX);
}

export function fallbackSourceTitle(source: ClipSource, clipTitle: string): string {
  if (source.type === "youtube") {
    const videoId = extractYoutubeVideoId(source.url);
    return videoId ? `YouTube video ${videoId}` : clipTitle;
  }
  return clipTitle;
}
