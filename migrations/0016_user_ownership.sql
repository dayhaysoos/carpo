PRAGMA defer_foreign_keys = on;

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  access_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Local development, tests, and the isolated PR-review environment run
-- without Cloudflare Access. Existing production records remain attached to
-- this sentinel until the authenticated legacy owner is explicitly assigned.
INSERT OR IGNORE INTO app_users (id, access_user_id, email)
VALUES ('legacy', 'legacy', 'legacy@carpo.invalid');

-- SQLite cannot add a non-null REFERENCES column with a non-null default.
-- Rebuild both related tables in one deferred-foreign-key transaction so
-- existing rows acquire the legacy owner and every foreign key remains intact.
CREATE TABLE source_videos_with_owners (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES app_users(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('youtube', 'upload')),
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  youtube_title_resolved_at TEXT,
  youtube_title_checked_at TEXT,
  retained_source_key TEXT,
  retained_source_status TEXT NOT NULL DEFAULT 'empty'
    CHECK (retained_source_status IN ('empty', 'importing', 'ready', 'failed')),
  retained_source_error TEXT,
  retained_source_updated_at TEXT,
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  transcript_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (
      transcript_status IN (
        'unknown',
        'checking',
        'available',
        'unavailable',
        'unsupported',
        'failed'
      )
    ),
  transcript_checked_at TEXT,
  transcript_check_error TEXT,
  transcript_retry_at TEXT,
  UNIQUE (owner_id, source_type, source_ref)
);

INSERT INTO source_videos_with_owners (
  id,
  owner_id,
  source_type,
  source_ref,
  title,
  created_at,
  updated_at,
  archived_at,
  youtube_title_resolved_at,
  youtube_title_checked_at,
  retained_source_key,
  retained_source_status,
  retained_source_error,
  retained_source_updated_at,
  duration_seconds,
  transcript_status,
  transcript_checked_at,
  transcript_check_error,
  transcript_retry_at
)
SELECT
  id,
  'legacy',
  source_type,
  source_ref,
  title,
  created_at,
  updated_at,
  archived_at,
  youtube_title_resolved_at,
  youtube_title_checked_at,
  retained_source_key,
  retained_source_status,
  retained_source_error,
  retained_source_updated_at,
  duration_seconds,
  transcript_status,
  transcript_checked_at,
  transcript_check_error,
  transcript_retry_at
FROM source_videos;

CREATE TABLE clips_with_owners (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES app_users(id),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('youtube', 'upload')),
  source_ref TEXT NOT NULL,
  trim_start REAL NOT NULL,
  trim_end REAL NOT NULL,
  caption TEXT,
  filters_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'downloading', 'encoding', 'uploading', 'complete', 'failed')
  ),
  error_message TEXT,
  output_mp4_key TEXT,
  output_thumbnail_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  callback_secret TEXT,
  failure_mode TEXT CHECK (
    failure_mode IS NULL OR failure_mode IN ('confirmed', 'ambiguous')
  ),
  output_gif_key TEXT,
  gif_status TEXT NOT NULL DEFAULT 'none' CHECK (
    gif_status IN ('none', 'encoding', 'complete', 'failed')
  ),
  gif_error_message TEXT,
  quality TEXT NOT NULL DEFAULT '1080p' CHECK (quality IN ('720p', '1080p')),
  helper_state TEXT,
  helper_claimed_at TEXT,
  helper_upload_key TEXT,
  video_id TEXT REFERENCES source_videos_with_owners(id)
);

INSERT INTO clips_with_owners (
  id,
  owner_id,
  title,
  source_type,
  source_ref,
  trim_start,
  trim_end,
  caption,
  filters_json,
  status,
  error_message,
  output_mp4_key,
  output_thumbnail_key,
  created_at,
  updated_at,
  callback_secret,
  failure_mode,
  output_gif_key,
  gif_status,
  gif_error_message,
  quality,
  helper_state,
  helper_claimed_at,
  helper_upload_key,
  video_id
)
SELECT
  id,
  'legacy',
  title,
  source_type,
  source_ref,
  trim_start,
  trim_end,
  caption,
  filters_json,
  status,
  error_message,
  output_mp4_key,
  output_thumbnail_key,
  created_at,
  updated_at,
  callback_secret,
  failure_mode,
  output_gif_key,
  gif_status,
  gif_error_message,
  quality,
  helper_state,
  helper_claimed_at,
  helper_upload_key,
  video_id
FROM clips;

DROP TABLE clips;

DROP TABLE source_videos;

ALTER TABLE source_videos_with_owners RENAME TO source_videos;

ALTER TABLE clips_with_owners RENAME TO clips;

CREATE INDEX IF NOT EXISTS idx_clips_status
  ON clips (status);

CREATE INDEX IF NOT EXISTS idx_clips_created_at
  ON clips (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clips_helper_state
  ON clips (helper_state);

CREATE INDEX IF NOT EXISTS idx_clips_video_id_created_at
  ON clips (video_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clips_owner_created_at
  ON clips (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clips_owner_video_created_at
  ON clips (owner_id, video_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_videos_owner_updated_at
  ON source_videos (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_videos_owner_archived_at
  ON source_videos (owner_id, archived_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_videos_updated_at
  ON source_videos (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_videos_archived_at
  ON source_videos (archived_at, updated_at DESC);

PRAGMA defer_foreign_keys = off;
