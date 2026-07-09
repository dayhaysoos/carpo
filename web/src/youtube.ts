const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function isValidYoutubeUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    const normalizedHost = url.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(normalizedHost)) {
      return false;
    }
    if (normalizedHost === "youtu.be") {
      return url.pathname.length > 1;
    }
    if (url.pathname.startsWith("/watch")) {
      return url.searchParams.has("v") && url.searchParams.get("v")!.length > 0;
    }
    if (url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/").filter(Boolean).length >= 2;
    }
    if (url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/").filter(Boolean).length >= 2;
    }
    return false;
  } catch {
    return false;
  }
}

export function extractYoutubeVideoId(urlString: string): string | null {
  if (!isValidYoutubeUrl(urlString)) {
    return null;
  }

  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }

    if (url.pathname.startsWith("/watch")) {
      return url.searchParams.get("v");
    }

    if (url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/")[2] ?? null;
    }

    if (url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/")[2] ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const mins = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function parseTimestampInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  if (parts.length === 2) {
    const mins = Number(parts[0]);
    const secPart = parts[1];
    const [secsStr, msStr] = secPart.split(".");
    const secs = Number(secsStr);
    const ms = msStr === undefined ? 0 : Number(msStr.padEnd(3, "0").slice(0, 3));
    if (
      Number.isFinite(mins) &&
      Number.isFinite(secs) &&
      Number.isFinite(ms) &&
      mins >= 0 &&
      secs >= 0 &&
      ms >= 0
    ) {
      return mins * 60 + secs + ms / 1000;
    }
    return null;
  }

  return null;
}
