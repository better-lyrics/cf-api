import { Env } from '../types';
import pako from 'pako';
import { addAwait } from '../observability';
import type { SpicyLyrics, SpicyTimingType } from '../providers/Spicy';

export type LyricType = 'rich_sync' | 'normal_sync' | 'ttml';
export type SourcePlatform = 'youtube_music' | 'spotify' | 'apple_music' | 'golyrics' | 'lrclib' | 'qq' | 'kugou' | 'binimum' | 'spicy';

export type CachedSpicyLyrics = SpicyLyrics & { lyrics: string, spotifyId: string, lastUpdatedAt: number };

export interface Lyric {
    format: LyricType;
    content: string;
}

export interface SaveLyricsData {
    source_platform: SourcePlatform;
    source_track_id: string;
    lyric_content: string;
    lyric_format: LyricType;
}

export interface NegativeCacheData {
    source_platform: SourcePlatform;
    source_track_id: string;
}

const DEFAULT_NEGATIVE_CACHE_TTL = 0;
const DEFAULT_NEGATIVE_CACHE_TTL_LRCLIB = 0;
const DEFAULT_NEGATIVE_CACHE_TTL_SPICY = 3 * 86400;

export class CacheService {
    constructor(private env: Env) {}

    private async _getBoiduLyrics(tableName: string, source_platform: SourcePlatform, source_track_id: string): Promise<{ lyrics: Lyric[], lastUpdatedAt: number } | null> {
        // Warning: tableName must be sanitized. Since we only pass hardcoded table names, it's safe.
        const stmt = this.env.DB.prepare(`
            SELECT r2_key, last_accessed_at, last_updated_at FROM ${tableName} WHERE video_id = ?1 AND source_platform = ?2
        `);
        const result = await stmt.bind(source_track_id, source_platform).first<{ r2_key: string, last_accessed_at: number, last_updated_at: number }>();

        if (!result) return null;

        const now = Math.floor(Date.now() / 1000);
        if (now - result.last_accessed_at > 86400) {
             addAwait(
                this.env.DB.prepare(`UPDATE ${tableName} SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3`)
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

    private async _saveBoiduLyrics(tableName: string, data: SaveLyricsData, providerName: string): Promise<boolean> {
        try {
            const compressed = pako.deflate(data.lyric_content);
            const r2Key = `${data.source_track_id}/${providerName}_ttml.gz`;
            await this.env.LYRICS_BUCKET.put(r2Key, compressed);

            const now = Math.floor(Date.now() / 1000);
            await this.env.DB.prepare(`
                INSERT INTO ${tableName} (video_id, source_platform, r2_key, last_accessed_at, last_updated_at)
                VALUES (?1, ?2, ?3, ?4, ?4)
                ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, last_accessed_at = ?4, last_updated_at = ?4
            `).bind(data.source_track_id, data.source_platform, r2Key, now).run();
            return true;
        } catch (_e) {
            return false;
        }
    }

    async touchBoiduLyrics(tableName: string, source_platform: SourcePlatform, source_track_id: string): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        await this.env.DB.prepare(`
            UPDATE ${tableName} 
            SET last_updated_at = ?1, last_accessed_at = ?1 
            WHERE video_id = ?2 AND source_platform = ?3
        `).bind(now, source_track_id, source_platform).run();
    }

    async getGoLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this._getBoiduLyrics('go_lyrics_cache', source_platform, source_track_id);
    }

    async saveGoLyrics(data: SaveLyricsData) {
        return this._saveBoiduLyrics('go_lyrics_cache', data, 'go');
    }

    async touchGoLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this.touchBoiduLyrics('go_lyrics_cache', source_platform, source_track_id);
    }

