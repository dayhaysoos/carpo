import { getClipByIdForOwner, markGifEncoding } from "./db";
import type { ClipRecord } from "./types";

export const SHARE_EXPIRATION_PRESETS = [
  "day",
  "week",
  "month",
  "never",
] as const;

export type ShareExpirationPreset =
  (typeof SHARE_EXPIRATION_PRESETS)[number];

export const CLIP_EXPORT_PRESETS = [
  "original-mp4",
  "captioned-mp4",
  "looping-gif",
] as const;

export type ClipExportPreset = (typeof CLIP_EXPORT_PRESETS)[number];
export type ClipExportStatus =
  | "ready"
  | "preparing"
  | "unavailable"
  | "failed";
export type ClipShareStatus = "active" | "expired" | "revoked";

export interface ClipDistributionExport {
  id: ClipExportPreset;
  label: string;
  description: string;
  status: ClipExportStatus;
  downloadUrl: string | null;
  errorMessage: string | null;
}

export interface ClipShareSummary {
  url: string;
  id: string;
  status: ClipShareStatus;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdByEmail: string;
}

export interface ClipDistributionView {
  clipId: string;
  clipTitle: string;
  shares: ClipShareSummary[];
  exports: ClipDistributionExport[];
}

export interface ResolvedClipShare {
  shareId: string;
  title: string;
  artifactKey: string;
  createdAt: string;
  expiresAt: string | null;
}

export type ClipDistributionCommand =
  | {
      type: "create-share";
      ownerId: string;
      clipId: string;
      expiration: ShareExpirationPreset;
      origin: string;
    }
  | {
      type: "revoke-share";
      ownerId: string;
      clipId: string;
      shareId: string;
    }
  | {
      type: "create-export";
      ownerId: string;
      clipId: string;
      preset: ClipExportPreset;
    };

export type ClipDistributionResult =
  | {
      type: "share-created";
      share: ClipShareSummary;
      token: string;
      url: string;
    }
  | { type: "share-revoked"; share: ClipShareSummary }
  | {
      type: "export";
      export: ClipDistributionExport;
      started: boolean;
    };

export type ClipDistributionErrorKind =
  | "not_found"
  | "not_complete"
  | "invalid_input"
  | "expired"
  | "revoked"
  | "unavailable"
  | "internal";

export class ClipDistributionError extends Error {
  constructor(
    readonly kind: ClipDistributionErrorKind,
    message: string,
  ) {
    super(message);
  }
}

interface ClipDistributionDependencies {
  db: D1Database;
  artifactPrefix: string;
  now?: () => Date;
  randomBytes?: () => Uint8Array;
  scheduleGifExport?: (clipId: string) => void;
}

interface ShareRecord {
  id: string;
  owner_id: string;
  clip_id: string;
  created_by_user_id: string;
  created_by_email: string;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface ResolvedShareRecord extends ShareRecord {
  title: string;
  status: string;
  output_mp4_key: string | null;
  output_captioned_mp4_key: string | null;
}

interface CaptionExportRecord {
  render_status: string;
  render_error_message: string | null;
  output_captioned_mp4_key: string | null;
}

const EXPIRATION_MILLISECONDS: Record<
  Exclude<ShareExpirationPreset, "never">,
  number
> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

export class ClipDistribution {
  constructor(private readonly dependencies: ClipDistributionDependencies) {}

