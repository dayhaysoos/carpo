import type { Env } from "./env";

/** Single warm encoder container instance shared by all clip and GIF jobs. */
export const ENCODER_POOL_INSTANCE = "encoder-0";

export interface VideoMetadata {
  durationSeconds: number | null;
  transcriptAvailable: boolean;
}

export interface StoredVideoMetadata {
  durationSeconds: number | null;
}

export interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface YoutubeTranscript {
  language: string;
  automatic: boolean;
  cues: TranscriptCue[];
}

export class TranscriptUnavailableError extends Error {}

async function encoderErrorDetail(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as { errorMessage?: unknown };
    if (typeof parsed.errorMessage === "string") {
      return parsed.errorMessage;
    }
  } catch {
    // Plain-text encoder failures are already suitable error details.
  }
  return raw;
}

/** Idempotent warm-up via the container's /__carpo/start endpoint. */
export async function prewarmEncoder(
  env: Env,
  options?: { body?: unknown },
): Promise<void> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const init: RequestInit = { method: "POST" };
  if (options?.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await container.fetch("http://encoder/__carpo/start", init);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `Encoder container start failed (${response.status})`,
    );
  }
}

export async function inspectYoutubeVideo(
  env: Env,
  url: string,
): Promise<VideoMetadata> {
  await prewarmEncoder(env, {
    body: { source: { type: "youtube", url } },
  });
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    "http://encoder/__carpo/video-metadata",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `Video metadata check failed (${response.status})`,
    );
  }
  return response.json() as Promise<VideoMetadata>;
}

export async function fetchYoutubeTranscript(
  env: Env,
  url: string,
): Promise<YoutubeTranscript> {
  await prewarmEncoder(env, {
    body: { source: { type: "youtube", url } },
  });
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    "http://encoder/__carpo/video-transcript",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
  if (!response.ok) {
    const detail = await encoderErrorDetail(response);
    if (response.status === 404) {
      throw new TranscriptUnavailableError(
        detail || "This YouTube video has no usable transcript.",
      );
    }
    throw new Error(
      detail || `Transcript fetch failed (${response.status})`,
    );
  }
  return response.json() as Promise<YoutubeTranscript>;
}

export async function transcribeSourceVideo(
  env: Env,
  videoId: string,
): Promise<YoutubeTranscript> {
  await prewarmEncoder(env);
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    "http://encoder/__carpo/source-transcript",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    },
  );
  if (!response.ok) {
    const detail = await encoderErrorDetail(response);
    throw new Error(
      detail || `Retained-source transcription failed (${response.status})`,
    );
  }
  return response.json() as Promise<YoutubeTranscript>;
}

export async function inspectStoredVideo(
  env: Env,
  key: string,
): Promise<StoredVideoMetadata> {
  await prewarmEncoder(env);
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const response = await container.fetch(
    "http://encoder/__carpo/stored-video-metadata",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `Stored video metadata check failed (${response.status})`,
    );
  }
  return response.json() as Promise<StoredVideoMetadata>;
}
