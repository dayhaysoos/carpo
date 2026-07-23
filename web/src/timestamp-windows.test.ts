import { describe, expect, it } from "vitest";
import {
  extractTimestampEntities,
  extractTimestampWindows,
} from "./timestamp-windows";

describe("extractTimestampWindows", () => {
  it("turns a standalone timestamp into the selected default clip window", () => {
    expect(extractTimestampWindows("Start at 10:23", 10)).toEqual([
      {
        label: "10:23 → 10:33",
        startSeconds: 623,
        endSeconds: 633,
      },
    ]);
  });

  it("uses an explicit timestamp range instead of the default duration", () => {
    expect(extractTimestampWindows("Clip 10:23 to 10:41", 30)).toEqual([
      {
        label: "10:23 → 10:41",
        startSeconds: 623,
        endSeconds: 641,
      },
    ]);
  });

  it("returns independently clickable windows for separate timestamps", () => {
    expect(extractTimestampWindows("Compare 1:02 and 3:04", 5)).toEqual([
      {
        label: "1:02 → 1:07",
        startSeconds: 62,
        endSeconds: 67,
      },
      {
        label: "3:04 → 3:09",
        startSeconds: 184,
        endSeconds: 189,
      },
    ]);
  });

  it("ignores incomplete or invalid timestamps", () => {
    expect(extractTimestampWindows("Try 10:9 or 10:99", 10)).toEqual([]);
  });

  it("locates the source text used for an inline timestamp control", () => {
    expect(
      extractTimestampEntities("Clip 10:23 to 10:41 please", 30),
    ).toEqual([
      {
        label: "10:23 → 10:41",
        sourceText: "10:23 to 10:41",
        startIndex: 5,
        endIndex: 19,
        startSeconds: 623,
        endSeconds: 641,
      },
    ]);
  });
});
