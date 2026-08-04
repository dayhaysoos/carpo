import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  agentVideoContextSystemBlock,
  forceVideoContextOnFirstStep,
  loadAgentVideoContext,
  VideoClipAgent,
} from "../src/video-clip-agent";
import { findSemanticTranscriptMoments } from "../src/semantic-transcript";
import { transcriptObjectKey } from "../src/source-videos";

async function waitForStoredTranscript(videoId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await env.CLIPS_BUCKET.head(transcriptObjectKey(videoId))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Transcript preparation did not finish for ${videoId}`);
}

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

  it("exposes exact transcript matches for clip proposals", async () => {
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
        "https://www.youtube.com/watch?v=transcript-search",
        "Search tool context video",
        30,
      )
      .run();
    const agent = {
      env,
      name: videoId,
    } as unknown as VideoClipAgent;
    const tools = VideoClipAgent.prototype.getTools.call(agent);
    const execute = tools.searchTranscript.execute;
    if (!execute) {
      throw new Error("searchTranscript tool has no execute function");
    }

    const preparing = await execute(
      {
        query: "code",
        beforeSeconds: 1,
        afterSeconds: 2,
        limit: 20,
      },
      {
        toolCallId: "transcript-search-tool-call",
        messages: [],
      },
    );

    expect(preparing).toEqual({
      transcriptStatus: "checking",
      retryAfterMs: 1_000,
      query: "code",
    });
    await waitForStoredTranscript(videoId);
    const result = await execute(
      {
        query: "code",
        beforeSeconds: 1,
        afterSeconds: 2,
        limit: 20,
      },
      {
        toolCallId: "transcript-search-tool-call-cached",
        messages: [],
      },
    );

    expect(result).toMatchObject({
      transcriptStatus: "available",
      query: "code",
      totalMatches: 2,
      truncated: false,
      matches: [
        {
          startSeconds: 0,
          endSeconds: 2.6,
          spokenStartSeconds: 0.4,
          spokenEndSeconds: 0.6,
        },
        {
          startSeconds: 9,
          endSeconds: 12.2,
          spokenStartSeconds: 10,
          spokenEndSeconds: 10.2,
        },
      ],
    });
    expect(
      VideoClipAgent.prototype.getSystemPrompt.call(agent).toLowerCase(),
    ).toContain(
      "call createclip once for every returned range",
    );
    expect(
      VideoClipAgent.prototype.getSystemPrompt.call(agent).toLowerCase(),
    ).toContain(
      "even when the current transcript status is failed or unavailable",
    );
  });

  it("grounds semantic clip proposals in real transcript block ids", async () => {
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
        "https://www.youtube.com/watch?v=semantic-search",
        "Semantic context video",
        120,
      )
      .run();
    await env.CLIPS_BUCKET.put(
      transcriptObjectKey(videoId),
      JSON.stringify({
        version: 1,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        language: "en",
        automatic: true,
        cues: [
          {
            startSeconds: 10,
            endSeconds: 10.5,
            text: "Reading every line",
          },
          {
            startSeconds: 12,
            endSeconds: 12.5,
            text: "slows the review down",
          },
          {
            startSeconds: 50,
            endSeconds: 51,
            text: "A separate thought",
          },
          {
            startSeconds: 80,
            endSeconds: 81,
            text: "A third thought",
          },
          {
            startSeconds: 130,
            endSeconds: 131,
            text: "Past the video duration",
          },
        ],
      }),
    );
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        matches: [
          {
            blockIds: ["cue-0-1"],
            title: "",
            reason: "One malformed candidate must not discard the rest.",
            score: 0.99,
          },
          {
            blockIds: ["cue-0-1"],
            title: "Weaker duplicate",
            reason: "A later candidate grounds the same range more strongly.",
            score: 0.2,
          },
          {
            blockIds: ["cue-0-1"],
            title: "Read less code",
            reason: "Directly explains the cost of line-by-line review.",
            score: 0.95,
          },
          {
            blockIds: ["invented-block"],
            title: "Hallucinated",
            reason: "This id does not exist.",
            score: 1,
          },
          {
            blockIds: ["cue-2-2", "cue-0-1"],
            title: "Reversed",
            reason: "These blocks are reversed.",
            score: 1,
          },
          {
            blockIds: ["cue-0-1", "cue-0-1"],
            title: "Duplicated",
            reason: "This block is duplicated.",
            score: 1,
          },
          {
            blockIds: ["cue-0-1", "cue-3-3"],
            title: "Noncontiguous",
            reason: "These blocks skip another passage.",
            score: 1,
          },
          {
            blockIds: ["cue-4-4"],
            title: "Out of range",
            reason: "This passage exceeds the video duration.",
            score: 1,
          },
        ],
      }),
    });
    const agent = {
      env: { ...env, AI: { run } },
      name: videoId,
    } as unknown as VideoClipAgent;
    const tools = VideoClipAgent.prototype.getTools.call(agent);
    const execute = tools.findTranscriptMoments.execute;
    if (!execute) {
      throw new Error("findTranscriptMoments tool has no execute function");
    }

    const result = await execute(
      {
        intent: "where he argues developers should read less code",
        count: 3,
        beforeSeconds: 1,
        afterSeconds: 2,
      },
      {
        toolCallId: "semantic-transcript-tool-call",
        messages: [],
      },
    );

    expect(result).toEqual({
      transcriptStatus: "available",
      intent: "where he argues developers should read less code",
      matches: [
        {
          startSeconds: 9,
          endSeconds: 14.5,
          spokenStartSeconds: 10,
          spokenEndSeconds: 12.5,
          quote: "Reading every line slows the review down",
          title: "Read less code",
          reason: "Directly explains the cost of line-by-line review.",
          blockIds: ["cue-0-1"],
        },
      ],
      requestedCount: 3,
      totalMatches: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      VideoClipAgent.prototype.getSystemPrompt.call(agent),
    ).toContain("findTranscriptMoments");
  });

  it("can rank a passage that crosses a semantic batch boundary", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id, source_type, source_ref, title, duration_seconds
       ) VALUES (?, 'upload', ?, ?, ?)`,
    )
      .bind(videoId, `uploads/${videoId}.mp4`, "Long semantic video", 300)
      .run();
    await env.CLIPS_BUCKET.put(
      transcriptObjectKey(videoId),
      JSON.stringify({
        version: 1,
        fetchedAt: "2026-08-04T00:00:00.000Z",
        language: "en",
        automatic: true,
        cues: Array.from({ length: 80 }, (_, index) => ({
          startSeconds: index * 2,
          endSeconds: index * 2 + 1,
          text: `Passage ${index} ${"context ".repeat(45)}`,
        })),
      }),
    );

    let previousIds: string[] = [];
    const run = vi.fn(async (_model: string, request: unknown) => {
      const messages = (request as {
        messages: Array<{ content: string }>;
      }).messages;
      const payload = JSON.parse(messages[1].content) as {
        transcriptBlocks: Array<{ id: string }>;
      };
      const ids = payload.transcriptBlocks.map((block) => block.id);
      const shared = ids.filter((id) => previousIds.includes(id));
      const seamLeft = shared.at(-1);
      const seamIndex = seamLeft ? ids.indexOf(seamLeft) : -1;
      const seamRight = seamIndex >= 0 ? ids[seamIndex + 1] : undefined;
      previousIds = ids;
      return {
        response: JSON.stringify({
          matches:
            shared.length === 11 && seamRight
              ? [
                  {
                    blockIds: [...shared, seamRight],
                    title: "Boundary passage",
                    reason: "The relevant thought spans both batches.",
                    score: 0.9,
                  },
                ]
              : [],
        }),
      };
    });

    const result = await findSemanticTranscriptMoments(
      { ...env, AI: { run } } as unknown as typeof env,
      videoId,
      {
        intent: "the thought spanning a batch boundary",
        count: 5,
        beforeSeconds: 0,
        afterSeconds: 0,
      },
    );

    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(result.transcriptStatus).toBe("available");
    if (result.transcriptStatus !== "available") {
      throw new Error("Expected the cached transcript to be available");
    }
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].blockIds).toHaveLength(12);
  });

  it("rejects malformed semantic output instead of reporting no matches", async () => {
    const videoId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_videos (
         id, source_type, source_ref, title, duration_seconds
       ) VALUES (?, 'upload', ?, ?, ?)`,
    )
      .bind(videoId, `uploads/${videoId}.mp4`, "Malformed semantic output", 30)
      .run();
    await env.CLIPS_BUCKET.put(
      transcriptObjectKey(videoId),
      JSON.stringify({
        version: 1,
        fetchedAt: "2026-08-04T00:00:00.000Z",
        language: "en",
        automatic: true,
        cues: [
          {
            startSeconds: 2,
            endSeconds: 4,
            text: "A grounded passage exists here.",
          },
        ],
      }),
    );

    await expect(
      findSemanticTranscriptMoments(
        {
          ...env,
          AI: { run: vi.fn().mockResolvedValue({ response: "not json" }) },
        } as unknown as typeof env,
        videoId,
        {
          intent: "find the grounded passage",
          count: 1,
          beforeSeconds: 0,
          afterSeconds: 0,
        },
      ),
    ).rejects.toThrow("Semantic transcript ranking returned invalid data");
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
