ALTER TABLE source_videos ADD COLUMN duration_seconds REAL
  CHECK (duration_seconds IS NULL OR duration_seconds > 0);

ALTER TABLE source_videos ADD COLUMN transcript_status TEXT NOT NULL
  DEFAULT 'unknown'
  CHECK (
    transcript_status IN (
      'unknown',
      'checking',
      'available',
      'unavailable',
      'unsupported',
      'failed'
    )
  );

ALTER TABLE source_videos ADD COLUMN transcript_checked_at TEXT;
