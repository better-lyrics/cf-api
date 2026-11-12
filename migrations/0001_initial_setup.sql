-- Migration number: 0001 	 2025-09-08T21:40:00.816Z
CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    external_track_id INTEGER NOT NULL UNIQUE,
    last_accessed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE track_mappings (
    id INTEGER PRIMARY KEY,
    source_track_id TEXT NOT NULL,
    -- Using TEXT and a CHECK constraint to simulate an ENUM
    source_platform TEXT NOT NULL CHECK(source_platform IN ('youtube_music', 'spotify', 'apple_music')),
    track_id INTEGER NOT NULL,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE lyrics (
    id INTEGER PRIMARY KEY,
    track_id INTEGER NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('normal_sync', 'rich_sync')),
    -- Stores the unique key for the object in R2, not the content itself
    r2_object_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
