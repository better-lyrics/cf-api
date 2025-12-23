import { LyricsResponse } from './LyricUtils';
import { observe } from './index';

const LRCLIB_API_CACHED = 'https://lrclib.net/api/get-cached';
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


export async function getLyricLibLyrics(artist: string, song: string, album: string | null, duration: string | null | undefined, useCached = false): Promise<LyricsResponse | null> {
    let fetchUrl = new URL(LRCLIB_API);
    fetchUrl.searchParams.append('artist_name', artist);
    fetchUrl.searchParams.append('track_name', song);
    if (album) {
        fetchUrl.searchParams.append('album_name', album);
    }
    if (duration) {
        fetchUrl.searchParams.append('duration', duration);
    }
    return fetch(fetchUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Better Lyrics CF API (https://github.com/adaliea/better-lyrics-cf-api)'
            }
        }
    ).then(res => {
        return res.json() as Promise<LrcLibResponse>;
    })
        .then(json => {
            let lrcLibResponse: LrcLibResponse = json;
            return {
                richSynced: null,
                synced: lrcLibResponse.syncedLyrics,
                unsynced: lrcLibResponse.plainLyrics,
                debugInfo: null,
                ttml: null
            };
        })
        .catch(err => {
            observe({ 'lrclibError': err });
            return null;
        });
}
