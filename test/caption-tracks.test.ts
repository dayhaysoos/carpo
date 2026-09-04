import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  beginCaptionRender,
  exportCaptionTrack,
  saveCaptionTrack,
  validateCaptionTrackProposal,
  viewCaptionTrack,
} from "../src/caption-tracks";
import type { AuthenticatedUser } from "../src/identity";
import { handleRequest } from "../src/routes";
import { transcriptObjectKey } from "../src/source-videos";

const legacyUser: AuthenticatedUser = {
  id: "legacy",
  email: "legacy@carpo.invalid",
};

async function routeFetch(
  path: string,
  init?: RequestInit,
  user: AuthenticatedUser = legacyUser,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleRequest(
    new Request(`http://example.com${path}`, init),
    env,
    ctx,
    user,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function createCaptionFixture(): Promise<{
  clipId: string;
  videoId: string;
}> {
  const clipId = crypto.randomUUID();
  const videoId = crypto.randomUUID();
  const sourceRef = `uploads/legacy/${videoId}.mp4`;

  await env.DB.prepare(
    `INSERT INTO source_videos (
      id, owner_id, source_type, source_ref, title, transcript_status
    ) VALUES (?, 'legacy', 'upload', ?, 'Caption source', 'available')`,
  )
    .bind(videoId, sourceRef)
    .run();
  await env.DB.prepare(
    `INSERT INTO clips (
      id, owner_id, title, source_type, source_ref, trim_start, trim_end,
      status, callback_secret, video_id, output_mp4_key
    ) VALUES (?, 'legacy', 'Caption clip', 'upload', ?, 10, 20,
      'complete', 'caption-test-secret', ?, ?)`,
  )
    .bind(clipId, sourceRef, videoId, `clips/${clipId}/clip.mp4`)
    .run();
  await env.CLIPS_BUCKET.put(
    `clips/${clipId}/clip.mp4`,
    new Uint8Array([0, 0, 0, 24]),
    { httpMetadata: { contentType: "video/mp4" } },
  );
  await env.CLIPS_BUCKET.put(
    transcriptObjectKey(videoId),
    JSON.stringify({
      version: 1,
      fetchedAt: "2026-08-28T12:00:00.000Z",
      language: "en",
      automatic: true,
      cues: [
        { startSeconds: 9, endSeconds: 11, text: "Opening" },
        { startSeconds: 11, endSeconds: 13.25, text: "First idea" },
        { startSeconds: 14, endSeconds: 17, text: "Second idea" },
        { startSeconds: 19, endSeconds: 22, text: "Closing" },
      ],
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  return { clipId, videoId };
}

describe("caption track module", () => {
  it("views clip-relative cues derived and clamped from the transcript", async () => {
    const { clipId } = await createCaptionFixture();

    await expect(
      viewCaptionTrack(env, legacyUser.id, clipId),
    ).resolves.toMatchObject({
      captionStatus: "available",
      saved: false,
      clipDurationSeconds: 10,
      cues: [
        { id: "cue-1", startSeconds: 0, endSeconds: 1, text: "Opening" },
        {
          id: "cue-2",
          startSeconds: 1,
          endSeconds: 3.25,
          text: "First idea",
        },
        {
          id: "cue-3",
          startSeconds: 4,
          endSeconds: 7,
          text: "Second idea",
        },
        { id: "cue-4", startSeconds: 9, endSeconds: 10, text: "Closing" },
      ],
    });
  });

  it("rejects cues outside the clip or overlapping the previous cue", async () => {
    const { clipId } = await createCaptionFixture();

    await expect(
      saveCaptionTrack(
        env,
        legacyUser.id,
        clipId,
        [
          { id: "one", startSeconds: 0, endSeconds: 4, text: "One" },
          { id: "two", startSeconds: 3.5, endSeconds: 6, text: "Two" },
          { id: "three", startSeconds: 8, endSeconds: 11, text: "Three" },
        ],
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      details: expect.arrayContaining([
        expect.objectContaining({ field: "cues[1].startSeconds" }),
        expect.objectContaining({ field: "cues[2].endSeconds" }),
      ]),
    });
  });

  it("exports stable WebVTT timestamps after saving a track", async () => {
    const { clipId } = await createCaptionFixture();
    await saveCaptionTrack(env, legacyUser.id, clipId, [
      { id: "one", startSeconds: 0, endSeconds: 1.25, text: "Hello" },
      {
        id: "two",
        startSeconds: 2.001,
        endSeconds: 3.5,
        text: "World",
      },
    ]);

    await expect(
      exportCaptionTrack(env, legacyUser.id, clipId),
    ).resolves.toEqual({
      filename: "Caption-clip-captions.vtt",
      body:
        "WEBVTT\n\none\n00:00:00.000 --> 00:00:01.250\nHello\n\ntwo\n00:00:02.001 --> 00:00:03.500\nWorld\n",
    });
  });

  it("stores a supported theme and exports SubRip captions", async () => {
    const { clipId } = await createCaptionFixture();
    const saved = await saveCaptionTrack(
      env,
      legacyUser.id,
      clipId,
      [{ id: "one", startSeconds: 0, endSeconds: 1.25, text: "Hello" }],
      { theme: "bold-yellow", proposalSource: "think" },
    );

    expect(saved).toMatchObject({
      theme: "bold-yellow",
      lastProposalSource: "think",
      renderStatus: "none",
    });
    await expect(
      exportCaptionTrack(env, legacyUser.id, clipId, "srt"),
    ).resolves.toEqual({
      filename: "Caption-clip-captions.srt",
      body: "1\n00:00:00,000 --> 00:00:01,250\nHello\n",
    });
  });

  it("validates advisory proposals against the current saved revision", async () => {
    const { clipId } = await createCaptionFixture();
    const saved = await saveCaptionTrack(env, legacyUser.id, clipId, [
      { id: "one", startSeconds: 0, endSeconds: 2, text: "Original" },
    ]);
    const proposal = await validateCaptionTrackProposal(
      env,
      legacyUser.id,
      clipId,
      {
        source: "webmcp",
        baseRevision: saved.revision,
        cues: [{ id: "one", startSeconds: 0, endSeconds: 2, text: "Draft" }],
        theme: "high-contrast-box",
      },
    );
    expect(proposal).toMatchObject({
      source: "webmcp",
      baseRevision: saved.revision,
      theme: "high-contrast-box",
      cues: [expect.objectContaining({ text: "Draft" })],
    });

    await saveCaptionTrack(env, legacyUser.id, clipId, [
      { id: "one", startSeconds: 0, endSeconds: 2, text: "Manual edit" },
    ]);
    await expect(
      validateCaptionTrackProposal(env, legacyUser.id, clipId, {
        source: "webmcp",
        baseRevision: saved.revision,
        cues: proposal.cues,
        theme: proposal.theme,
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("starts a version-bound render only for a saved track", async () => {
    const { clipId } = await createCaptionFixture();
    await expect(
      beginCaptionRender(env, legacyUser.id, clipId),
    ).rejects.toMatchObject({ kind: "not_saved" });
    await saveCaptionTrack(env, legacyUser.id, clipId, [
      { id: "one", startSeconds: 0, endSeconds: 2, text: "Render me" },
    ]);
    const started = await beginCaptionRender(env, legacyUser.id, clipId);
    expect(started).toMatchObject({
      started: true,
      track: { renderStatus: "encoding" },
      job: {
        clipId,
        sourceMp4Key: `clips/${clipId}/clip.mp4`,
        cues: [expect.objectContaining({ text: "Render me" })],
      },
    });
  });
});

describe("caption track API", () => {
  it("derives, saves, and privately exports manual corrections", async () => {
    const { clipId } = await createCaptionFixture();

    const initialResponse = await routeFetch(
      `/api/clips/${clipId}/captions`,
    );
    expect(initialResponse.status).toBe(200);
    const initial = (await initialResponse.json()) as {
      captionStatus: string;
      saved: boolean;
      clipDurationSeconds: number;
      cues: Array<{
        id: string;
        startSeconds: number;
        endSeconds: number;
        text: string;
      }>;
    };
    expect(initial).toMatchObject({
      captionStatus: "available",
      saved: false,
      clipDurationSeconds: 10,
    });
    expect(initial.cues).toHaveLength(4);
    expect(initial.cues[0]).toMatchObject({
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(initial.cues[3]).toMatchObject({
      startSeconds: 9,
      endSeconds: 10,
    });

    const correctedCues = [
      { id: "cue-1", startSeconds: 0, endSeconds: 2, text: "Corrected opening" },
      { id: "cue-2", startSeconds: 2, endSeconds: 4.5, text: "Corrected close" },
    ];
    const saveResponse = await routeFetch(`/api/clips/${clipId}/captions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cues: correctedCues }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      captionStatus: "available",
      saved: true,
      cues: correctedCues,
    });

    const rereadResponse = await routeFetch(
      `/api/clips/${clipId}/captions`,
    );
    expect(await rereadResponse.json()).toMatchObject({
      saved: true,
      cues: correctedCues,
    });

    const exportResponse = await routeFetch(
      `/api/clips/${clipId}/captions.vtt`,
    );
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type")).toBe(
      "text/vtt; charset=utf-8",
    );
    expect(exportResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(exportResponse.headers.get("content-disposition")).toContain(
      "Caption-clip-captions.vtt",
    );
    expect(await exportResponse.text()).toContain("Corrected opening");

    const srtResponse = await routeFetch(
      `/api/clips/${clipId}/captions.srt`,
    );
    expect(srtResponse.status).toBe(200);
    expect(srtResponse.headers.get("content-type")).toBe(
      "application/x-subrip; charset=utf-8",
    );
    expect(await srtResponse.text()).toContain(
      "00:00:00,000 --> 00:00:02,000",
    );
  });

  it("renders a separate private captioned MP4", async () => {
    const { clipId } = await createCaptionFixture();
    const saveResponse = await routeFetch(`/api/clips/${clipId}/captions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "high-contrast-box",
        cues: [{ id: "one", startSeconds: 0, endSeconds: 2, text: "Visible" }],
      }),
    });
    expect(saveResponse.status).toBe(200);

    const renderResponse = await routeFetch(
      `/api/clips/${clipId}/captions/render`,
      { method: "POST" },
    );
    expect(renderResponse.status).toBe(202);

    const completeResponse = await routeFetch(
      `/api/clips/${clipId}/captions`,
    );
    const complete = (await completeResponse.json()) as {
      renderStatus: string;
      outputCaptionedMp4: string;
    };
    expect(complete.renderStatus).toBe("complete");
    expect(complete.outputCaptionedMp4).toMatch(
      new RegExp(`^/artifacts/clips/${clipId}/captioned-[A-Za-z0-9-]+\\.mp4$`),
    );

    const artifact = await routeFetch(complete.outputCaptionedMp4);
    expect(artifact.status).toBe(200);
    const downloaded = await routeFetch(`${complete.outputCaptionedMp4}?download=1`);
    expect(downloaded.headers.get("Content-Disposition")).toContain("attachment;");
    const detail = await routeFetch(`/api/clips/${clipId}`);
    expect(await detail.json()).toMatchObject({ outputs: { captionedMp4: complete.outputCaptionedMp4 } });

    expect(artifact.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves private clip downloads as attachments and supports playback ranges", async () => {
    const { clipId } = await createCaptionFixture();
    const path = `/artifacts/clips/${clipId}/clip.mp4`;
    const download = await routeFetch(`${path}?download=1`);
    expect(download.headers.get("Content-Disposition")).toBe('attachment; filename="clip.mp4"');
    expect(download.headers.get("Content-Length")).toBe("4");
    const range = await routeFetch(path, { headers: { Range: "bytes=0-1" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 0-1/4");
    expect((await range.arrayBuffer()).byteLength).toBe(2);
    const head = await routeFetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("4");
    expect(await head.text()).toBe("");
    const forbidden = await routeFetch(`${path}?download=1`, undefined, { id: "other", email: "other@example.com" });
    expect(forbidden.status).toBe(404);
  });

  it("rejects invalid edits without replacing the saved track", async () => {
    const { clipId } = await createCaptionFixture();
    const response = await routeFetch(`/api/clips/${clipId}/captions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cues: [
          { id: "bad", startSeconds: 0, endSeconds: 12, text: "Too long" },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Validation failed",
      details: [expect.objectContaining({ field: "cues[0].endSeconds" })],
    });

    const exportResponse = await routeFetch(
      `/api/clips/${clipId}/captions.vtt`,
    );
    expect(exportResponse.status).toBe(409);
  });

  it("does not reveal another owner's caption track", async () => {
    const { clipId } = await createCaptionFixture();
    const otherUser: AuthenticatedUser = {
      id: crypto.randomUUID(),
      email: `${crypto.randomUUID()}@example.com`,
    };
    await env.DB.prepare(
      `INSERT INTO app_users (id, access_user_id, email) VALUES (?, ?, ?)`,
    )
      .bind(otherUser.id, otherUser.id, otherUser.email)
      .run();

    const response = await routeFetch(
      `/api/clips/${clipId}/captions`,
      undefined,
      otherUser,
    );
    expect(response.status).toBe(404);
  });
});
