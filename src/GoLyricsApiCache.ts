import { awaitLists, observe } from './index';
import pako from 'pako';
import { env } from 'cloudflare:workers';

export interface SaveLyricsData {
    source_track_id: string;
    source_platform: SourcePlatform;
    lyric_content: string; // The raw, uncompressed content
    lyric_format: LyricType;
}

export interface Lyric {
    format: LyricType;
    content: string;
}

type LyricType = 'ttml';
type SourcePlatform = 'youtube_music' | 'spotify' | 'apple_music';

interface D1CacheResult {
    r2_key: string;
    last_accessed_at: number;
}

let session: D1DatabaseSession;

export async function getLyricsFromCache(
    source_platform: SourcePlatform,
    source_track_id: string,
): Promise<Lyric[] | null> {
    if (!session) {
        session = env.DB.withSession()
    }

    const stmt = session.prepare(`
        SELECT r2_key, last_accessed_at FROM go_lyrics_cache WHERE video_id = ?1 AND source_platform = ?2
    `);
    const result = await stmt.bind(source_track_id, source_platform).first<D1CacheResult>();

    if (!result) {
        observe({"goLyricsApiCacheLookup": {source_track_id, source_platform, found: false}});
        return null;
    }

    observe({"goLyricsApiCacheLookup": {source_track_id, source_platform, found: true, r2_key: result.r2_key}});

    const now = Math.floor(Date.now() / 1000);
    if (now - result.last_accessed_at > 86400) { // 86400 seconds = 1 day
        observe({'goLyricsApiCacheTimestampUpdate': {updatedAt: now, source_track_id, source_platform}});
        const updateStmt = session.prepare(
            "UPDATE go_lyrics_cache SET last_accessed_at = ?1 WHERE video_id = ?2 AND source_platform = ?3"
        );
        awaitLists.add(updateStmt.bind(now, source_track_id, source_platform).run());
    }

    const object = await env.LYRICS_BUCKET.get(result.r2_key);
    if (!object) {
        console.error(`CACHE ERROR: R2 object not found for key: ${result.r2_key}`);
        return null;
    }
    const compressedContent = await object.arrayBuffer();
    const content = pako.inflate(compressedContent, { to: 'string' });

    return [{ format: 'ttml', content }];
}

export async function saveLyricsToCache(data: SaveLyricsData): Promise<boolean> {
    try {
        if (!session) {
            session = env.DB.withSession()
        }

        const compressedContent: Uint8Array = pako.deflate(data.lyric_content);
        const r2ObjectKey = `${data.source_track_id}/${data.lyric_format}.gz`;

        await env.LYRICS_BUCKET.put(r2ObjectKey, compressedContent);
        observe({goLyricsApiCacheSavedCompressedObject: {r2ObjectKey}})

        const stmt = session.prepare(
            "INSERT INTO go_lyrics_cache (video_id, source_platform, r2_key, last_accessed_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(video_id, source_platform) DO UPDATE SET r2_key = ?3, last_accessed_at = ?4"
        );
        await stmt.bind(data.source_track_id, data.source_platform, r2ObjectKey, Math.floor(Date.now() / 1000)).run();

        observe({goLyricsApiCacheSave: {success: true, data}})
        return true;

    } catch (error) {
        observe({goLyricsApiCacheSave: {success: false, data, error}})
        return false;
    }
}