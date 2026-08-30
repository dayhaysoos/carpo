import type {
  ClipRecord,
  ClipStatus,
  ClipSource,
  CreateClipRequest,
  FailureMode,
  GifStatus,
  HelperState,
  SourceVideoRecord,
  TranscriptStatus,
} from "./types";
import { DEFAULT_CLIP_QUALITY } from "./types";
import { generateCallbackSecret } from "./auth";
import { extractCaptionFromFilters } from "./validation";
import {
  fallbackSourceTitle,
  sourceReference,
  transcriptObjectKey,
} from "./source-videos";

export interface InsertClipOptions {
  helperState?: HelperState;
  videoId?: string;
}

export async function insertClip(
  db: D1Database,
  ownerId: string,
  id: string,
  request: CreateClipRequest,
  options?: InsertClipOptions,
): Promise<ClipRecord> {
  const sourceType = request.source.type;
  const sourceRef = sourceReference(request.source);
  const filtersJson = JSON.stringify(request.filters ?? []);
  const callbackSecret = generateCallbackSecret();
  const helperState = options?.helperState ?? null;
  const explicitSourceTitle = request.sourceTitle?.trim();
  const videoId =
    options?.videoId ??
    (await ensureSourceVideo(db, ownerId, {
      source: request.source,
      title:
        explicitSourceTitle ||
        fallbackSourceTitle(request.source, request.title),
      updateUploadTitle: Boolean(
        explicitSourceTitle && request.source.type === "upload",
      ),
    }));

  await db
    .prepare(
      `INSERT INTO clips (
        id, owner_id, title, source_type, source_ref, trim_start, trim_end,
        quality, caption, filters_json, status, callback_secret, helper_state,
        video_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .bind(
      id,
      ownerId,
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
      videoId,
    )
    .run();

  const record = await getClipById(db, id);
  if (!record) {
    throw new Error(`Failed to read clip ${id} after insert`);
  }
  return record;
}

export async function ensureSourceVideo(
  db: D1Database,
  ownerId: string,
  input: {
    source: ClipSource;
    title: string;
    updateUploadTitle?: boolean;
  },
): Promise<string> {
  const sourceType = input.source.type;
  const sourceRef = sourceReference(input.source);
  const id = crypto.randomUUID();

  if (input.updateUploadTitle && sourceType === "upload") {
    await db
      .prepare(
        `INSERT INTO source_videos (id, owner_id, source_type, source_ref, title)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, source_type, source_ref) DO UPDATE SET
           title = excluded.title,
           updated_at = datetime('now')`,
      )
      .bind(id, ownerId, sourceType, sourceRef, input.title)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO source_videos (id, owner_id, source_type, source_ref, title)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, source_type, source_ref) DO UPDATE SET
           updated_at = datetime('now')`,
      )
      .bind(id, ownerId, sourceType, sourceRef, input.title)
      .run();
  }

  const record = await db
    .prepare(
      `SELECT id FROM source_videos
       WHERE owner_id = ? AND source_type = ? AND source_ref = ?`,
    )
    .bind(ownerId, sourceType, sourceRef)
    .first<{ id: string }>();

  if (!record) {
    throw new Error("Failed to create source video");
  }
  return record.id;
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

