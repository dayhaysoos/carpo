export const YOUTUBE_BLOCKED_ERROR =
  "YouTube is blocking downloads from this server. Try uploading the video file instead.";

export function isYoutubeBlockedError(message: string | null | undefined): boolean {
  return message === YOUTUBE_BLOCKED_ERROR;
}
