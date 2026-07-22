ALTER TABLE source_videos ADD COLUMN youtube_title_resolved_at TEXT;

UPDATE source_videos
SET title = 'YouTube video'
WHERE source_type = 'youtube';