export async function getClipByIdForOwner(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<ClipRecord | null> {
  return db
    .prepare("SELECT * FROM clips WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
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

export async function markClipHelperPending(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE clips
       SET helper_state = 'pending',
           updated_at = datetime('now')
       WHERE id = ? AND status = 'queued'`,
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
           AND COALESCE(helper_state, '') IN ('pending', 'expired', 'recovering')
         )
         AND NOT (
           status = 'downloading'
           AND COALESCE(helper_state, '') = 'claimed'
         )`,
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
  ownerId: string,
  limit: number,
  offset: number,
): Promise<{ clips: ClipRecord[]; total: number }> {
  const totalResult = await db
    .prepare("SELECT COUNT(*) as count FROM clips WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ count: number }>();
  const total = totalResult?.count ?? 0;

  const result = await db
    .prepare(
      "SELECT * FROM clips WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(ownerId, limit, offset)
    .all<ClipRecord>();

  return { clips: result.results ?? [], total };
}

const SOURCE_VIDEO_SELECT = `
  SELECT
    source_videos.id,
    source_videos.owner_id,
    source_videos.source_type,
    source_videos.source_ref,
    source_videos.title,
    COUNT(clips.id) AS clip_count,
    SUM(CASE
      WHEN clips.status IN ('queued', 'downloading', 'encoding', 'uploading')
      THEN 1 ELSE 0 END) AS active_clip_count,
    SUM(CASE WHEN clips.status = 'failed' THEN 1 ELSE 0 END) AS failed_clip_count,
    (
      SELECT preview.output_thumbnail_key
      FROM clips AS preview
      WHERE preview.video_id = source_videos.id
        AND preview.owner_id = source_videos.owner_id
        AND preview.output_thumbnail_key IS NOT NULL
      ORDER BY preview.created_at DESC
      LIMIT 1
    ) AS thumbnail_key,
    source_videos.archived_at,
    source_videos.youtube_title_resolved_at,
    source_videos.youtube_title_checked_at,
    source_videos.retained_source_key,
    source_videos.retained_source_status,
    source_videos.retained_source_error,
    source_videos.retained_source_updated_at,
    source_videos.duration_seconds,
    source_videos.transcript_status,
    source_videos.transcript_checked_at,
    source_videos.transcript_check_error,
    source_videos.transcript_retry_at,
    source_videos.created_at,
    COALESCE(MAX(clips.updated_at), source_videos.updated_at) AS updated_at
  FROM source_videos
  LEFT JOIN clips ON clips.video_id = source_videos.id
    AND clips.owner_id = source_videos.owner_id`;

export async function listSourceVideos(
  db: D1Database,
  ownerId: string,
  limit: number,
  offset: number,
  archived = false,
): Promise<{ videos: SourceVideoRecord[]; total: number }> {
  const archiveClause = archived
    ? "source_videos.archived_at IS NOT NULL"
    : "source_videos.archived_at IS NULL";
  const totalResult = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM source_videos
       WHERE source_videos.owner_id = ? AND ${archiveClause}`,
    )
    .bind(ownerId)
    .first<{ count: number }>();

  const result = await db
    .prepare(
      `${SOURCE_VIDEO_SELECT}
       WHERE source_videos.owner_id = ? AND ${archiveClause}
       GROUP BY source_videos.id
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(ownerId, limit, offset)
    .all<SourceVideoRecord>();

  return {
    videos: result.results ?? [],
    total: totalResult?.count ?? 0,
  };
}

export async function setSourceVideoArchived(
  db: D1Database,
  id: string,
  archived: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET archived_at = ${archived ? "datetime('now')" : "NULL"},
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateSourceVideoDuration(
  db: D1Database,
  id: string,
  durationSeconds: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET duration_seconds = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(durationSeconds, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateSourceVideoTranscriptContext(
  db: D1Database,
  id: string,
  update: {
    status: TranscriptStatus;
    durationSeconds?: number | null;
    error?: string | null;
    retryAt?: string | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET transcript_status = ?,
           transcript_checked_at = CASE
             WHEN ? IN ('available', 'unavailable', 'unsupported', 'failed')
             THEN datetime('now')
             ELSE transcript_checked_at
           END,
           transcript_check_error = ?,
           transcript_retry_at = ?,
           duration_seconds = COALESCE(?, duration_seconds),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      update.status,
      update.status,
      update.error ?? null,
      update.retryAt ?? null,
      update.durationSeconds ?? null,
      id,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function claimSourceVideoTranscriptRetry(
  db: D1Database,
  id: string,
  retryAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET transcript_retry_at = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND transcript_status = 'failed'
         AND (
           transcript_retry_at IS NULL
           OR julianday(transcript_retry_at) <= julianday('now')
         )`,
    )
    .bind(retryAt, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateSourceVideoTitle(
  db: D1Database,
  id: string,
  title: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE source_videos
       SET title = ?,
           youtube_title_resolved_at = datetime('now'),
           youtube_title_checked_at = datetime('now')
       WHERE id = ? AND source_type = 'youtube'`,
    )
    .bind(title, id)
    .run();
}

export async function markSourceVideoTitleChecked(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE source_videos
       SET youtube_title_checked_at = datetime('now')
       WHERE id = ? AND source_type = 'youtube'`,
    )
    .bind(id)
    .run();
}

export async function markSourceVideoRetainedSourceImporting(
  db: D1Database,
  id: string,
  key: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET retained_source_key = ?,
           retained_source_status = 'importing',
           retained_source_error = NULL,
           retained_source_updated_at = datetime('now')
       WHERE id = ? AND source_type = 'youtube'`,
    )
    .bind(key, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function claimSourceVideoRetainedSourceImport(
  db: D1Database,
  id: string,
  key: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET retained_source_key = ?,
           retained_source_status = 'importing',
           retained_source_error = NULL,
           retained_source_updated_at = datetime('now')
       WHERE id = ?
         AND source_type = 'youtube'
         AND (
           retained_source_status IN ('empty', 'failed')
           OR (
             retained_source_status = 'importing'
             AND retained_source_updated_at < datetime('now', '-75 minutes')
           )
         )`,
    )
    .bind(key, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markSourceVideoRetainedSourceReady(
  db: D1Database,
  id: string,
  key: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET retained_source_key = ?,
           retained_source_status = 'ready',
           retained_source_error = NULL,
           retained_source_updated_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ? AND source_type = 'youtube'`,
    )
    .bind(key, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markSourceVideoRetainedSourceFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE source_videos
       SET retained_source_status = 'failed',
           retained_source_error = ?,
           retained_source_updated_at = datetime('now')
       WHERE id = ? AND source_type = 'youtube'`,
    )
    .bind(errorMessage, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function isRetainedUploadSource(
  db: D1Database,
  key: string,
): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1 AS retained
       FROM source_videos
       WHERE source_type = 'upload' AND source_ref = ?
       LIMIT 1`,
    )
    .bind(key)
    .first<{ retained: number }>();
  return record?.retained === 1;
}

export async function deleteSourceVideoRecords(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const results = await db.batch([
    ...queueClipArtifactDeletions(db, "video_id", id),
    db.prepare(
      `INSERT OR IGNORE INTO artifact_deletions (key)
       SELECT retained_source_key
       FROM source_videos
       WHERE id = ? AND retained_source_key IS NOT NULL`,
    ).bind(id),
    db.prepare(
      `INSERT OR IGNORE INTO artifact_deletions (key)
       SELECT source_ref
       FROM source_videos
       WHERE id = ? AND source_type = 'upload'`,
    ).bind(id),
    db.prepare(
      `INSERT OR IGNORE INTO artifact_deletions (key)
       SELECT ?
       FROM source_videos
       WHERE id = ?`,
    ).bind(transcriptObjectKey(id), id),
    db.prepare(
      `INSERT OR IGNORE INTO artifact_deletions (key)
       SELECT frame_key
       FROM visual_frame_observations
       WHERE video_id = ?`,
    ).bind(id),
    db.prepare("DELETE FROM clips WHERE video_id = ?").bind(id),
    db.prepare("DELETE FROM source_videos WHERE id = ?").bind(id),
  ]);
  const videoResult = results[results.length - 1];
  return (videoResult.meta.changes ?? 0) > 0;
}

export async function getSourceVideoById(
  db: D1Database,
  id: string,
): Promise<SourceVideoRecord | null> {
  return db
    .prepare(
      `${SOURCE_VIDEO_SELECT}
       WHERE source_videos.id = ?
       GROUP BY source_videos.id`,
    )
    .bind(id)
    .first<SourceVideoRecord>();
}

export async function getSourceVideoByIdForOwner(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<SourceVideoRecord | null> {
  return db
    .prepare(
      `${SOURCE_VIDEO_SELECT}
       WHERE source_videos.id = ? AND source_videos.owner_id = ?
       GROUP BY source_videos.id`,
    )
    .bind(id, ownerId)
    .first<SourceVideoRecord>();
}

export async function listClipsByVideoId(
  db: D1Database,
  videoId: string,
): Promise<ClipRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM clips
       WHERE video_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(videoId)
    .all<ClipRecord>();
  return result.results ?? [];
}

export async function listClipsByVideoIdForOwner(
  db: D1Database,
  videoId: string,
  ownerId: string,
): Promise<ClipRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM clips
       WHERE video_id = ? AND owner_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(videoId, ownerId)
    .all<ClipRecord>();
  return result.results ?? [];
}

export async function isOwnedUploadSource(
  db: D1Database,
  key: string,
  ownerId: string,
): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1 AS owned
       FROM source_videos
       WHERE owner_id = ? AND source_type = 'upload' AND source_ref = ?
       LIMIT 1`,
    )
    .bind(ownerId, key)
    .first<{ owned: number }>();
  return record?.owned === 1;
}

export async function deleteClip(db: D1Database, id: string): Promise<boolean> {
  const results = await db.batch([
    ...queueClipArtifactDeletions(db, "id", id),
    db.prepare("DELETE FROM clips WHERE id = ?").bind(id),
  ]);
  const result = results[results.length - 1];
  return (result.meta.changes ?? 0) > 0;
}

function queueClipArtifactDeletions(
  db: D1Database,
  field: "id" | "video_id",
  value: string,
): D1PreparedStatement[] {
  const expressions = [
    "'clips/' || id || '/clip.mp4'",
    "'clips/' || id || '/thumbnail.jpg'",
    "'clips/' || id || '/clip.gif'",
    "output_mp4_key",
    "output_thumbnail_key",
    "output_gif_key",
    "helper_upload_key",
    "(SELECT output_captioned_mp4_key FROM caption_tracks WHERE clip_id = clips.id)",
  ];
  return expressions.map((expression) =>
    db.prepare(
      `INSERT OR IGNORE INTO artifact_deletions (key)
       SELECT ${expression} FROM clips
       WHERE ${field} = ? AND ${expression} IS NOT NULL`,
    ).bind(value),
  );
}

export async function listArtifactDeletions(
  db: D1Database,
  limit: number,
): Promise<Array<{ key: string }>> {
  const result = await db
    .prepare(
      `SELECT key FROM artifact_deletions
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ key: string }>();
  return result.results ?? [];
}

export async function queueArtifactDeletion(
  db: D1Database,
  key: string,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO artifact_deletions (key) VALUES (?)")
    .bind(key)
    .run();
}

export async function removeArtifactDeletion(
  db: D1Database,
  key: string,
): Promise<void> {
  await db.prepare("DELETE FROM artifact_deletions WHERE key = ?").bind(key).run();
}

export async function markArtifactDeletionFailed(
  db: D1Database,
  key: string,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE artifact_deletions
       SET attempts = attempts + 1,
           last_error = ?,
           updated_at = datetime('now')
       WHERE key = ?`,
    )
    .bind(errorMessage, key)
    .run();
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
