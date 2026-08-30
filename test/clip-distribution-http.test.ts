import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ClipDistribution } from "../src/clip-distribution";
import { handleClipDistributionApi } from "../src/clip-distribution-http";
import { outputKeysForClip } from "../src/db";
import type { AuthenticatedUser } from "../src/identity";

const OWNER: AuthenticatedUser = {
  id: "66666666-6666-4666-8666-666666666666",
  email: "share-owner@example.com",
};
const OTHER: AuthenticatedUser = {
  id: "77777777-7777-4777-8777-777777777777",
  email: "share-other@example.com",
};
const CLIP_ID = "88888888-8888-4888-8888-888888888888";

async function installFixture() {
  const keys = outputKeysForClip(CLIP_ID);
  await env.DB.batch([
    ...[OWNER, OTHER].map((user) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO app_users (id, access_user_id, email)
         VALUES (?, ?, ?)`,
      ).bind(user.id, user.id, user.email),
    ),
    env.DB.prepare(
      `INSERT INTO source_videos (
         id, owner_id, source_type, source_ref, title, duration_seconds
       ) VALUES ('shared-video', ?, 'upload', ?, 'Private source', 30)`,
    ).bind(OWNER.id, `uploads/${OWNER.id}/private.mp4`),
    env.DB.prepare(
      `INSERT INTO clips (
         id, owner_id, title, source_type, source_ref, trim_start, trim_end,
         filters_json, status, output_mp4_key, output_thumbnail_key,
         callback_secret, video_id
       ) VALUES (?, ?, 'Launch <script>alert(1)</script>', 'upload', ?, 2, 8,
                 '[]', 'complete', ?, ?, 'callback-secret', 'shared-video')`,
    ).bind(
      CLIP_ID,
      OWNER.id,
      `uploads/${OWNER.id}/private.mp4`,
      keys.mp4Key,
      keys.thumbnailKey,
    ),
  ]);
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  await env.CLIPS_BUCKET.put(keys.mp4Key, bytes, {
    httpMetadata: { contentType: "video/mp4" },
  });
  return { keys, bytes };
}

async function workerFetch(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await exports.default.fetch(
    new Request(`http://example.com${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function apiAs(
  user: AuthenticatedUser,
  path: string,
  init?: RequestInit,
) {
  const ctx = createExecutionContext();
  const response = await handleClipDistributionApi(
    new Request(`http://example.com${path}`, init),
    env,
    ctx,
    user,
  );
  await waitOnExecutionContext(ctx);
  if (!response) throw new Error("Distribution API did not match request");
  return response;
}

describe("clip distribution HTTP adapters", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM clip_shares").run();
    await env.DB.prepare("DELETE FROM caption_tracks").run();
    await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(CLIP_ID).run();
    await env.DB.prepare("DELETE FROM source_videos WHERE id = 'shared-video'").run();
  });

  it("creates, lists, and revokes an owner share through protected APIs", async () => {
    await installFixture();
    const create = await apiAs(
      OWNER,
      `/api/clips/${CLIP_ID}/distribution/shares`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiration: "week" }),
      },
    );
    expect(create.status).toBe(201);
    expect(create.headers.get("Cache-Control")).toBe("no-store");
    const created = (await create.json()) as {
      share: { id: string; status: string };
      url: string;
    };
    expect(created.share.status).toBe("active");
    expect(created.url).toMatch(/^http:\/\/example\.com\/share\//);

    const view = await apiAs(
      OWNER,
      `/api/clips/${CLIP_ID}/distribution`,
    );
    expect(await view.json()).toMatchObject({
      clipId: CLIP_ID,
      shares: [{ id: created.share.id, status: "active" }],
      exports: [
        { id: "original-mp4", status: "ready" },
        { id: "captioned-mp4", status: "unavailable" },
        { id: "looping-gif", status: "unavailable" },
      ],
    });

    const revoke = await apiAs(
      OWNER,
      `/api/clips/${CLIP_ID}/distribution/shares/${created.share.id}`,
      { method: "DELETE" },
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({
      share: { id: created.share.id, status: "revoked" },
    });
  });

  it("hides owner distribution state from another user", async () => {
    await installFixture();
    expect(
      (await apiAs(OTHER, `/api/clips/${CLIP_ID}/distribution`)).status,
    ).toBe(404);
    expect(
      (
        await apiAs(
          OTHER,
          `/api/clips/${CLIP_ID}/distribution/shares`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expiration: "week" }),
          },
        )
      ).status,
    ).toBe(404);
  });

  it("renders a no-script public page without leaking unescaped metadata", async () => {
    await installFixture();
    const distribution = new ClipDistribution({
      db: env.DB,
      artifactPrefix: "/artifacts",
      randomBytes: () => new Uint8Array(32).fill(9),
    });
    const created = await distribution.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "never",
      origin: "http://example.com",
    });
    if (created.type !== "share-created") throw new Error("Expected share");

    const response = await workerFetch(new URL(created.url).pathname);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    const html = await response.text();
    expect(html).toContain("Launch &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(OWNER.email);
    expect(html).not.toContain("Private source");
    expect(html).not.toContain(CLIP_ID);
  });

  it("streams shared media ranges and supplies an attachment download", async () => {
    const { bytes } = await installFixture();
    const distribution = new ClipDistribution({
      db: env.DB,
      artifactPrefix: "/artifacts",
      randomBytes: () => new Uint8Array(32).fill(11),
    });
    const created = await distribution.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "never",
      origin: "http://example.com",
    });
    if (created.type !== "share-created") throw new Error("Expected share");

    const ranged = await workerFetch(`/share/${created.token}/media`, {
      headers: { Range: "bytes=2-4" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(2, 5));

    const invalidRange = await workerFetch(`/share/${created.token}/media`, {
      headers: { Range: "bytes=20-" },
    });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("Content-Type")).toContain("text/plain");
    expect(await invalidRange.text()).toBe("Requested range is unavailable");

    const download = await workerFetch(`/share/${created.token}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain(
      'attachment; filename="Launch-scriptalert1script.mp4"',
    );
  });

  it("immediately rejects revoked links and never treats a Clip UUID as a token", async () => {
    await installFixture();
    const distribution = new ClipDistribution({
      db: env.DB,
      artifactPrefix: "/artifacts",
      randomBytes: () => new Uint8Array(32).fill(13),
    });
    const created = await distribution.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "never",
      origin: "http://example.com",
    });
    if (created.type !== "share-created") throw new Error("Expected share");
    await distribution.perform({
      type: "revoke-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      shareId: created.share.id,
    });

    const revoked = await workerFetch(`/share/${created.token}`);
    expect(revoked.status).toBe(410);
    expect(await revoked.text()).toContain("This share link was revoked.");
    expect((await workerFetch(`/share/${CLIP_ID}`)).status).toBe(404);
  });

  it("fails expired links closed with a clear response", async () => {
    await installFixture();
    const distribution = new ClipDistribution({
      db: env.DB,
      artifactPrefix: "/artifacts",
      randomBytes: () => new Uint8Array(32).fill(15),
    });
    const created = await distribution.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "day",
      origin: "http://example.com",
    });
    if (created.type !== "share-created") throw new Error("Expected share");
    await env.DB.prepare(
      `UPDATE clip_shares
       SET created_at = '1999-12-31T00:00:00.000Z',
           expires_at = '2000-01-01T00:00:00.000Z'
       WHERE id = ?`,
    )
      .bind(created.share.id)
      .run();

    const expired = await workerFetch(`/share/${created.token}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("This share link has expired.");
  });
});
