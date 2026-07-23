ALTER TABLE source_videos ADD COLUMN transcript_check_error TEXT;

ALTER TABLE source_videos ADD COLUMN transcript_retry_at TEXT;
