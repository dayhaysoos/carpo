import type {
  ClipRecord,
  ClipStatus,
  CreateClipRequest,
  FailureMode,
  GifStatus,
  HelperState,
} from "./types";
import { DEFAULT_CLIP_QUALITY } from "./types";
import { generateCallbackSecret } from "./auth";
import { extractCaptionFromFilters } from "./validation";

export interface InsertClipOptions {
  helperState?: HelperState;
}

export async function insertClip(
  db: D1Database,
  id: string,
  request: CreateClipRequest,
  options?: InsertClipOptions,
): Promise<ClipRecord> {
  const sourceType = request.source.type;
  const sourceRef =
    request.source.type === "youtube" ? request.source.url : request.source.key;
  const filtersJson = JSON.stringify(request.filters ?? []);
  const callbackSecret = generateCallbackSecret();
  const helperState = options?.helperState ?? null;

  await db
    .prepare(
      `INSERT INTO clips (
        id, title, source_type, source_ref, trim_start, trim_end,
        quality, caption, filters_json, status, callback_secret, helper_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(
      id,
      request.title,
      sourceType,
      sourceRef,
      request.trimStart,
      request.trimEnd,
      request.quality ?? DEFAULT_CLIP_QUALITY,
      extractCaptionFromFilters(request.filters),
      filtersJson,
      callbackSecret,
      helperState,
    )
    .run();

  const record = await getClipById(db, id);
  if (!record) {
    throw new Error(`Failed to read clip ${id} after insert`);
  }
  return record;
}

export async function getClipById(
  db: D1Database,
  id: string,
): Promise<ClipRecord | null> {
  return db
    .prepare("SELECT * FROM clips WHERE id = ?")
    .bind(id)
    .first<ClipRecord>();
}

export async function updateClipStatus(
  db: D1Database,
  id: string,
  status: ClipStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE clips
       SET status = ?,
           error_message = ?,
           failure_mode = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(status, errorMessage, id)
    .run();
}

export async function markClipDownloadingIfQueued(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET status = 'downloading',
           error_message = NULL,
           failure_mode = NULL,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'queued'`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Terminal status guards (compare-and-set): complete and confirmed-failed are
// sticky. Writes succeed only when status != 'complete' AND NOT (status =
// 'failed' AND failure_mode = 'confirmed'). Confirmed failure may overwrite
// ambiguous-failed; complete may recover ambiguous-failed.
const TERMINAL_STATUS_GUARD = `status != 'complete'
       AND NOT (status = 'failed' AND failure_mode = 'confirmed')`;

export async function markClipComplete(
  db: D1Database,
  id: string,
  mp4Key: string,
  thumbnailKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET status = 'complete',
           error_message = NULL,
           failure_mode = NULL,
           output_mp4_key = ?,
           output_thumbnail_key = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND ${TERMINAL_STATUS_GUARD}`,
    )
    .bind(mp4Key, thumbnailKey, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markClipFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
  failureMode: FailureMode = "confirmed",
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET status = 'failed',
           error_message = ?,
           failure_mode = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND ${TERMINAL_STATUS_GUARD}`,
    )
    .bind(errorMessage, failureMode, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

const STALE_IN_FLIGHT_CEILING_MINUTES = 15;

const STALE_JOB_ERROR_MESSAGE =
  "Job timed out — no progress update received. Artifacts may be preserved for recovery.";

export async function sweepStaleClips(db: D1Database): Promise<number> {
  // Rows parked by the helper workflow (pending/expired/recovering while
  // queued, or claimed while downloading) have their own watchdogs and
  // recovery paths; excluding them keeps the generic ceiling from failing
  // them before helper recovery runs. Rows where the container is actually
  // working (helper_state NULL/'fulfilled', or 'recovering' past 'queued')
  // stay subject to this backstop.
  const result = await db
    .prepare(
      `UPDATE clips
       SET status = 'failed',
           failure_mode = 'ambiguous',
           error_message = ?,
           updated_at = datetime('now')
       WHERE status IN ('queued', 'downloading', 'encoding', 'uploading')
         AND updated_at < datetime('now', ?)
         AND NOT (
           status = 'queued'
           AND helper_state IN ('pending', 'expired', 'recovering')
         )
         AND NOT (status = 'downloading' AND helper_state = 'claimed')`,
    )
    .bind(
      STALE_JOB_ERROR_MESSAGE,
      `-${STALE_IN_FLIGHT_CEILING_MINUTES} minutes`,
    )
    .run();
  return result.meta.changes ?? 0;
}

export async function listClips(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ clips: ClipRecord[]; total: number }> {
  const totalResult = await db
    .prepare("SELECT COUNT(*) as count FROM clips")
    .first<{ count: number }>();
  const total = totalResult?.count ?? 0;

  const result = await db
    .prepare("SELECT * FROM clips ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all<ClipRecord>();

  return { clips: result.results ?? [], total };
}

export async function deleteClip(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM clips WHERE id = ?")
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteClipArtifacts(
  bucket: R2Bucket,
  clipId: string,
  record?: Pick<
    ClipRecord,
    | "output_mp4_key"
    | "output_thumbnail_key"
    | "output_gif_key"
    | "helper_upload_key"
  > | null,
): Promise<void> {
  const keys = outputKeysForClip(clipId);
  const keysToDelete = new Set([keys.mp4Key, keys.thumbnailKey, keys.gifKey]);
  if (record?.output_mp4_key) {
    keysToDelete.add(record.output_mp4_key);
  }
  if (record?.output_thumbnail_key) {
    keysToDelete.add(record.output_thumbnail_key);
  }
  if (record?.output_gif_key) {
    keysToDelete.add(record.output_gif_key);
  }
  if (record?.helper_upload_key) {
    keysToDelete.add(record.helper_upload_key);
  }
  await Promise.all([...keysToDelete].map((key) => bucket.delete(key)));
}

export async function deleteHelperUploadSource(
  bucket: R2Bucket,
  record: Pick<ClipRecord, "helper_upload_key">,
): Promise<void> {
  if (record.helper_upload_key) {
    await bucket.delete(record.helper_upload_key);
  }
}

export function outputKeysForClip(clipId: string): {
  mp4Key: string;
  thumbnailKey: string;
  gifKey: string;
} {
  return {
    mp4Key: `clips/${clipId}/clip.mp4`,
    thumbnailKey: `clips/${clipId}/thumbnail.jpg`,
    gifKey: `clips/${clipId}/clip.gif`,
  };
}

export async function markGifEncoding(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET gif_status = 'encoding',
           gif_error_message = NULL,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'complete'
         AND gif_status IN ('none', 'failed')`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markGifComplete(
  db: D1Database,
  id: string,
  gifKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET gif_status = 'complete',
           gif_error_message = NULL,
           output_gif_key = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'complete'
         AND gif_status = 'encoding'`,
    )
    .bind(gifKey, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markGifFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET gif_status = 'failed',
           gif_error_message = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'complete'
         AND gif_status = 'encoding'`,
    )
    .bind(errorMessage, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export function gifStatusForRecord(record: ClipRecord): GifStatus {
  return record.gif_status ?? "none";
}

export async function expirePendingHelperJob(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'expired',
           updated_at = datetime('now')
       WHERE id = ?
         AND helper_state = 'pending'`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function claimOldestPendingHelperJob(
  db: D1Database,
): Promise<ClipRecord | null> {
  return db
    .prepare(
      `UPDATE clips
       SET helper_state = 'claimed',
           helper_claimed_at = datetime('now'),
           status = 'downloading',
           updated_at = datetime('now')
       WHERE id = (
         SELECT id
         FROM clips
         WHERE helper_state = 'pending'
           AND status = 'queued'
           AND source_type = 'youtube'
         ORDER BY created_at ASC
         LIMIT 1
       )
         AND helper_state = 'pending'
       RETURNING *`,
    )
    .first<ClipRecord>();
}

export async function fulfillHelperJob(
  db: D1Database,
  id: string,
  uploadKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'fulfilled',
           helper_upload_key = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND helper_state = 'claimed'`,
    )
    .bind(uploadKey, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function expireClaimedHelperJob(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'expired',
           status = 'queued',
           updated_at = datetime('now')
       WHERE id = ?
         AND helper_state = 'claimed'
         AND status = 'downloading'`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markHelperRecovering(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'recovering',
           updated_at = datetime('now')
       WHERE id = ?
         AND helper_state = 'expired'
         AND status = 'queued'`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

const STALE_HELPER_CLAIM_CEILING_MINUTES = 5;
const STALE_HELPER_RECOVERY_CEILING_MINUTES = 2;
const STALE_PENDING_GRACE_SECONDS = 60;

export async function sweepStaleHelperClaims(
  db: D1Database,
  claimWindowSeconds: number,
): Promise<number> {
  const claimed = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'expired',
           status = 'queued',
           updated_at = datetime('now')
       WHERE helper_state = 'claimed'
         AND status = 'downloading'
         AND helper_claimed_at < datetime('now', ?)`,
    )
    .bind(`-${STALE_HELPER_CLAIM_CEILING_MINUTES} minutes`)
    .run();

  // recovering + still-queued means the recovery waitUntil died between the
  // helper_state CAS and the dispatch reaching the container DO (the DO
  // durably advances status via markClipDownloadingIfQueued). Flip back to
  // 'expired' so the next poll retries. A rare duplicate dispatch is safe:
  // recovery targets the same DO name (getByName(clipId)) and terminal DB
  // writes are compare-and-set sticky, so duplicate work cannot corrupt state.
  const recovering = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'expired',
           updated_at = datetime('now')
       WHERE helper_state = 'recovering'
         AND status = 'queued'
         AND updated_at < datetime('now', ?)`,
    )
    .bind(`-${STALE_HELPER_RECOVERY_CEILING_MINUTES} minutes`)
    .run();

  // pending rows are normally expired by the per-clip claim-window waitUntil
  // scheduled at create time; if that task never ran, expire them here once
  // they exceed the claim window plus a grace period.
  const pendingCutoffSeconds =
    Math.ceil(claimWindowSeconds) + STALE_PENDING_GRACE_SECONDS;
  const pending = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'expired',
           updated_at = datetime('now')
       WHERE helper_state = 'pending'
         AND status = 'queued'
         AND created_at < datetime('now', ?)`,
    )
    .bind(`-${pendingCutoffSeconds} seconds`)
    .run();

  return (
    (claimed.meta.changes ?? 0) +
    (recovering.meta.changes ?? 0) +
    (pending.meta.changes ?? 0)
  );
}

export async function listRecoverableHelperClips(
  db: D1Database,
): Promise<ClipRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM clips
       WHERE helper_state = 'expired'
         AND status = 'queued'
         AND source_type = 'youtube'`,
    )
    .all<ClipRecord>();
  return result.results ?? [];
}
