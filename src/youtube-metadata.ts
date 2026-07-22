import {
  markSourceVideoTitleChecked,
  updateSourceVideoTitle,
} from "./db";
import { extractYoutubeVideoId } from "./source-videos";
import type { SourceVideoRecord } from "./types";

const YOUTUBE_OEMBED_URL = "https://www.youtube.com/oembed";
const DEFAULT_FETCH_TIMEOUT_MS = 2_000;
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MAX_CONCURRENT_LOOKUPS = 5;

export async function resolveUnresolvedYoutubeTitles(
  db: D1Database,
  videos: SourceVideoRecord[],
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<SourceVideoRecord[]> {
  const unresolved = videos.filter(
    (video) =>
      video.source_type === "youtube" &&
      !video.youtube_title_resolved_at,
  );
  const titlesById = new Map(
    unresolved.map((video) => [video.id, fallbackTitle(video.source_ref)]),
  );
  const now = Date.now();
  const due = unresolved.filter(
    (video) => !wasCheckedRecently(video.youtube_title_checked_at, now),
  );

  await forEachWithConcurrency(
    due,
    MAX_CONCURRENT_LOOKUPS,
    async (video) => {
      await bestEffortMarkChecked(db, video.id);
      const title = await fetchYoutubeTitle(video.source_ref, timeoutMs);
      if (!title) return;

      titlesById.set(video.id, title);
      try {
        await updateSourceVideoTitle(db, video.id, title);
      } catch (error) {
        console.error("Failed to cache YouTube title", error);
      }
    },
  );

  return videos.map((video) => {
    const title = titlesById.get(video.id);
    return title ? { ...video, title } : video;
  });
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

async function bestEffortMarkChecked(
  db: D1Database,
  videoId: string,
): Promise<void> {
  try {
    await markSourceVideoTitleChecked(db, videoId);
  } catch (error) {
    console.error("Failed to mark YouTube title lookup", error);
  }
}

async function fetchYoutubeTitle(
  sourceUrl: string,
  timeoutMs: number,
): Promise<string | null> {
  const endpoint = new URL(YOUTUBE_OEMBED_URL);
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("format", "json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return null;

    const body = (await response.json()) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    return title ? title.slice(0, 200) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackTitle(sourceUrl: string): string {
  const videoId = extractYoutubeVideoId(sourceUrl);
  return videoId ? `YouTube video ${videoId}` : "YouTube video";
}

function wasCheckedRecently(checkedAt: string | null, now: number): boolean {
  if (!checkedAt) return false;
  const normalized = checkedAt.includes("T")
    ? checkedAt
    : `${checkedAt.replace(" ", "T")}Z`;
  const checkedAtMs = Date.parse(normalized);
  return Number.isFinite(checkedAtMs) && now - checkedAtMs < RETRY_BACKOFF_MS;
}
