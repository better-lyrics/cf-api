import { Env } from '../types';
import pako from 'pako';
import { addAwait, observe } from '../observability';

export type LyricType = 'rich_sync' | 'normal_sync' | 'ttml';
export type SourcePlatform = 'youtube_music' | 'spotify' | 'apple_music' | 'musixmatch' | 'golyrics' | 'lrclib';

export interface Lyric {
    format: LyricType;
    content: string;
}

export interface SaveLyricsData {
    source_platform: SourcePlatform;
    source_track_id: string;
    musixmatch_track_id?: number; // Optional, for MM
    lyric_content: string;
    lyric_format: LyricType;
}

export interface NegativeCacheData {
    source_platform: SourcePlatform;
    source_track_id: string;
}

export class CacheService {
    constructor(private env: Env) {}

    async getMusixmatchLyrics(source_platform: SourcePlatform, source_track_id: string): Promise<{ lyrics: Lyric[], lastUpdatedAt: number } | null> {
        const stmt = this.env.DB.prepare(`
            SELECT
              t.id as track_id,
              t.last_accessed_at,
              t.last_updated_at,
              l.format,
              l.r2_object_key
            FROM track_mappings AS tm
            JOIN tracks AS t ON tm.track_id = t.id
            LEFT JOIN lyrics AS l ON t.id = l.track_id
            WHERE tm.source_platform = ?1 AND tm.source_track_id = ?2
        `);
        const { results } = await stmt.bind(source_platform, source_track_id).all<{
            track_id: number;
            last_accessed_at: number;
            last_updated_at: number;
            format: LyricType | null;
            r2_object_key: string | null;
        }>();

        if (!results || results.length === 0) {
            observe({"musixMatchCacheLookup": {source_platform, source_track_id, hit: false}});
            return null;
        }

        const first = results[0];
        const internalTrackId = first.track_id;
        const lastAccessedAt = first.last_accessed_at;
        const lastUpdatedAt = first.last_updated_at || lastAccessedAt; // Fallback

        // Update access time
        const now = Math.floor(Date.now() / 1000);
        if (now - lastAccessedAt > 86400) {
            addAwait(
                this.env.DB.prepare("UPDATE tracks SET last_accessed_at = ?1 WHERE id = ?2")
                    .bind(now, internalTrackId).run()
            );
        }

        const lyricsPromises = results
            .filter((row: any) => row.r2_object_key && row.format)
            .map(async (meta: any) => {
                const object = await this.env.LYRICS_BUCKET.get(meta.r2_object_key!);
                if (!object) return null;
                const compressedContent = await object.arrayBuffer();
                const content = pako.inflate(compressedContent, { to: 'string' });
                return { format: meta.format!, content };
            });

        const lyrics = (await Promise.all(lyricsPromises)).filter((l: any): l is Lyric => l !== null);
        
        return { lyrics, lastUpdatedAt };
    }

    async saveMusixmatchLyrics(data: SaveLyricsData): Promise<boolean> {
        if (!data.musixmatch_track_id) return false;
        try {
            const compressedContent = pako.deflate(data.lyric_content);
            const r2ObjectKey = `${data.musixmatch_track_id}/${data.lyric_format}.gz`;
            
            await this.env.LYRICS_BUCKET.put(r2ObjectKey, compressedContent);

            const now = Math.floor(Date.now() / 1000);

            // Insert/Update track
            await this.env.DB.prepare(`
                INSERT INTO tracks (musixmatch_track_id, last_accessed_at, last_updated_at) 
                VALUES (?1, ?2, ?2) 
                ON CONFLICT(musixmatch_track_id) DO UPDATE SET last_accessed_at = ?2, last_updated_at = ?2
            `).bind(data.musixmatch_track_id, now).run();

            const track = await this.env.DB.prepare("SELECT id FROM tracks WHERE musixmatch_track_id = ?1")
                .bind(data.musixmatch_track_id).first<{id: number}>();
            
            if (!track) throw new Error("Track creation failed");

            const finalStmts = [
                this.env.DB.prepare(`
                    INSERT INTO lyrics (track_id, format, r2_object_key) 
                    VALUES (?1, ?2, ?3) 
                    ON CONFLICT(r2_object_key) DO NOTHING
                `).bind(track.id, data.lyric_format, r2ObjectKey), // Note: r2_object_key is UNIQUE in schema? Yes.
                
                this.env.DB.prepare(`
                    INSERT INTO track_mappings (source_platform, source_track_id, track_id) 
                    VALUES (?1, ?2, ?3) 
                    ON CONFLICT DO NOTHING
                `).bind(data.source_platform, data.source_track_id, track.id)
            ];

            await this.env.DB.batch(finalStmts);
            return true;
        } catch (e) {
            console.error("Save MM failed", e);
            return false;
        }
    }

