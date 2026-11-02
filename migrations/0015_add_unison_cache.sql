-- Shared (non-personalized) Unison lookups by video id.
-- `found` and `payload` are NULL while a row is an invalidation tombstone.
-- Timestamps are in milliseconds so a write-back can be ordered against an invalidation.
CREATE TABLE IF NOT EXISTS unison_cache (
    video_id TEXT PRIMARY KEY,
    found INTEGER,
    payload TEXT,
    fetched_at INTEGER NOT NULL DEFAULT 0,
    invalidated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_unison_cache_fetched_at ON unison_cache(fetched_at);
