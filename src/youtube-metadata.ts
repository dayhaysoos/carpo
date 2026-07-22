import { updateSourceVideoTitle } from "./db";
import { extractYoutubeVideoId } from "./source-videos";
import type { SourceVideoRecord } from "./types";

const YOUTUBE_OEMBED_URL = "https://www.youtube.com/oembed";
const TITLE_RESOLUTION_CONCURRENCY = 5;

interface ResolvedYoutubeTitle {
  title: string;
  resolved: boolean;
}

export async function resolveUnresolvedYoutubeTitles(
  db: D1Database,
  videos: SourceVideoRecord[],
): Promise<SourceVideoRecord[]> {
  const resolvedById = new Map<string, ResolvedYoutubeTitle>();
  const unresolved = videos.filter(
    (video) =>
      video.source_type === "youtube" &&
      !video.youtube_title_resolved_at,
  );

  for (
    let offset = 0;
    offset < unresolved.length;
    offset += TITLE_RESOLUTION_CONCURRENCY
  ) {
    const batch = unresolved.slice(
      offset,
      offset + TITLE_RESOLUTION_CONCURRENCY,
    );
    const results = await Promise.all(
      batch.map(async (video) => {
        const result = await fetchYoutubeTitle(video.source_ref);
        await updateSourceVideoTitle(db, video.id, result.title, result.resolved);
        return { id: video.id, result };
      }),
    );
    for (const { id, result } of results) {
      resolvedById.set(id, result);
    }
  }

  return videos.map((video) => {
    const result = resolvedById.get(video.id);
    if (!result) return video;
    return {
      ...video,
      title: result.title,
      youtube_title_resolved_at: result.resolved
        ? new Date().toISOString()
        : null,
    };
  });
}

async function fetchYoutubeTitle(
  sourceUrl: string,
): Promise<ResolvedYoutubeTitle> {
  const videoId = extractYoutubeVideoId(sourceUrl);
  const fallbackTitle = videoId ? `YouTube video ${videoId}` : "YouTube video";
  const endpoint = new URL(YOUTUBE_OEMBED_URL);
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("format", "json");

  try {
    const response = await fetch(endpoint);
    if (response.ok) {
      const body = (await response.json()) as { title?: unknown };
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title) {
        return { title: title.slice(0, 200), resolved: true };
      }
    }

    const permanentlyUnavailable =
      response.status >= 400 && response.status < 500 && response.status !== 429;
    return { title: fallbackTitle, resolved: permanentlyUnavailable };
  } catch {
    return { title: fallbackTitle, resolved: false };
  }
}
