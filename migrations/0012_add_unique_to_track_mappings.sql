-- Migration number: 0012 	 2026-03-19T00:00:00.000Z

-- Add unique constraint to track_mappings to ensure one mapping per source track
-- This allows using ON CONFLICT to update mappings.
CREATE TABLE track_mappings_new (
    id INTEGER PRIMARY KEY,
    source_track_id TEXT NOT NULL,
    source_platform TEXT NOT NULL CHECK(source_platform IN ('youtube_music', 'spotify', 'apple_music')),
    track_id INTEGER NOT NULL,
    UNIQUE(source_platform, source_track_id),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- Safely copy data, keeping only the latest mapping if duplicates exist
INSERT INTO track_mappings_new (id, source_track_id, source_platform, track_id)
SELECT id, source_track_id, source_platform, track_id
FROM track_mappings
WHERE id IN (
    SELECT MAX(id)
    FROM track_mappings
    GROUP BY source_platform, source_track_id
);

DROP TABLE track_mappings;
ALTER TABLE track_mappings_new RENAME TO track_mappings;

-- Note: The manual CREATE INDEX was removed because the UNIQUE constraint 
-- automatically handles indexing those columns.