  async view(input: {
    ownerId: string;
    clipId: string;
  }): Promise<ClipDistributionView> {
    const clip = await this.completedOwnedClip(input.ownerId, input.clipId);
    const [shares, caption] = await Promise.all([
      this.dependencies.db
        .prepare(
          `SELECT clip_shares.id, clip_shares.owner_id, clip_shares.clip_id,
                  clip_shares.created_by_user_id, app_users.email AS created_by_email,
                  clip_shares.token_hash, clip_shares.expires_at,
                  clip_shares.revoked_at, clip_shares.created_at
           FROM clip_shares
           INNER JOIN app_users
             ON app_users.id = clip_shares.created_by_user_id
           WHERE clip_shares.owner_id = ? AND clip_shares.clip_id = ?
           ORDER BY clip_shares.created_at DESC, clip_shares.id DESC`,
        )
        .bind(input.ownerId, input.clipId)
        .all<ShareRecord>(),
      this.dependencies.db
        .prepare(
          `SELECT render_status, render_error_message,
                  output_captioned_mp4_key
           FROM caption_tracks WHERE clip_id = ?`,
        )
        .bind(input.clipId)
        .first<CaptionExportRecord>(),
    ]);

    return {
      clipId: clip.id,
      clipTitle: clip.title,
      shares: shares.results.map((share) => this.shareSummary(share)),
      exports: this.exportsFor(clip, caption),
    };
  }

  async perform(
    command: ClipDistributionCommand,
  ): Promise<ClipDistributionResult> {
    switch (command.type) {
      case "create-share":
        return this.createShare(command);
      case "revoke-share":
        return this.revokeShare(command);
      case "create-export":
        return this.createExport(command);
    }
  }

  async resolve(input: { token: string }): Promise<ResolvedClipShare> {
    if (!TOKEN_PATTERN.test(input.token)) {
      throw new ClipDistributionError("not_found", "Share not found");
    }
    const tokenHash = await hashToken(input.token);
    const record = await this.dependencies.db
      .prepare(
        `SELECT clip_shares.id, clip_shares.owner_id, clip_shares.clip_id,
                clip_shares.created_by_user_id, app_users.email AS created_by_email,
                clip_shares.token_hash, clip_shares.expires_at,
                clip_shares.revoked_at, clip_shares.created_at,
                clips.title, clips.status, clips.output_mp4_key,
                CASE WHEN caption_tracks.render_status = 'complete'
                  THEN caption_tracks.output_captioned_mp4_key END AS output_captioned_mp4_key
         FROM clip_shares
         INNER JOIN clips ON clips.id = clip_shares.clip_id
         LEFT JOIN caption_tracks ON caption_tracks.clip_id = clips.id
         INNER JOIN app_users ON app_users.id = clip_shares.created_by_user_id
         WHERE clip_shares.token_hash = ? OR clip_shares.id = ?`,
      )
      .bind(tokenHash, input.token)
      .first<ResolvedShareRecord>();
    if (!record) {
      throw new ClipDistributionError("not_found", "Share not found");
    }
    if (record.revoked_at) {
      throw new ClipDistributionError("revoked", "Share was revoked");
    }
    if (isExpired(record.expires_at, this.now())) {
      throw new ClipDistributionError("expired", "Share has expired");
    }
    if (record.status !== "complete" || !record.output_mp4_key) {
      throw new ClipDistributionError(
        "unavailable",
        "Shared clip is unavailable",
      );
    }
    return {
      shareId: record.id,
      title: record.title,
      artifactKey: record.output_captioned_mp4_key ?? record.output_mp4_key,
      createdAt: record.created_at,
      expiresAt: record.expires_at,
    };
  }

  private async createShare(
    command: Extract<ClipDistributionCommand, { type: "create-share" }>,
  ): Promise<ClipDistributionResult> {
    await this.completedOwnedClip(command.ownerId, command.clipId);
    if (!SHARE_EXPIRATION_PRESETS.includes(command.expiration)) {
      throw new ClipDistributionError(
        "invalid_input",
        "Invalid share expiration",
      );
    }
    let origin: string;
    try {
      const parsed = new URL(command.origin);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Invalid protocol");
      }
      origin = parsed.origin;
    } catch {
      throw new ClipDistributionError("invalid_input", "Invalid public origin");
    }

