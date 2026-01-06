CREATE TABLE negative_mappings (
    source_platform TEXT NOT NULL,
    source_track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_platform, source_track_id)
);
