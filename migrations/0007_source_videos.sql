CREATE TABLE IF NOT EXISTS source_videos (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('youtube', 'upload')),
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_ref)
);

ALTER TABLE clips ADD COLUMN video_id TEXT REFERENCES source_videos(id);

INSERT INTO source_videos (
  id,
  source_type,
  source_ref,
  title,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  source_type,
  source_ref,
  min(title),
  min(created_at),
  max(updated_at)
FROM clips
GROUP BY source_type, source_ref;

UPDATE clips
SET video_id = (
  SELECT source_videos.id
  FROM source_videos
  WHERE source_videos.source_type = clips.source_type
    AND source_videos.source_ref = clips.source_ref
);

CREATE INDEX IF NOT EXISTS idx_clips_video_id_created_at
  ON clips (video_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_videos_updated_at
  ON source_videos (updated_at DESC);
