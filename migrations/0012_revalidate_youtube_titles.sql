UPDATE source_videos
SET youtube_title_resolved_at = NULL,
    youtube_title_checked_at = NULL
WHERE source_type = 'youtube';
