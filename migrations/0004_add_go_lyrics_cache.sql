-- Add Go Lyrics Cache tables
CREATE TABLE IF NOT EXISTS go_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS go_track_mappings (
  source_platform TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  track_id INTEGER NOT NULL,
  PRIMARY KEY (source_platform, source_track_id),
  FOREIGN KEY (track_id) REFERENCES go_tracks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS go_lyrics (
    track_id INTEGER NOT NULL,
    format TEXT NOT NULL, -- 'ttml'
    r2_object_key TEXT NOT NULL,
    PRIMARY KEY (track_id, format),
    FOREIGN KEY (track_id) REFERENCES go_tracks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_go_track_mappings_source ON go_track_mappings (source_platform, source_track_id);
CREATE INDEX IF NOT EXISTS idx_go_lyrics_track_id ON go_lyrics (track_id);