    async getQqLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this._getBoiduLyrics('qq_lyrics_cache', source_platform, source_track_id);
    }

    async saveQqLyrics(data: SaveLyricsData) {
        return this._saveBoiduLyrics('qq_lyrics_cache', data, 'qq');
    }

    async touchQqLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this.touchBoiduLyrics('qq_lyrics_cache', source_platform, source_track_id);
    }

    async getKugouLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this._getBoiduLyrics('kugou_lyrics_cache', source_platform, source_track_id);
    }

    async saveKugouLyrics(data: SaveLyricsData) {
        return this._saveBoiduLyrics('kugou_lyrics_cache', data, 'kugou');
    }

    async touchKugouLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this.touchBoiduLyrics('kugou_lyrics_cache', source_platform, source_track_id);
    }

    async getBinimumLyrics(source_platform: SourcePlatform, source_track_id: string): Promise<{ lyrics: Lyric[], lastUpdatedAt: number, timingType: 'syllable' | 'line' | null } | null> {
        const stmt = this.env.DB.prepare(`
            SELECT r2_key, timing_type, last_accessed_at, last_updated_at FROM binimum_lyrics_cache WHERE video_id = ?1 AND source_platform = ?2
        `);
        const result = await stmt.bind(source_track_id, source_platform).first<{ r2_key: string, timing_type: 'syllable' | 'line' | null, last_accessed_at: number, last_updated_at: number }>();

        if (!result) return null;

        const now = Math.floor(Date.now() / 1000);
        if (now - result.last_accessed_at > 86400) {
            addAwait(
                this.env.DB.prepare("UPDATE binimum_lyrics_cache SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3")
                    .bind(now, source_track_id, source_platform).run()
            );
        }

        const lastUpdatedAt = result.last_updated_at || result.last_accessed_at;

        const object = await this.env.LYRICS_BUCKET.get(result.r2_key);
        if (!object) return null;
        const compressed = await object.arrayBuffer();
        const content = pako.inflate(compressed, { to: 'string' });

        return { lyrics: [{ format: 'ttml', content }], lastUpdatedAt, timingType: result.timing_type };
    }

    async saveBinimumLyrics(data: SaveLyricsData, timingType: 'syllable' | 'line' | null): Promise<boolean> {
        try {
            const compressed = pako.deflate(data.lyric_content);
            const r2Key = `${data.source_track_id}/binimum_ttml.gz`;
            await this.env.LYRICS_BUCKET.put(r2Key, compressed);

            const now = Math.floor(Date.now() / 1000);
            await this.env.DB.prepare(`
                INSERT INTO binimum_lyrics_cache (video_id, source_platform, r2_key, timing_type, last_accessed_at, last_updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, timing_type = ?4, last_accessed_at = ?5, last_updated_at = ?5
            `).bind(data.source_track_id, data.source_platform, r2Key, timingType, now).run();
            return true;
        } catch (_e) {
            return false;
        }
    }

    async touchBinimumLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this.touchBoiduLyrics('binimum_lyrics_cache', source_platform, source_track_id);
    }

    async getSpicyLyrics(source_platform: SourcePlatform, source_track_id: string): Promise<CachedSpicyLyrics | null> {
        const result = await this.env.DB.prepare(`
            SELECT r2_key, spotify_id, timing_type, attribution, last_accessed_at, last_updated_at FROM spicy_lyrics_cache WHERE video_id = ?1 AND source_platform = ?2
        `).bind(source_track_id, source_platform).first<{ r2_key: string, spotify_id: string, timing_type: SpicyTimingType | null, attribution: string | null, last_accessed_at: number, last_updated_at: number }>();

        if (!result) return null;

        const now = Math.floor(Date.now() / 1000);
        if (now - result.last_accessed_at > 86400) {
            addAwait(
                this.env.DB.prepare("UPDATE spicy_lyrics_cache SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3")
                    .bind(now, source_track_id, source_platform).run()
            );
        }

        const object = await this.env.LYRICS_BUCKET.get(result.r2_key);
        if (!object) return null;
        const lyrics = pako.inflate(await object.arrayBuffer(), { to: 'string' });

        return {
            lyrics,
            timingType: result.timing_type,
            attribution: result.attribution ? JSON.parse(result.attribution) : null,
            spotifyId: result.spotify_id,
            lastUpdatedAt: result.last_updated_at,
        };
    }

    async saveSpicyLyrics(source_platform: SourcePlatform, source_track_id: string, data: Omit<CachedSpicyLyrics, 'lastUpdatedAt'>): Promise<boolean> {
        try {
            const r2Key = `${source_track_id}/spicy_ttml.gz`;
            await this.env.LYRICS_BUCKET.put(r2Key, pako.deflate(data.lyrics));

            const now = Math.floor(Date.now() / 1000);
            await this.env.DB.prepare(`
                INSERT INTO spicy_lyrics_cache (video_id, source_platform, r2_key, spotify_id, timing_type, attribution, last_accessed_at, last_updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, spotify_id = ?4, timing_type = ?5, attribution = ?6, last_accessed_at = ?7, last_updated_at = ?7
            `).bind(source_track_id, source_platform, r2Key, data.spotifyId, data.timingType, data.attribution ? JSON.stringify(data.attribution) : null, now).run();
            return true;
        } catch (_e) {
            return false;
        }
    }

    async touchSpicyLyrics(source_platform: SourcePlatform, source_track_id: string) {
        return this.touchBoiduLyrics('spicy_lyrics_cache', source_platform, source_track_id);
    }

    async deleteSpicyLyrics(videoId: string) {
        return this.deleteR2BackedRow('spicy_lyrics_cache', videoId);
    }

    async deleteSpicyLyricsUpdatedBefore(cutoff: number): Promise<number> {
        let deleted = 0;
        for (;;) {
            // D1 allows at most 100 bound parameters per statement.
            const { results } = await this.env.DB.prepare(
                "SELECT rowid AS id, r2_key FROM spicy_lyrics_cache WHERE last_updated_at < ?1 LIMIT 99"
            ).bind(cutoff).all<{ id: number, r2_key: string }>();
            if (results.length === 0) return deleted;

            await this.env.LYRICS_BUCKET.delete(results.map(row => row.r2_key));
            await this.env.DB.prepare(`DELETE FROM spicy_lyrics_cache WHERE rowid IN (${results.map((_, i) => `?${i + 1}`).join(', ')})`)
                .bind(...results.map(row => row.id)).run();
            deleted += results.length;
        }
    }

    private async deleteR2BackedRow(table: string, videoId: string): Promise<void> {
        const row = await this.env.DB.prepare(`SELECT r2_key FROM ${table} WHERE video_id = ?1`).bind(videoId).first<{r2_key: string}>();
        if (row) {
            addAwait(this.env.LYRICS_BUCKET.delete(row.r2_key));
            await this.env.DB.prepare(`DELETE FROM ${table} WHERE video_id = ?1`).bind(videoId).run();
        }
    }

    async getLrcLib(source_platform: SourcePlatform, source_track_id: string): Promise<{ synced: string | null, unsynced: string | null, lastUpdatedAt: number } | null> {
        const stmt = this.env.DB.prepare(`
            SELECT r2_key, last_accessed_at, last_updated_at FROM lrclib_cache WHERE video_id = ?1 AND source_platform = ?2
        `);
        const result = await stmt.bind(source_track_id, source_platform).first<{ r2_key: string, last_accessed_at: number, last_updated_at: number }>();

        if (!result) return null;

        const now = Math.floor(Date.now() / 1000);
        if (now - result.last_accessed_at > 86400) {
            addAwait(
                this.env.DB.prepare("UPDATE lrclib_cache SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3")
                    .bind(now, source_track_id, source_platform).run()
            );
        }

        const lastUpdatedAt = result.last_updated_at || result.last_accessed_at;

        const object = await this.env.LYRICS_BUCKET.get(result.r2_key);
        if (!object) return null;
        const compressed = await object.arrayBuffer();
        const content = pako.inflate(compressed, { to: 'string' });

        try {
            return { ...JSON.parse(content), lastUpdatedAt };
        } catch (e) {
            console.error("Failed to parse LrcLib cache", e);
            return null;
        }
    }

    async saveLrcLib(data: SaveLyricsData): Promise<boolean> {
        try {
            const compressed = pako.deflate(data.lyric_content);
            const r2Key = `${data.source_track_id}/lrclib.gz`;
            await this.env.LYRICS_BUCKET.put(r2Key, compressed);

            const now = Math.floor(Date.now() / 1000);
            await this.env.DB.prepare(`
                INSERT INTO lrclib_cache (video_id, source_platform, r2_key, last_accessed_at, last_updated_at)
                VALUES (?1, ?2, ?3, ?4, ?4)
                ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, last_accessed_at = ?4, last_updated_at = ?4
            `).bind(data.source_track_id, data.source_platform, r2Key, now).run();
            return true;
        } catch (e) {
            console.error("Save LrcLib failed", e);
            return false;
        }
    }

    async touchLrcLib(source_platform: SourcePlatform, source_track_id: string): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        await this.env.DB.prepare(`
            UPDATE lrclib_cache 
            SET last_updated_at = ?1, last_accessed_at = ?1 
            WHERE video_id = ?2 AND source_platform = ?3
        `).bind(now, source_track_id, source_platform).run();
    }

    async getNegative(source_platform: SourcePlatform, source_track_id: string): Promise<{ hit: boolean, stale: boolean }> {
        const stmt = this.env.DB.prepare("SELECT created_at FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2");
        const result = await stmt.bind(source_platform, source_track_id).first<{ created_at: number }>();

        if (!result) return { hit: false, stale: false };

        const now = Math.floor(Date.now() / 1000);
        let ttl = DEFAULT_NEGATIVE_CACHE_TTL;

        if (source_platform === 'lrclib') {
            ttl = this.env.NEGATIVE_CACHE_TTL_LRCLIB ? parseInt(this.env.NEGATIVE_CACHE_TTL_LRCLIB) : DEFAULT_NEGATIVE_CACHE_TTL_LRCLIB;
        } else if (source_platform === 'spicy') {
            ttl = DEFAULT_NEGATIVE_CACHE_TTL_SPICY;
        }

        if (now - result.created_at > ttl) {
            return { hit: true, stale: true };
        }

        return { hit: true, stale: false };
    }

    async saveNegative(source_platform: SourcePlatform, source_track_id: string): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        // Using UPSERT to update timestamp if it already exists (e.g. extending negative cache or re-affirming it)
        await this.env.DB.prepare(`
            INSERT INTO negative_mappings (source_platform, source_track_id, created_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(source_platform, source_track_id) DO UPDATE SET created_at = ?3
        `).bind(source_platform, source_track_id, now).run();
    }

    async deleteCache(videoId: string): Promise<void> {
         // 1. Delete Boidu sources and cleanup R2
         const boiduSources = ['go_lyrics_cache', 'qq_lyrics_cache', 'kugou_lyrics_cache', 'binimum_lyrics_cache', 'spicy_lyrics_cache'];
         for (const table of boiduSources) {
             await this.deleteR2BackedRow(table, videoId);
         }

         // 2. Delete YouTube metadata cache
         await this.env.DB.prepare("DELETE FROM youtube_cache WHERE video_id = ?1").bind(videoId).run();

         // 3. Delete LrcLib cache and cleanup R2
         const lrcLibRow = await this.env.DB.prepare("SELECT r2_key FROM lrclib_cache WHERE video_id = ?1").bind(videoId).first<{r2_key: string}>();
         if (lrcLibRow) {
             addAwait(this.env.LYRICS_BUCKET.delete(lrcLibRow.r2_key));
             await this.env.DB.prepare("DELETE FROM lrclib_cache WHERE video_id = ?1").bind(videoId).run();
         }

         // 4. Delete negative cache
         await this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_track_id = ?1").bind(videoId).run();
    }
}
