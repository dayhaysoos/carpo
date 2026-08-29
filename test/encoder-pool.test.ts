import { describe, expect, it } from "vitest";
import {
  ENCODER_POOL_INSTANCE,
  ENCODER_PROTOCOL_VERSION,
} from "../src/encoder-pool";

describe("encoder pool compatibility", () => {
  it("changes the pool identity when the Worker-container protocol changes", () => {
    expect(ENCODER_PROTOCOL_VERSION).toBe(3);
    expect(ENCODER_POOL_INSTANCE).toBe(
      `encoder-v${ENCODER_PROTOCOL_VERSION}`,
    );
  });
});
