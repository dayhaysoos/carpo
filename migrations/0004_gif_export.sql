ALTER TABLE clips ADD COLUMN output_gif_key TEXT;
ALTER TABLE clips ADD COLUMN gif_status TEXT NOT NULL DEFAULT 'none' CHECK (
  gif_status IN ('none', 'encoding', 'complete', 'failed')
);
ALTER TABLE clips ADD COLUMN gif_error_message TEXT;
