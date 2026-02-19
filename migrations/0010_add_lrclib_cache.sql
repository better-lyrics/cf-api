-- Add LRCLib Cache table
CREATE TABLE IF NOT EXISTS lrclib_cache (
  video_id TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK(source_platform IN ('youtube_music', 'spotify', 'apple_music')),
  r2_key TEXT NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, source_platform)
);
