CREATE TABLE library_transcript_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  transcript_revision TEXT NOT NULL,
  block_id TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  UNIQUE (video_id, transcript_revision, block_id)
);

CREATE INDEX idx_library_transcript_blocks_owner_video
  ON library_transcript_blocks (owner_id, video_id, transcript_revision);

CREATE VIRTUAL TABLE library_transcript_fts USING fts5(
  text,
  content='library_transcript_blocks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER library_transcript_blocks_after_insert
AFTER INSERT ON library_transcript_blocks BEGIN
  INSERT INTO library_transcript_fts (rowid, text)
  VALUES (new.id, new.text);
END;

CREATE TRIGGER library_transcript_blocks_after_delete
AFTER DELETE ON library_transcript_blocks BEGIN
  INSERT INTO library_transcript_fts (library_transcript_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER library_transcript_blocks_after_update
AFTER UPDATE OF text ON library_transcript_blocks BEGIN
  INSERT INTO library_transcript_fts (library_transcript_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
  INSERT INTO library_transcript_fts (rowid, text)
  VALUES (new.id, new.text);
END;

CREATE TABLE library_transcript_index_state (
  video_id TEXT PRIMARY KEY REFERENCES source_videos(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  transcript_revision TEXT NOT NULL,
  video_revision TEXT NOT NULL,
  semantic_revision TEXT,
  semantic_error TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  semantic_indexed_at TEXT
);

CREATE INDEX idx_library_transcript_index_state_owner
  ON library_transcript_index_state (owner_id, video_id);

CREATE TABLE library_moment_proposals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(id),
  video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  search_result_id TEXT NOT NULL,
  search_mode TEXT NOT NULL CHECK (search_mode IN ('exact', 'meaning')),
  query TEXT NOT NULL,
  transcript_revision TEXT NOT NULL,
  video_revision TEXT NOT NULL,
  block_ids_json TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
);

CREATE INDEX idx_library_moment_proposals_owner_created
  ON library_moment_proposals (owner_id, created_at DESC);
