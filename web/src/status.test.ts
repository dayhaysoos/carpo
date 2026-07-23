import { describe, expect, it } from "vitest";
import { statusLabel } from "./status";

describe("statusLabel", () => {
  it("describes source staging without implying every clip downloads externally", () => {
    expect(statusLabel("downloading")).toBe("Preparing source");
  });
});
