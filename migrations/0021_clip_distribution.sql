CREATE TABLE clip_shares (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  created_by_user_id TEXT NOT NULL REFERENCES app_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idx_clip_shares_owner_clip_created
  ON clip_shares (owner_id, clip_id, created_at DESC);

CREATE INDEX idx_clip_shares_clip_active
  ON clip_shares (clip_id, revoked_at, expires_at);
