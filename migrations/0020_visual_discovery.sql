CREATE TABLE visual_frame_observations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  source_revision TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query TEXT NOT NULL,
  sampled_at_seconds REAL NOT NULL,
  frame_key TEXT NOT NULL,
  matched INTEGER NOT NULL CHECK (matched IN (0, 1)),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  uncertainty TEXT NOT NULL,
  rationale TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, video_id, source_revision, query_hash, sampled_at_seconds)
);

CREATE INDEX idx_visual_observations_owner_video_revision
  ON visual_frame_observations (owner_id, video_id, source_revision);

CREATE TABLE visual_moment_proposals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  query TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observation_ids_json TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
);

CREATE INDEX idx_visual_moment_proposals_owner_created
  ON visual_moment_proposals (owner_id, created_at DESC);
