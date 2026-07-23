ALTER TABLE source_videos ADD COLUMN retained_source_key TEXT;

ALTER TABLE source_videos ADD COLUMN retained_source_status TEXT NOT NULL
  DEFAULT 'empty'
  CHECK (retained_source_status IN ('empty', 'importing', 'ready', 'failed'));

ALTER TABLE source_videos ADD COLUMN retained_source_error TEXT;

ALTER TABLE source_videos ADD COLUMN retained_source_updated_at TEXT;
