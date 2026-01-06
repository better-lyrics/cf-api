ALTER TABLE go_lyrics_cache ADD COLUMN last_updated_at INTEGER DEFAULT 0;
UPDATE go_lyrics_cache SET last_updated_at = last_accessed_at;
