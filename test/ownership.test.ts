import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { outputKeysForClip } from "../src/db";
import { authorizeAgentRequest } from "../src/index";
import type { AuthenticatedUser } from "../src/identity";
import { handleRequest } from "../src/routes";

const ALICE: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
};
const BOB: AuthenticatedUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "bob@example.com",
};

async function installUsers(): Promise<void> {
  await env.DB.batch(
    [ALICE, BOB].map((user) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO app_users (id, access_user_id, email)
         VALUES (?, ?, ?)`,
      ).bind(user.id, user.id, user.email),
    ),
  );
}

async function requestAs(
  user: AuthenticatedUser | null,
  path: string,
  init?: RequestInit,
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

async function createYoutubeVideo(
  user: AuthenticatedUser,
  title: string,
): Promise<{ id: string }> {
  const response = await requestAs(user, "/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      title,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

describe("per-user ownership", () => {
  it("returns only the current account identity", async () => {
    await installUsers();
    expect(await (await requestAs(ALICE, "/api/me")).json()).toEqual({
      id: ALICE.id,
      email: ALICE.email,
    });
  });

  it("keeps libraries separate even when two users add the same YouTube source", async () => {
    await installUsers();
    const aliceVideo = await createYoutubeVideo(ALICE, "Alice source");
    const bobVideo = await createYoutubeVideo(BOB, "Bob source");

    expect(bobVideo.id).not.toBe(aliceVideo.id);

    const aliceList = (await (
      await requestAs(ALICE, "/api/videos")
    ).json()) as { videos: Array<{ id: string; title: string }> };
    const bobList = (await (
      await requestAs(BOB, "/api/videos")
    ).json()) as { videos: Array<{ id: string; title: string }> };
    expect(aliceList.videos).toHaveLength(1);
    expect(aliceList.videos[0]?.id).toBe(aliceVideo.id);
    expect(bobList.videos).toHaveLength(1);
    expect(bobList.videos[0]?.id).toBe(bobVideo.id);

    expect(
      (await requestAs(BOB, `/api/videos/${aliceVideo.id}`)).status,
    ).toBe(404);
  });

  it("namespaces new uploads and refuses another user's upload key", async () => {
    await installUsers();
    const slotResponse = await requestAs(ALICE, "/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "video/mp4",
        sizeBytes: 8,
        filename: "private.mp4",
      }),
    });
    expect(slotResponse.status).toBe(200);
    const slot = (await slotResponse.json()) as {
      key: string;
      uploadUrl: string;
    };
    expect(slot.key).toMatch(new RegExp(`^uploads/${ALICE.id}/`));

    const body = new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]);
    expect(
      (
        await requestAs(BOB, new URL(slot.uploadUrl).pathname, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4" },
          body,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await requestAs(ALICE, new URL(slot.uploadUrl).pathname, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4" },
          body,
        })
      ).status,
    ).toBe(201);

    const bobCreate = await requestAs(BOB, "/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { type: "upload", key: slot.key },
        title: "Not Bob's source",
      }),
    });
    expect(bobCreate.status).toBe(404);
  });

  it("hides clip records, artifact bodies, and video agents from non-owners", async () => {
    await installUsers();
    const video = await createYoutubeVideo(ALICE, "Private source");
    const clipId = crypto.randomUUID();
    const keys = outputKeysForClip(clipId);
    await env.DB.prepare(
      `INSERT INTO clips (
         id, owner_id, title, source_type, source_ref, trim_start, trim_end,
         filters_json, status, output_mp4_key, callback_secret, video_id
       ) VALUES (?, ?, 'Private clip', 'youtube', ?, 0, 5, '[]', 'complete', ?, ?, ?)`,
    )
      .bind(
        clipId,
        ALICE.id,
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        keys.mp4Key,
        "test-callback-secret",
        video.id,
      )
      .run();
    await env.CLIPS_BUCKET.put(keys.mp4Key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "video/mp4" },
    });

    expect((await requestAs(BOB, `/api/clips/${clipId}`)).status).toBe(404);
    expect((await requestAs(BOB, `/artifacts/${keys.mp4Key}`)).status).toBe(404);
    const ownedArtifact = await requestAs(
      ALICE,
      `/artifacts/${keys.mp4Key}`,
    );
    expect(ownedArtifact.status).toBe(200);
    expect(ownedArtifact.headers.get("Cache-Control")).toBe("private, no-store");

    const rejectedAgent = await authorizeAgentRequest(
      new Request(
        `http://example.com/agents/video-clip-agent/${encodeURIComponent(video.id)}`,
      ),
      env,
      BOB,
    );
    expect(rejectedAgent?.status).toBe(404);
    expect(
      await authorizeAgentRequest(
        new Request(
          `http://example.com/agents/video-clip-agent/${encodeURIComponent(video.id)}`,
        ),
        env,
        ALICE,
      ),
    ).toBeNull();
  });
});
