import { observe, addAwait } from '../observability';
import { CacheService } from '../services/CacheService';
import { Env } from '../types';

const LRCLIB_API = 'https://lrclib.net/api/get';

export interface LrcLibResponse {
    id: number;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumental: boolean;
    plainLyrics: string;
    syncedLyrics: string;
}

export interface LrcLibLyrics {
    synced: string | null;
    unsynced: string | null;
}

export class LrcLib {
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.cacheService = new CacheService(env);
    }

    private async fetchAndSave(videoId: string, artist: string, song: string, album: string | null, duration: string | null | undefined): Promise<LrcLibLyrics | null> {
        const fetchUrl = new URL(LRCLIB_API);
        fetchUrl.searchParams.append('artist_name', artist);
        fetchUrl.searchParams.append('track_name', song);
        if (album) {
            fetchUrl.searchParams.append('album_name', album);
        }
        if (duration) {
            fetchUrl.searchParams.append('duration', duration);
        }

        try {
            const res = await fetch(fetchUrl.toString(), {
                method: 'GET',
                headers: {
                    'User-Agent': 'Better Lyrics CF API (https://github.com/adaliea/better-lyrics-cf-api)'
                }
            });

            if (res.status === 404) {
                 addAwait(this.cacheService.saveNegative('lrclib', videoId));
                 return null;
            }

            if (!res.ok) {
                 observe({ 'lrclibError': res.status });
                 return null;
            }

            const json = await res.json() as LrcLibResponse;

            // If we found lyrics, ensure negative cache is cleared
            addAwait(this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2")
                .bind('lrclib', videoId).run());

            if (json.syncedLyrics || json.plainLyrics) {
                addAwait(this.cacheService.saveLrcLib({
                    source_platform: 'youtube_music',
                    source_track_id: videoId,
                    lyric_content: JSON.stringify({ synced: json.syncedLyrics, unsynced: json.plainLyrics }),
                    lyric_format: 'normal_sync'
                }));
            }

            return {
                synced: json.syncedLyrics,
                unsynced: json.plainLyrics
            };
        } catch (err) {
            observe({ 'lrclibError': err });
            return null;
        }
    }

    async getLyrics(videoId: string, artist: string, song: string, album: string | null, duration: string | null | undefined, force: boolean = false): Promise<LrcLibLyrics & { action?: string, timestamp?: number, error?: string } | null> {
        // 1. Check Positive Cache (always check for comparison)
        const cachedData = await this.cacheService.getLrcLib("youtube_music", videoId);

        if (!force) {
            // 1. Check Negative Cache
            const negativeStatus = await this.cacheService.getNegative('lrclib', videoId);
            if (negativeStatus.hit) {
                if (negativeStatus.stale) {
                    // SWR: Return null, but fetch in background
                    addAwait(this.fetchAndSave(videoId, artist, song, album, duration));
                }
                return null;
            }

            let shouldRefetch = false;

            if (cachedData) {
                const now = Math.floor(Date.now() / 1000);
                const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : 1 * 86400;
                const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : 0.2;

                if (now - cachedData.lastUpdatedAt > threshold) {
                    if (Math.random() < chance) {
                        shouldRefetch = true;
                        observe({ 'lrclibCacheRefetch': true });
                    }
                }

                if (shouldRefetch) {
                    addAwait(this.fetchAndSave(videoId, artist, song, album, duration));
                }

                return {
                    synced: cachedData.synced,
                    unsynced: cachedData.unsynced,
                    action: 'same',
                    timestamp: cachedData.lastUpdatedAt
                };
            }
        }

        // 3. Fetch Synchronously
        try {
            const result = await this.fetchAndSave(videoId, artist, song, album, duration);
            if (result) {
                let action = 'updated';
                if (cachedData && cachedData.synced === result.synced && cachedData.unsynced === result.unsynced) {
                    action = 'same';
                }
                return { ...result, action: action, timestamp: Math.floor(Date.now() / 1000) };
            }
            return null;
        } catch (e: any) {
            return { synced: null, unsynced: null, action: 'failed', error: e.message, timestamp: Math.floor(Date.now() / 1000) };
        }
    }
}
