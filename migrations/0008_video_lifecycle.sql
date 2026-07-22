ALTER TABLE source_videos ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_source_videos_archived_at
  ON source_videos (archived_at, updated_at DESC);
