import type { ClipRecord, ClipStatus, CreateClipRequest } from "./types";

export async function insertClip(
  db: D1Database,
  id: string,
  request: CreateClipRequest,
): Promise<ClipRecord> {
  const sourceType = request.source.type;
  const sourceRef =
    request.source.type === "youtube" ? request.source.url : request.source.key;
  const filtersJson = JSON.stringify(request.filters ?? []);

  await db
    .prepare(
      `INSERT INTO clips (
        id, title, source_type, source_ref, trim_start, trim_end,
        caption, filters_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    )
    .bind(
      id,
      request.title,
      sourceType,
      sourceRef,
      request.trimStart,
      request.trimEnd,
      request.caption ?? null,
      filtersJson,
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
       SET status = ?, error_message = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(status, errorMessage, id)
    .run();
}

export async function markClipComplete(
  db: D1Database,
  id: string,
  mp4Key: string,
  thumbnailKey: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE clips
       SET status = 'complete',
           error_message = NULL,
           output_mp4_key = ?,
           output_thumbnail_key = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(mp4Key, thumbnailKey, id)
    .run();
}

export async function markClipFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<void> {
  await updateClipStatus(db, id, "failed", errorMessage);
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
