ALTER TABLE source_videos ADD COLUMN youtube_title_resolved_at TEXT;

UPDATE source_videos
SET youtube_title_resolved_at = created_at
WHERE source_type = 'youtube'
  AND NOT EXISTS (
    SELECT 1
    FROM clips
    WHERE clips.video_id = source_videos.id
      AND clips.title = source_videos.title
  );
