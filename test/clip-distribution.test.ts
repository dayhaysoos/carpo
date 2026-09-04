import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClipDistribution,
  ClipDistributionError,
} from "../src/clip-distribution";
import { outputKeysForClip } from "../src/db";

const OWNER = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "owner@example.com",
};
const OTHER = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "other@example.com",
};
const CLIP_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-30T12:00:00.000Z");

async function installFixture(status: "complete" | "encoding" = "complete") {
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
       ) VALUES ('distribution-video', ?, 'upload', ?, 'Private source', 30)`,
    ).bind(OWNER.id, `uploads/${OWNER.id}/private.mp4`),
    env.DB.prepare(
      `INSERT INTO clips (
         id, owner_id, title, source_type, source_ref, trim_start, trim_end,
         filters_json, status, output_mp4_key, output_thumbnail_key,
         callback_secret, video_id
       ) VALUES (?, ?, 'Launch <moment>', 'upload', ?, 2, 8, '[]', ?, ?, ?,
                 'callback-secret', 'distribution-video')`,
    ).bind(
      CLIP_ID,
      OWNER.id,
      `uploads/${OWNER.id}/private.mp4`,
      status,
      status === "complete" ? keys.mp4Key : null,
      status === "complete" ? keys.thumbnailKey : null,
    ),
  ]);
  return keys;
}

function distribution(overrides?: {
  now?: Date;
  scheduleGifExport?: (clipId: string) => void;
}) {
  return new ClipDistribution({
    db: env.DB,
    artifactPrefix: "/artifacts",
    now: () => overrides?.now ?? NOW,
    randomBytes: () => new Uint8Array(32).fill(7),
    scheduleGifExport: overrides?.scheduleGifExport,
  });
}

async function errorKind(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ClipDistributionError);
    return (error as ClipDistributionError).kind;
  }
}

describe("ClipDistribution", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM clip_shares").run();
    await env.DB.prepare("DELETE FROM caption_tracks").run();
    await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(CLIP_ID).run();
    await env.DB.prepare("DELETE FROM source_videos WHERE id = 'distribution-video'").run();
  });

  it("creates a hashed seven-day share and resolves only the opaque token", async () => {
    const keys = await installFixture();
    const module = distribution();

    const created = await module.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "week",
      origin: "https://carpo.example",
    });

    expect(created.type).toBe("share-created");
    if (created.type !== "share-created") return;
    expect(created.url).toBe(`https://carpo.example/share/${created.token}`);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.share.expiresAt).toBe("2026-09-06T12:00:00.000Z");
    const reopened = await distribution().view({ ownerId: OWNER.id, clipId: CLIP_ID });
    expect(reopened.shares[0].url).toBe(new URL(created.url).pathname);
    expect(await module.resolve({ token: reopened.shares[0].url.split("/").at(-1)! })).toMatchObject({ artifactKey: keys.mp4Key });
    const stored = await env.DB.prepare(
      "SELECT token_hash, created_by_user_id FROM clip_shares WHERE id = ?",
    )
      .bind(created.share.id)
      .first<{ token_hash: string; created_by_user_id: string }>();
    expect(stored?.token_hash).not.toContain(created.token);
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.created_by_user_id).toBe(OWNER.id);

    expect(await errorKind(module.resolve({ token: CLIP_ID }))).toBe("not_found");
    expect(await module.resolve({ token: created.token })).toMatchObject({
      title: "Launch <moment>",
      artifactKey: keys.mp4Key,
      expiresAt: "2026-09-06T12:00:00.000Z",
    });
  });

  it("recovers an existing share by its public id without breaking its old URL", async () => {
    await installFixture();
    const module = distribution();
    const created = await module.perform({ type: "create-share", ownerId: OWNER.id, clipId: CLIP_ID, expiration: "never", origin: "https://carpo.example" });
    if (created.type !== "share-created") throw new Error("Expected share");
    const oldId = crypto.randomUUID();
    await env.DB.prepare("UPDATE clip_shares SET id = ? WHERE id = ?").bind(oldId, created.share.id).run();
    expect(await module.resolve({ token: oldId })).toMatchObject({ shareId: oldId });
    expect(await module.resolve({ token: created.token })).toMatchObject({ shareId: oldId });
  });

  it("fails closed after revocation while preserving the owner's exports", async () => {
    await installFixture();
    const module = distribution();
    const created = await module.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "never",
      origin: "https://carpo.example",
    });
    if (created.type !== "share-created") throw new Error("Expected share");

    await module.perform({
      type: "revoke-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      shareId: created.share.id,
    });

    expect(await errorKind(module.resolve({ token: created.token }))).toBe("revoked");
    const view = await module.view({ ownerId: OWNER.id, clipId: CLIP_ID });
    expect(view.shares[0]?.status).toBe("revoked");
    expect(view.exports.find((item) => item.id === "original-mp4")).toMatchObject({
      status: "ready",
      downloadUrl: `/artifacts/clips/${CLIP_ID}/clip.mp4`,
    });
  });

  it("expires links against an injected clock and reports the expired status", async () => {
    await installFixture();
    const module = distribution();
    const created = await module.perform({
      type: "create-share",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      expiration: "day",
      origin: "https://carpo.example",
    });
    if (created.type !== "share-created") throw new Error("Expected share");

    const later = distribution({ now: new Date("2026-09-01T12:00:00.000Z") });
    expect(await errorKind(later.resolve({ token: created.token }))).toBe("expired");
    expect(
      (await later.view({ ownerId: OWNER.id, clipId: CLIP_ID })).shares[0]?.status,
    ).toBe("expired");
  });

  it("never lets another owner inspect, share, or revoke a clip", async () => {
    await installFixture();
    const module = distribution();
    expect(
      await errorKind(module.view({ ownerId: OTHER.id, clipId: CLIP_ID })),
    ).toBe("not_found");
    expect(
      await errorKind(
        module.perform({
          type: "create-share",
          ownerId: OTHER.id,
          clipId: CLIP_ID,
          expiration: "week",
          origin: "https://carpo.example",
        }),
      ),
    ).toBe("not_found");
  });

  it("refuses to distribute an unfinished clip", async () => {
    await installFixture("encoding");
    const module = distribution();
    expect(
      await errorKind(
        module.perform({
          type: "create-share",
          ownerId: OWNER.id,
          clipId: CLIP_ID,
          expiration: "week",
          origin: "https://carpo.example",
        }),
      ),
    ).toBe("not_complete");
  });

  it("presents original, captioned, and GIF exports behind one policy", async () => {
    const keys = await installFixture();
    await env.DB.prepare(
      `INSERT INTO caption_tracks (
         clip_id, cues_json, render_status, output_captioned_mp4_key, revision
       ) VALUES (?, '[]', 'complete', ?, 'caption-revision')`,
    )
      .bind(CLIP_ID, `clips/${CLIP_ID}/captioned-render.mp4`)
      .run();
    await env.DB.prepare(
      `UPDATE clips SET gif_status = 'complete', output_gif_key = ? WHERE id = ?`,
    )
      .bind(keys.gifKey, CLIP_ID)
      .run();

    const module = distribution();
    const shared = await module.perform({ type: "create-share", ownerId: OWNER.id, clipId: CLIP_ID, expiration: "never", origin: "https://carpo.example" });
    if (shared.type !== "share-created") throw new Error("Expected share");
    expect(await module.resolve({ token: shared.token })).toMatchObject({ artifactKey: `clips/${CLIP_ID}/captioned-render.mp4` });
    const view = await distribution().view({ ownerId: OWNER.id, clipId: CLIP_ID });
    expect(view.exports).toEqual([
      expect.objectContaining({ id: "original-mp4", status: "ready" }),
      expect.objectContaining({ id: "captioned-mp4", status: "ready" }),
      expect.objectContaining({ id: "looping-gif", status: "ready" }),
    ]);
  });

  it("starts GIF generation once and keeps the deterministic result inspectable", async () => {
    await installFixture();
    const scheduleGifExport = vi.fn();
    const module = distribution({ scheduleGifExport });

    const first = await module.perform({
      type: "create-export",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      preset: "looping-gif",
    });
    const second = await module.perform({
      type: "create-export",
      ownerId: OWNER.id,
      clipId: CLIP_ID,
      preset: "looping-gif",
    });

    expect(first).toMatchObject({ type: "export", export: { status: "preparing" } });
    expect(second).toMatchObject({ type: "export", export: { status: "preparing" } });
    expect(scheduleGifExport).toHaveBeenCalledOnce();
    expect(scheduleGifExport).toHaveBeenCalledWith(CLIP_ID);
  });
});
