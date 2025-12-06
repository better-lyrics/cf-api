-- Drop old tables
DROP TABLE IF EXISTS go_lyrics_cache;
DROP TABLE IF EXISTS go_lyrics;
DROP TABLE IF EXISTS go_track_mappings;
DROP TABLE IF EXISTS go_tracks;

-- Create new table with metadata
CREATE TABLE IF NOT EXISTS go_lyrics_cache (
  video_id TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK(source_platform IN ('youtube_music', 'spotify', 'apple_music')),
  r2_key TEXT NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, source_platform)
);
