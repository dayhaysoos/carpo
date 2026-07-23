import type { ClipResponse } from "./types";

export interface ExistingClipRange {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
}

export function toExistingClipRanges(
  clips: ClipResponse[] | undefined,
): ExistingClipRange[] {
  return (
    clips
      ?.filter((clip) => clip.status !== "failed")
      .map((clip) => ({
        id: clip.id,
        title: clip.title,
        startSeconds: clip.trimStart,
        endSeconds: clip.trimEnd,
      })) ?? []
  );
}

export function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && left.end > right.start;
}
