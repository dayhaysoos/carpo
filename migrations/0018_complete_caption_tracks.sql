ALTER TABLE caption_tracks ADD COLUMN theme TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE caption_tracks ADD COLUMN last_proposal_source TEXT;
ALTER TABLE caption_tracks ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE caption_tracks ADD COLUMN render_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE caption_tracks ADD COLUMN render_error_message TEXT;
ALTER TABLE caption_tracks ADD COLUMN render_id TEXT;
ALTER TABLE caption_tracks ADD COLUMN render_source_revision TEXT;
ALTER TABLE caption_tracks ADD COLUMN output_captioned_mp4_key TEXT;