    async getGoLyrics(source_platform: SourcePlatform, source_track_id: string): Promise<{ lyrics: Lyric[], lastUpdatedAt: number } | null> {
        const stmt = this.env.DB.prepare(`
            SELECT r2_key, last_accessed_at, last_updated_at FROM go_lyrics_cache WHERE video_id = ?1 AND source_platform = ?2
        `);
        const result = await stmt.bind(source_track_id, source_platform).first<{ r2_key: string, last_accessed_at: number, last_updated_at: number }>();

        if (!result) return null;

        const now = Math.floor(Date.now() / 1000);
        if (now - result.last_accessed_at > 86400) {
             addAwait(
                this.env.DB.prepare("UPDATE go_lyrics_cache SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3")
                .bind(now, source_track_id, source_platform).run()
            );
        }
        
        const lastUpdatedAt = result.last_updated_at || result.last_accessed_at;

        const object = await this.env.LYRICS_BUCKET.get(result.r2_key);
        if (!object) return null;
        const compressed = await object.arrayBuffer();
        const content = pako.inflate(compressed, { to: 'string' });
        
        return { lyrics: [{ format: 'ttml', content }], lastUpdatedAt }; 
    }

    async saveGoLyrics(data: SaveLyricsData): Promise<boolean> {
        try {
            const compressed = pako.deflate(data.lyric_content);
            const r2Key = `${data.source_track_id}/${data.lyric_format}.gz`;
            await this.env.LYRICS_BUCKET.put(r2Key, compressed);

            const now = Math.floor(Date.now() / 1000);
            await this.env.DB.prepare(`
                INSERT INTO go_lyrics_cache (video_id, source_platform, r2_key, last_accessed_at, last_updated_at) 
                VALUES (?1, ?2, ?3, ?4, ?4) 
                ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, last_accessed_at = ?4, last_updated_at = ?4
            `).bind(data.source_track_id, data.source_platform, r2Key, now).run();
            return true;
        } catch (e) {
            return false;
        }
    }

    async getNegative(source_platform: SourcePlatform, source_track_id: string): Promise<boolean> {
        const stmt = this.env.DB.prepare("SELECT 1 FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2");
        const result = await stmt.bind(source_platform, source_track_id).first();
        return !!result;
    }

    async saveNegative(source_platform: SourcePlatform, source_track_id: string): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        await this.env.DB.prepare("INSERT INTO negative_mappings (source_platform, source_track_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING")
            .bind(source_platform, source_track_id, now).run();
    }
    
    async deleteCache(videoId: string): Promise<void> {
         // Delete from tracks/mappings (Musixmatch)
         // We need to find track_id first to delete lyrics?
         // CASCADE delete on track_id should handle lyrics if we delete track?
         // But multiple mappings might point to same track.
         // If we just want to clear cache for THIS video:
         
         // 1. Delete mapping
         const mapping = await this.env.DB.prepare("SELECT track_id FROM track_mappings WHERE source_track_id = ?1").bind(videoId).first<{track_id: number}>();
         if (mapping) {
             // Should we delete the track too? Only if no other mappings point to it.
             // For simplicity, just delete the mapping. The track might be orphaned but that's okay for cache clearing.
             // Or we can delete the track if we are sure.
             // Let's delete the mapping.
             await this.env.DB.prepare("DELETE FROM track_mappings WHERE source_track_id = ?1").bind(videoId).run();
         }
         
         // 2. Delete GoLyrics cache
         await this.env.DB.prepare("DELETE FROM go_lyrics_cache WHERE video_id = ?1").bind(videoId).run();
         
         // 3. Delete YouTube metadata cache
         await this.env.DB.prepare("DELETE FROM youtube_cache WHERE video_id = ?1").bind(videoId).run();
         
         // 4. Delete negative cache
         await this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_track_id = ?1").bind(videoId).run();
    }
}