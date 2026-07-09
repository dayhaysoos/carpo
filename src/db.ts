import type {
  ClipRecord,
  ClipStatus,
  CreateClipRequest,
  FailureMode,
} from "./types";
import { generateCallbackSecret } from "./auth";
import { extractCaptionFromFilters } from "./validation";

export async function insertClip(
  db: D1Database,
  id: string,
  request: CreateClipRequest,
): Promise<ClipRecord> {
  const sourceType = request.source.type;
  const sourceRef =
    request.source.type === "youtube" ? request.source.url : request.source.key;
  const filtersJson = JSON.stringify(request.filters ?? []);
  const callbackSecret = generateCallbackSecret();

  await db
    .prepare(
      `INSERT INTO clips (
        id, title, source_type, source_ref, trim_start, trim_end,
        caption, filters_json, status, callback_secret
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(
      id,
      request.title,
      sourceType,
      sourceRef,
      request.trimStart,
      request.trimEnd,
      extractCaptionFromFilters(request.filters),
      filtersJson,
      callbackSecret,
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
  record?: Pick<ClipRecord, "output_mp4_key" | "output_thumbnail_key"> | null,
): Promise<void> {
  const keys = outputKeysForClip(clipId);
  const keysToDelete = new Set([keys.mp4Key, keys.thumbnailKey]);
  if (record?.output_mp4_key) {
    keysToDelete.add(record.output_mp4_key);
  }
  if (record?.output_thumbnail_key) {
    keysToDelete.add(record.output_thumbnail_key);
  }
  await Promise.all([...keysToDelete].map((key) => bucket.delete(key)));
}

export function outputKeysForClip(clipId: string): {
  mp4Key: string;
  thumbnailKey: string;
} {
  return {
    mp4Key: `clips/${clipId}/clip.mp4`,
    thumbnailKey: `clips/${clipId}/thumbnail.jpg`,
  };
}
