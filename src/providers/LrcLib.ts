import { LyricsResponse } from '../LyricUtils';
import { observe, addAwait } from '../observability';
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
    private env: Env;

    constructor(env: Env) {
        this.env = env;
    }

    private async fetchAndSave(videoId: string, artist: string, song: string, album: string | null, duration: string | null | undefined): Promise<LyricsResponse | null> {
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

    async getLyrics(videoId: string, artist: string, song: string, album: string | null, duration: string | null | undefined): Promise<LyricsResponse | null> {
        return this.fetchAndSave(videoId, artist, song, album, duration);
    }
}
