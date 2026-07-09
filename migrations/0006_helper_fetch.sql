ALTER TABLE clips ADD COLUMN helper_state TEXT;
ALTER TABLE clips ADD COLUMN helper_claimed_at TEXT;
ALTER TABLE clips ADD COLUMN helper_upload_key TEXT;

CREATE INDEX IF NOT EXISTS idx_clips_helper_state ON clips (helper_state);
