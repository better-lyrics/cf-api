import { LyricsResponse } from '../LyricUtils';
import { observe, awaitLists } from '../observability';
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

export class LrcLib {
    private cacheService: CacheService;

    constructor(env: Env) {
        this.cacheService = new CacheService(env);
    }

    async getLyrics(videoId: string, artist: string, song: string, album: string | null, duration: string | null | undefined): Promise<LyricsResponse | null> {
        if (await this.cacheService.getNegative('lrclib', videoId)) {
            return null;
        }

        let fetchUrl = new URL(LRCLIB_API);
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
                 awaitLists.add(this.cacheService.saveNegative('lrclib', videoId));
                 return null;
            }

            if (!res.ok) {
                 observe({ 'lrclibError': res.status });
                 return null;
            }

            const json = await res.json() as LrcLibResponse;
            return {
                richSynced: null,
                synced: json.syncedLyrics,
                unsynced: json.plainLyrics,
                debugInfo: null,
                ttml: null
            };
        } catch (err) {
            observe({ 'lrclibError': err });
            return null;
        }
    }
}