-- Add youtube_cache table
CREATE TABLE youtube_cache (
    video_id TEXT PRIMARY KEY,
    song TEXT,
    artists TEXT,
    album TEXT,
    duration INTEGER,
    last_accessed_at INTEGER NOT NULL
);
