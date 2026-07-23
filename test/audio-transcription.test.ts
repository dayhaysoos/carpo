import { describe, expect, it } from "vitest";
import { assembleWordTranscript } from "../src/audio-transcription";

describe("assembleWordTranscript", () => {
  it("rebases word timestamps and discards overlap duplicates", () => {
    const transcript = assembleWordTranscript([
      {
        chunk: {
          name: "audio-000.mp3",
          startSeconds: 0,
          durationSeconds: 300,
          keepStartSeconds: 0,
          keepEndSeconds: 299,
        },
        output: {
          transcription_info: { language: "en" },
          segments: [
            {
              words: [
                { word: "first", start: 298.5, end: 298.8 },
                { word: "duplicate", start: 299.2, end: 299.5 },
              ],
            },
          ],
        },
      },
      {
        chunk: {
          name: "audio-001.mp3",
          startSeconds: 298,
          durationSeconds: 12,
          keepStartSeconds: 1,
          keepEndSeconds: 12,
        },
        output: {
          transcription_info: { language: "en" },
          segments: [
            {
              words: [
                { word: "duplicate", start: 1.2, end: 1.5 },
                { word: "second", start: 2, end: 2.4 },
              ],
            },
          ],
        },
      },
    ]);

    expect(transcript).toEqual({
      language: "en",
      automatic: true,
      cues: [
        { text: "first", startSeconds: 298.5, endSeconds: 298.8 },
        { text: "duplicate", startSeconds: 299.2, endSeconds: 299.5 },
        { text: "second", startSeconds: 300, endSeconds: 300.4 },
      ],
    });
  });

  it("rejects model output without usable word timestamps", () => {
    expect(() =>
      assembleWordTranscript([
        {
          chunk: {
            name: "audio-000.mp3",
            startSeconds: 0,
            durationSeconds: 10,
            keepStartSeconds: 0,
            keepEndSeconds: 10,
          },
          output: { text: "untimed transcript" },
        },
      ]),
    ).toThrow("word timestamps");
  });
});