    const createdAt = this.now();
    const expiresAt = expirationDate(createdAt, command.expiration);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = tokenFromBytes(this.randomBytes());
      const tokenHash = await hashToken(token);
      // Public handles are retained as share IDs so the owner can retrieve the
      // same URL later. Hash lookup also keeps previously issued links working.
      const shareId = token;
      try {
        await this.dependencies.db
          .prepare(
            `INSERT INTO clip_shares (
               id, clip_id, owner_id, created_by_user_id, token_hash,
               expires_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            shareId,
            command.clipId,
            command.ownerId,
            command.ownerId,
            tokenHash,
            expiresAt?.toISOString() ?? null,
            createdAt.toISOString(),
          )
          .run();
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Error &&
          error.message.includes("clip_shares.token_hash")
        ) {
          continue;
        }
        throw error;
      }
      const share = await this.shareById(
        command.ownerId,
        command.clipId,
        shareId,
      );
      return {
        type: "share-created",
        share: this.shareSummary(share),
        token,
        url: new URL(`/share/${token}`, `${origin}/`).toString(),
      };
    }
    throw new ClipDistributionError(
      "internal",
      "Could not allocate a share token",
    );
  }

  private async revokeShare(
    command: Extract<ClipDistributionCommand, { type: "revoke-share" }>,
  ): Promise<ClipDistributionResult> {
    await this.completedOwnedClip(command.ownerId, command.clipId);
    await this.shareById(command.ownerId, command.clipId, command.shareId);
    await this.dependencies.db
      .prepare(
        `UPDATE clip_shares
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND clip_id = ? AND owner_id = ?`,
      )
      .bind(
        this.now().toISOString(),
        command.shareId,
        command.clipId,
        command.ownerId,
      )
      .run();
    const share = await this.shareById(
      command.ownerId,
      command.clipId,
      command.shareId,
    );
    return { type: "share-revoked", share: this.shareSummary(share) };
  }

  private async createExport(
    command: Extract<ClipDistributionCommand, { type: "create-export" }>,
  ): Promise<ClipDistributionResult> {
    if (!CLIP_EXPORT_PRESETS.includes(command.preset)) {
      throw new ClipDistributionError("invalid_input", "Invalid export preset");
    }
    let view = await this.view({
      ownerId: command.ownerId,
      clipId: command.clipId,
    });
    let selected = exportById(view.exports, command.preset);
    if (command.preset !== "looping-gif" || selected.status === "ready") {
      return { type: "export", export: selected, started: false };
    }
    if (selected.status === "preparing") {
      return { type: "export", export: selected, started: false };
    }
    if (!this.dependencies.scheduleGifExport) {
      throw new ClipDistributionError(
        "internal",
        "GIF export scheduling is unavailable",
      );
    }
    const started = await markGifEncoding(
      this.dependencies.db,
      command.clipId,
    );
    if (started) {
      this.dependencies.scheduleGifExport(command.clipId);
    }
    view = await this.view({
      ownerId: command.ownerId,
      clipId: command.clipId,
    });
    selected = exportById(view.exports, command.preset);
    return { type: "export", export: selected, started };
  }

  private async completedOwnedClip(
    ownerId: string,
    clipId: string,
  ): Promise<ClipRecord> {
    const clip = await getClipByIdForOwner(
      this.dependencies.db,
      clipId,
      ownerId,
    );
    if (!clip) {
      throw new ClipDistributionError("not_found", "Clip not found");
    }
    if (clip.status !== "complete" || !clip.output_mp4_key) {
      throw new ClipDistributionError(
        "not_complete",
        "Only completed clips can be distributed",
      );
    }
    return clip;
  }

  private async shareById(
    ownerId: string,
    clipId: string,
    shareId: string,
  ): Promise<ShareRecord> {
    const share = await this.dependencies.db
      .prepare(
        `SELECT clip_shares.id, clip_shares.owner_id, clip_shares.clip_id,
                clip_shares.created_by_user_id, app_users.email AS created_by_email,
                clip_shares.token_hash, clip_shares.expires_at,
                clip_shares.revoked_at, clip_shares.created_at
         FROM clip_shares
         INNER JOIN app_users ON app_users.id = clip_shares.created_by_user_id
         WHERE clip_shares.id = ? AND clip_shares.clip_id = ?
           AND clip_shares.owner_id = ?`,
      )
      .bind(shareId, clipId, ownerId)
      .first<ShareRecord>();
    if (!share) {
      throw new ClipDistributionError("not_found", "Share not found");
    }
    return share;
  }

  private shareSummary(record: ShareRecord): ClipShareSummary {
    return {
      id: record.id,
      url: `/share/${record.id}`,
      status: shareStatus(record, this.now()),
      createdAt: record.created_at,
      expiresAt: record.expires_at,
      revokedAt: record.revoked_at,
      createdByEmail: record.created_by_email,
    };
  }

  private exportsFor(
    clip: ClipRecord,
    caption: CaptionExportRecord | null,
  ): ClipDistributionExport[] {
    return [
      {
        id: "original-mp4",
        label: "Original MP4",
        description: "The completed clip exactly as Carpo rendered it.",
        status: clip.output_mp4_key ? "ready" : "unavailable",
        downloadUrl: artifactUrl(
          this.dependencies.artifactPrefix,
          clip.output_mp4_key,
        ),
        errorMessage: null,
      },
      {
        id: "captioned-mp4",
        label: "Captioned MP4",
        description: "The latest manually reviewed timed-caption render.",
        status: captionExportStatus(caption),
        downloadUrl: artifactUrl(
          this.dependencies.artifactPrefix,
          caption?.output_captioned_mp4_key ?? null,
        ),
        errorMessage:
          caption?.render_status === "failed"
            ? caption.render_error_message ?? "Caption export failed"
            : null,
      },
      {
        id: "looping-gif",
        label: "Looping GIF",
        description: "A compact looping preview for lightweight sharing.",
        status: gifExportStatus(clip),
        downloadUrl: artifactUrl(
          this.dependencies.artifactPrefix,
          clip.output_gif_key,
        ),
        errorMessage:
          clip.gif_status === "failed" ? clip.gif_error_message : null,
      },
    ];
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private randomBytes(): Uint8Array {
    const bytes = this.dependencies.randomBytes?.() ??
      crypto.getRandomValues(new Uint8Array(32));
    if (bytes.byteLength !== 32) {
      throw new ClipDistributionError(
        "internal",
        "Share token source must provide 32 bytes",
      );
    }
    return bytes;
  }
}

function exportById(
  exports: ClipDistributionExport[],
  preset: ClipExportPreset,
): ClipDistributionExport {
  const selected = exports.find((item) => item.id === preset);
  if (!selected) {
    throw new ClipDistributionError("invalid_input", "Invalid export preset");
  }
  return selected;
}

function artifactUrl(prefix: string, key: string | null): string | null {
  if (!key) return null;
  return `${prefix.replace(/\/$/, "")}/${key}`;
}

function captionExportStatus(
  caption: CaptionExportRecord | null,
): ClipExportStatus {
  if (caption?.render_status === "complete" && caption.output_captioned_mp4_key) {
    return "ready";
  }
  if (caption?.render_status === "encoding") return "preparing";
  if (caption?.render_status === "failed") return "failed";
  return "unavailable";
}

function gifExportStatus(clip: ClipRecord): ClipExportStatus {
  if (clip.gif_status === "complete" && clip.output_gif_key) return "ready";
  if (clip.gif_status === "encoding") return "preparing";
  if (clip.gif_status === "failed") return "failed";
  return "unavailable";
}

function shareStatus(
  share: Pick<ShareRecord, "revoked_at" | "expires_at">,
  now: Date,
): ClipShareStatus {
  if (share.revoked_at) return "revoked";
  if (isExpired(share.expires_at, now)) return "expired";
  return "active";
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
}

function expirationDate(
  createdAt: Date,
  preset: ShareExpirationPreset,
): Date | null {
  if (preset === "never") return null;
  return new Date(createdAt.getTime() + EXPIRATION_MILLISECONDS[preset]);
}

function tokenFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
