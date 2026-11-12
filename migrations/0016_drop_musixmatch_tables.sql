-- Migration number: 0016 	 2026-11-12T16:30:00.000Z
-- Musixmatch was removed as a provider; these tables only held its cache.
-- Run `npm run purge:musixmatch -- --confirm` first if the R2 objects the `lyrics` table points to still exist.
-- Children before the parent so dropping `tracks` has no foreign keys left to check.
DROP TABLE IF EXISTS lyrics;
DROP TABLE IF EXISTS track_mappings;
DROP TABLE IF EXISTS tracks;
