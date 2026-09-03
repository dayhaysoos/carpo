import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onSessionRequired,
  sessionFetch,
  SessionRequiredError,
  uploadFailure,
} from "./session-fetch";

afterEach(() => vi.unstubAllGlobals());
describe("session-aware transport", () => {
  it("does not replay a write after an Access login redirect", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302 }));
    vi.stubGlobal("fetch", fetch);
    const expired = vi.fn();
    const stop = onSessionRequired(expired);
    await expect(
      sessionFetch("/api/clips", { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(SessionRequiredError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/clips",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        credentials: "same-origin",
      }),
    );
    expect(expired).toHaveBeenCalledOnce();
    stop();
  });
  it("classifies opaque browser redirects as an expired session", async () => {
    const response = new Response();
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(sessionFetch("/api/me")).rejects.toBeInstanceOf(
      SessionRequiredError,
    );
  });
  it("preserves application errors and network failures", async () => {
    const denied = Response.json({ error: "Not allowed" }, { status: 403 });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(denied)
        .mockRejectedValueOnce(new TypeError("offline")),
    );
    expect(await sessionFetch("/api/clips")).toBe(denied);
    await expect(sessionFetch("/api/me")).rejects.toThrow("offline");
  });
  it("identifies an upload interrupted by authentication without repeating it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    expect(await uploadFailure(0)).toBeInstanceOf(SessionRequiredError);
    expect(fetch).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
