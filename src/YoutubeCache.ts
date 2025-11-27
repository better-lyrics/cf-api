import { awaitLists, observe } from './index';
import { env } from 'cloudflare:workers';

export interface YoutubeCacheData {
    video_id: string;
    song: string | null;
    artists: string[] | null;
    album: string | null;
    duration: number | null;
}

let session: D1DatabaseSession;

export async function getYoutubeCache(videoId: string): Promise<YoutubeCacheData | null> {
    if (!session) {
        session = env.DB.withSession();
    }

    const stmt = session.prepare(
        'SELECT song, artists, album, duration, last_accessed_at FROM youtube_cache WHERE video_id = ?1'
    );
    const result = await stmt.bind(videoId).first<{ song: string | null; artists: string | null; album: string | null; duration: number | null; last_accessed_at: number }>();

    if (!result) {
        observe({ youtubeCacheLookup: { videoId, hit: false } });
        return null;
    }

    observe({ youtubeCacheLookup: { videoId, hit: true } });

    const now = Math.floor(Date.now() / 1000);
    if (now - result.last_accessed_at > 86400) { // 1 day
        const updateTimestampPromise = session.prepare(
            'UPDATE youtube_cache SET last_accessed_at = ?1 WHERE video_id = ?2'
        ).bind(now, videoId).run();
        awaitLists.add(updateTimestampPromise);
    }

    return {
        video_id: videoId,
        song: result.song,
        artists: result.artists ? result.artists.split(',') : null,
        album: result.album,
        duration: result.duration,
    };
}

export async function setYoutubeCache(data: YoutubeCacheData): Promise<void> {
    if (!session) {
        session = env.DB.withSession();
    }

    const stmt = session.prepare(
        'INSERT INTO youtube_cache (video_id, song, artists, album, duration, last_accessed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(video_id) DO UPDATE SET song = ?2, artists = ?3, album = ?4, duration = ?5, last_accessed_at = ?6'
    );

    const artists = data.artists ? data.artists.join(',') : null;
    const now = Math.floor(Date.now() / 1000);

    try {
        await stmt.bind(data.video_id, data.song, artists, data.album, data.duration, now).run();
        observe({ youtubeCacheSave: { success: true, data } });
    } catch (error) {
        observe({ youtubeCacheSave: { success: false, data, error } });
    }
}
