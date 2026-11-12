-- Migration number: 0016 	 2026-11-12T16:30:00.000Z
-- Drop the tables of a retired lyrics provider; nothing reads or writes them any more.
-- Children before the parent so dropping `tracks` has no foreign keys left to check.
DROP TABLE IF EXISTS lyrics;
DROP TABLE IF EXISTS track_mappings;
DROP TABLE IF EXISTS tracks;
