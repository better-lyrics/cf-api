ALTER TABLE tracks ADD COLUMN last_updated_at INTEGER DEFAULT 0;
UPDATE tracks SET last_updated_at = last_accessed_at;
