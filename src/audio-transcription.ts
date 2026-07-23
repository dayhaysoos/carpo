import type { YoutubeTranscript } from "./encoder-pool";

export interface AudioChunkWindow {
  name: string;
  startSeconds: number;
  durationSeconds: number;
  keepStartSeconds: number;
  keepEndSeconds: number;
}

export interface WhisperChunkOutput {
  text?: string;
  transcription_info?: {
    language?: string;
  };
  segments?: Array<{
    words?: Array<{
      word?: string;
      start?: number;
      end?: number;
    }>;
  }>;
}

export function assembleWordTranscript(
  parts: Array<{
    chunk: AudioChunkWindow;
    output: WhisperChunkOutput;
  }>,
): YoutubeTranscript {
  const cues = parts
    .flatMap(({ chunk, output }) =>
      (output.segments ?? []).flatMap((segment) => segment.words ?? []).map(
        (word) => ({ chunk, word }),
      ),
    )
    .filter(({ chunk, word }) => {
      if (
        typeof word.start !== "number" ||
        typeof word.end !== "number" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.end <= word.start ||
        typeof word.word !== "string" ||
        word.word.trim().length === 0
      ) {
        return false;
      }
      const midpoint = (word.start + word.end) / 2;
      return (
        midpoint >= chunk.keepStartSeconds &&
        midpoint < chunk.keepEndSeconds
      );
    })
    .map(({ chunk, word }) => ({
      text: word.word!.trim(),
      startSeconds: chunk.startSeconds + word.start!,
      endSeconds: chunk.startSeconds + word.end!,
    }))
    .sort((left, right) => left.startSeconds - right.startSeconds);

  if (cues.length === 0) {
    throw new Error(
      "Speech recognition returned no usable word timestamps",
    );
  }

  const language =
    parts.find(
      ({ output }) =>
        typeof output.transcription_info?.language === "string" &&
        output.transcription_info.language.trim().length > 0,
    )?.output.transcription_info?.language ?? "unknown";

  return {
    language,
    automatic: true,
    cues,
  };
}
