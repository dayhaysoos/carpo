CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clips_status ON clips (status);
CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips (created_at DESC);
