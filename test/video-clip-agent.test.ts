import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  agentVideoContextSystemBlock,
  forceVideoContextOnFirstStep,
  loadAgentVideoContext,
} from "../src/video-clip-agent";

describe("VideoClipAgent context", () => {
  it("injects a persisted duration so random clip requests never need user input", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds
       ) VALUES (?, 'youtube', ?, ?, ?)`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=context-test",
        "Context test",
        1009,
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);
    expect(context).toMatchObject({
      title: "Context test",
      durationSeconds: 1009,
      sourceType: "youtube",
    });

    const systemBlock = agentVideoContextSystemBlock(context);
    expect(systemBlock).toContain('"durationSeconds":1009');
    expect(systemBlock).toContain(
      "never ask the user for the video duration",
    );
  });

  it("forces the context tool before the model can answer", () => {
    expect(forceVideoContextOnFirstStep(0)).toEqual({
      activeTools: ["getVideoContext"],
      toolChoice: { type: "tool", toolName: "getVideoContext" },
    });
    expect(forceVideoContextOnFirstStep(1)).toBeUndefined();
  });

  it("automatically retries a failed transcript check after its cooldown", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds,
         transcript_status,
         transcript_checked_at,
         transcript_check_error,
         transcript_retry_at
       ) VALUES (?, 'youtube', ?, ?, ?, 'failed', datetime('now'), ?, datetime('now', '-1 minute'))`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=transcript1-cooldown",
        "Retryable context video",
        321,
        "temporary metadata failure",
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);

    expect(context).toMatchObject({
      transcriptStatus: "available",
      transcriptCheckError: null,
      transcriptRetryAt: null,
    });
  });

  it("can schedule a due transcript retry without blocking context loading", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds,
         transcript_status,
         transcript_checked_at,
         transcript_check_error,
         transcript_retry_at
       ) VALUES (?, 'youtube', ?, ?, ?, 'failed', datetime('now'), ?, datetime('now', '-1 minute'))`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=transcript1-background",
        "Background retry context video",
        321,
        "temporary metadata failure",
      )
      .run();
    const scheduled: Promise<unknown>[] = [];

    const context = await loadAgentVideoContext(env, videoId, {
      schedule: (promise) => scheduled.push(promise),
    });

    expect(context).toMatchObject({
      transcriptStatus: "failed",
      transcriptCheckError: "temporary metadata failure",
      transcriptRetryAt: expect.any(String),
      metadataCheckError: null,
    });
    expect(scheduled).toHaveLength(1);

    await Promise.all(scheduled);
    const refreshed = await loadAgentVideoContext(env, videoId);
    expect(refreshed).toMatchObject({
      transcriptStatus: "available",
      transcriptCheckError: null,
      transcriptRetryAt: null,
    });
  });

  it("does not automatically retry a known permanent transcript failure", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds,
         transcript_status,
         transcript_checked_at,
         transcript_check_error,
         transcript_retry_at
       ) VALUES (?, 'youtube', ?, ?, ?, 'failed', datetime('now'), ?, NULL)`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=transcript1-permanent-context",
        "Permanent failure context video",
        321,
        "The URL is not a supported YouTube link.",
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);

    expect(context).toMatchObject({
      transcriptStatus: "failed",
      transcriptCheckError: "The URL is not a supported YouTube link.",
      transcriptRetryAt: null,
      metadataCheckError: null,
    });
  });

  it("returns the refreshed failure details when an automatic retry fails", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds,
         transcript_status,
         transcript_checked_at,
         transcript_check_error,
         transcript_retry_at
       ) VALUES (?, 'youtube', ?, ?, ?, 'failed', datetime('now'), ?, datetime('now', '-1 minute'))`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=transcript-always-fail",
        "Repeated failure context video",
        321,
        "old failure",
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);

    expect(context).toMatchObject({
      transcriptStatus: "failed",
      transcriptCheckError: "persistent metadata failure",
      transcriptRetryAt: expect.any(String),
      metadataCheckError: "persistent metadata failure",
    });
    expect(
      Date.parse(
        "transcriptRetryAt" in context
          ? context.transcriptRetryAt ?? ""
          : "",
      ),
    ).toBeGreaterThan(Date.now());
  });

  it("keeps failed transcript checks quiet until their retry time", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id,
         source_type,
         source_ref,
         title,
         duration_seconds,
         transcript_status,
         transcript_checked_at,
         transcript_check_error,
         transcript_retry_at
       ) VALUES (?, 'youtube', ?, ?, ?, 'failed', datetime('now'), ?, datetime('now', '+1 hour'))`,
    )
      .bind(
        videoId,
        "https://www.youtube.com/watch?v=transcript1",
        "Cooling down context video",
        321,
        "temporary metadata failure",
      )
      .run();

    const context = await loadAgentVideoContext(env, videoId);

    expect(context).toMatchObject({
      transcriptStatus: "failed",
      transcriptCheckError: "temporary metadata failure",
      metadataCheckError: null,
    });
  });
});
