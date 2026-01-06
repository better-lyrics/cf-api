// Types for our responses and data
import { awaitLists, observe } from '../observability';
import { diffArrays } from 'diff';
import { LyricsResponse, parseLrc } from '../LyricUtils';
import { CacheService, Lyric } from '../services/CacheService';
import { Env } from '../types';

interface MusixmatchResponse {
    message: Message;
}

export interface Message {
    header: Header;
    body: Body;
}

export interface Header {
    status_code: number;
    execute_time: number;
    confidence: number;
    mode: string;
    cached: number;
}

export interface Body {
    richsync: any;
    subtitle: any;
    track: Track,
    user_token: string
}

export interface Track {
    track_id: number;
    track_mbid: string;
    track_isrc: string;
    commontrack_isrcs: string[][];
    track_spotify_id: string;
    commontrack_spotify_ids: string[];
    commontrack_itunes_ids: number[];
    track_soundcloud_id: number;
    track_xboxmusic_id: string;
    track_name: string;
    track_name_translation_list: any[];
    track_rating: number;
    track_length: number;
    commontrack_id: number;
    instrumental: number;
    explicit: number;
    has_lyrics: number;
    has_lyrics_crowd: number;
    has_subtitles: number;
    has_richsync: number;
    has_track_structure: number;
    num_favourite: number;
    lyrics_id: number;
    subtitle_id: number;
    album_id: number;
    album_name: string;
    album_vanity_id: string;
    artist_id: number;
    artist_mbid: string;
    artist_name: string;
    album_coverart_100x100: string;
    album_coverart_350x350: string;
    album_coverart_500x500: string;
    album_coverart_800x800: string;
    track_share_url: string;
    track_edit_url: string;
    commontrack_vanity_id: string;
    restricted: number;
    first_release_date: string;
    updated_time: string;
    primary_genres: PrimaryGenres;
    secondary_genres: SecondaryGenres;
}

export interface PrimaryGenres {
    music_genre_list: MusicGenreList[];
}

export interface MusicGenreList {
    music_genre: MusicGenre;
}

export interface MusicGenre {
    music_genre_id: number;
    music_genre_parent_id: number;
    music_genre_name: string;
    music_genre_name_extended: string;
    music_genre_vanity: string;
}

export interface SecondaryGenres {
    music_genre_list: any[];
}

export interface RichSyncBody {
    /**
     * Start Time (s)
     */
    ts: number;
    /**
     * End Time (s)
     */
    te: number;
    l:  TimedWord[];
    /**
     * Lyric Text (s)
     */
    x:  string;
}

export interface TimedWord {
    /**
     * Word (can be a space/similar)
     */
    c: string;
    /**
     * Offset in s from the lyric start time
     */
    o: number;
}


export interface MatchingTimedWord {
    /**
     * Word (can be a space/similar)
     */
    word: string;
    wordTime: number;
}

// These fields can persist through multiple requests to the API
let token: string | null = null; // null means we haven't gotten a token yet
let tokenRetryCount = 0;
let tokenRetryMax = 3;

const DEFAULT_REFETCH_THRESHOLD = 7 * 86400; // 1 week
const DEFAULT_REFETCH_CHANCE = 0.2; // 20% chance if old

export class Musixmatch {
    private cookies: { key: string, cookie: string }[] = [];
    private readonly ROOT_URL = 'https://apic-desktop.musixmatch.com/ws/1.1/';
    private cache = caches.default;
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.cacheService = new CacheService(env);
    }

    private async _get(action: string, query: [string, string][]): Promise<Response> {
        query.push(['app_id', 'web-desktop-app-v1.0']);
        if (token && action !== 'token.get') {
            query.push(['usertoken', token]);
        }

        let url = new URL(this.ROOT_URL + action);
        query.forEach(([key, value]) => url.searchParams.set(key, value));

        let cacheUrl = url.toString();
        let cachedResponse = await this.cache.match(cacheUrl);
        if (cachedResponse) {
            observe({ 'musixMatchCache': { found: true, cacheUrl: cacheUrl } });
            return cachedResponse;
        } else {
            observe({ 'musixMatchCache': { found: false, cacheUrl: cacheUrl } });
        }


        const t = Date.now().toString();
        url.searchParams.set("t", t)
        let response;
        let loopCount = 0;

        do {
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.musixmatch.com',
                'Referer': 'https://www.musixmatch.com/',
            } as Record<string, string>;

            if (this.cookies.length > 0) {
                headers['Cookie'] = this.cookies.map(({ key, cookie }) => {
                    return key + "=" + cookie;
                }).join(";");
            }

            response = await fetch(url.toString(), {
                headers,
                redirect: "manual",
            });

            // Store any new cookies
            const newCookies = response.headers.getAll('Set-Cookie');
            newCookies.forEach((cookieStr) => {
                    let splitIndex = cookieStr.indexOf('=');
                    if (splitIndex > -1) {
                        let key = cookieStr.substring(0, splitIndex);
                        let cookie = cookieStr.substring(splitIndex + 1, cookieStr.length).split(";")[0];
                        this.cookies.push({ key, cookie });
                    }
                },
            );
            const location = response.headers.get('Location');
            if (location) {
                url = new URL("https://apic-desktop.musixmatch.com" + location);
            }
            loopCount += 1;
            if (loopCount > 5) {
                throw new Error("too many redirects");
            }
        } while ((response.status === 302 || response.status === 301));
        if (response.body === null) {
            return Promise.reject("Body is missing");
        }

        let teeBody = response.body.tee();
        response = new Response(teeBody[1], response); // make mutable
        let keys = [...response.headers.keys()];
        keys.forEach((key) => response.headers.delete(key));


        if (response.status === 200) {
            if (action === 'token.get') {
                response.headers.set('Cache-control', 'public; max-age=3600');
            } else {
                response.headers.set('Cache-control', 'public; max-age=604800');
            }
            awaitLists.add(this.cache.put(cacheUrl, response));
        }

        return new Response(teeBody[0], response);
    }

    async getToken(): Promise<void> {
        if (token === null && tokenRetryCount < tokenRetryMax) {
            let response = await this._get('token.get', [['user_language', 'en']]);
            const data = await response.json() as MusixmatchResponse;

            observe({ 'tokenStatus': data.message.header.status_code, 'tokenRetryCount': tokenRetryCount });
            tokenRetryCount++;
            if (data.message.header.status_code === 401) {
                throw Error('Failed to get token');
            }

            token = data.message.body.user_token;
        } else {
            if (token === null) {
                observe({ 'tokenStatus': 'too many retries', 'tokenRetryCount': tokenRetryCount });
                throw Error('Failed to get token');
            } else {
                observe({ 'tokenStatus': 'token already valid', 'tokenRetryCount': tokenRetryCount });
            }
        }
    }

    private formatTime(timeInSeconds: number): string {
        const minutes = Math.floor(timeInSeconds / 60);
        const seconds = Math.floor(timeInSeconds % 60);
        const hundredths = Math.floor((timeInSeconds % 1) * 100);

        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
    }

    private async getLrcWordByWord(trackId: string | number, lrcLyrics: Promise<LyricsResponse | null | void> | null):
        Promise<LyricsResponse | null> {


        let musixmatchBasicLyrics: Promise<LyricsResponse | null> = this.getLrcById(trackId);
        let basicLrcPromise: Promise<LyricsResponse | null | void>;
        if (lrcLyrics !== null) {
            basicLrcPromise = lrcLyrics;
        } else {
            basicLrcPromise = musixmatchBasicLyrics;
        }
        const response = await this._get('track.richsync.get', [['track_id', String(trackId)]]);
        const data = await response.json() as MusixmatchResponse;
        observe({ 'responseData': JSON.stringify(data) });
        let mean, variance;

        if (!response.ok || data.message.header.status_code !== 200) {
            return null;
        }

        const richSyncBody = JSON.parse(data.message.body.richsync.richsync_body) as RichSyncBody[];

        let lrcStr = '';
        let richSyncTokenArray: MatchingTimedWord[] = [];

        for (const item of richSyncBody) {
            lrcStr += `[${this.formatTime(item.ts)}] `;

            for (const lyric of item.l) {
                const time = this.formatTime(item.ts + lyric.o);
                lrcStr += `<${time}> ${lyric.c} `;

                richSyncTokenArray.push({
                    word: lyric.c, wordTime: item.ts + lyric.o
                });
            }
            richSyncTokenArray.push({
                word: '\n', wordTime: -1
            });

            const endTime = this.formatTime(item.te);
            lrcStr += `<${endTime}>\n`;
        }



        let basicLrc = await basicLrcPromise;
        if (basicLrc && basicLrc.synced) {
            let basicLrcOffset = [] as number[];
            let diffDebug: { op: string, text: string }[] = [];

            let parsedLrc = parseLrc(basicLrc.synced);
            let parsedLrcTokenArray: MatchingTimedWord[] = [];
            parsedLrc.forEach(({startTimeMs, words}, index) => {
                let wordsSplit = words.split(' ');
                for (let i = 0; i < wordsSplit.length; i++) {
                    if (i === 0) {
                        parsedLrcTokenArray.push({
                            word: wordsSplit[i], wordTime: startTimeMs / 1000
                        });
                    } else {
                        parsedLrcTokenArray.push({
                            word: wordsSplit[i], wordTime: -1
                        });
                    }

                    if (i !== wordsSplit.length - 1) {
                        parsedLrcTokenArray.push({
                            word: ' ', wordTime: -1
                        });
                    }
                }
                if (index < parsedLrc.length - 1) {
                    parsedLrcTokenArray.push({
                        word: '\n', wordTime: -1
                    });
                }
            });

            if (parsedLrcTokenArray.length > 5000 || richSyncTokenArray.length > 5000) {
                return {
                    richSynced: null, synced: (await musixmatchBasicLyrics)?.synced, unsynced: null, debugInfo: {
                        comment: 'lyrics too long to diff'
                    }, ttml: null
                };
            }
            let diff = diffArrays(parsedLrcTokenArray, richSyncTokenArray, { comparator: (left, right) => left.word.toLowerCase() === right.word.toLowerCase() });

            let leftIndex = 0;
            let rightIndex = 0;
            diff.forEach(change => {
                if (!change.removed && !change.added && change.value && change.count !== undefined) {
                    for (let i = 0; i < change.count; i++) {
                        let leftToken = parsedLrcTokenArray[leftIndex];
                        let rightToken = richSyncTokenArray[rightIndex];

                        if (leftToken.wordTime !== -1 && rightToken.wordTime !== -1) {
                            basicLrcOffset.push(rightToken.wordTime - leftToken.wordTime);
                            // console.log('found matching char with time', leftToken, rightToken);
                        }
                        leftIndex++;
                        rightIndex++;
                    }
                    diffDebug.push({ op: 'MATCH', text: change.value.map(word => word.word).join('') });
                    // console.log('found match', leftIndex, rightIndex, change.value.map(word => word.word).join('') + '\n');
                } else {
                    if (!change.added && change.count !== undefined) {
                        leftIndex += change.count;
                        diffDebug.push({ op: 'REMOVED', text: change.value.map(word => word.word).join('') });
                    }
                    if (!change.removed && change.count !== undefined) {
                        rightIndex += change.count;
                        diffDebug.push({ op: 'ADDED', text: change.value.map(word => word.word).join('') });
                    }
                }
            });

            let meanVar = meanAndVariance(basicLrcOffset);
            mean = meanVar.mean;
            variance = meanVar.variance;
            if (variance < 1.5) {
                lrcStr = `[offset:${addPlusSign(mean)}]\n` + lrcStr;
                return {
                    richSynced: lrcStr, synced: (await musixmatchBasicLyrics)?.synced, unsynced: null, debugInfo: {
                        lyricMatchingStats: { mean, variance, samples: basicLrcOffset, diff: diffDebug }
                    }, ttml: null
                };
            } else {
                return {
                    richSynced: null, synced: (await musixmatchBasicLyrics)?.synced, unsynced: null, debugInfo: {
                        lyricMatchingStats: { mean, variance, samples: basicLrcOffset, diff: diffDebug },
                        comment: 'basic lyrics matched but variance is too high; using basic lyrics instead'
                    }, ttml: null
                };
            }
        }

        return {
            richSynced: lrcStr, synced: null, unsynced: null, debugInfo: {
                comment: 'no synced basic lyrics found'
            }, ttml: null
        };


    }

    private async getLrcById(trackId: string | number): Promise<LyricsResponse | null> {
        // Get the main subtitles
        const response = await this._get('track.subtitle.get', [
            ['track_id', String(trackId)],
            ['subtitle_format', 'lrc'],
        ]);

        if (!response.ok) {
            return null;
        }

        const data = await response.json() as MusixmatchResponse;
        if (!data.message.body?.subtitle?.subtitle_body) {
            return null;
        }

        let lrcStr = data.message.body.subtitle.subtitle_body;

        return { richSynced: null, synced: lrcStr, unsynced: null, debugInfo: null, ttml: null };
    }


    async getLrc(videoId: string, artist: string, track: string, album: string | null, lrcLyrics: Promise<LyricsResponse | null | void> | null, tokenPromise: Promise<void>):
        Promise<LyricsResponse | null> {
        
        // 1. Check Negative Cache
        const isNegative = await this.cacheService.getNegative('youtube_music', videoId);
        if (isNegative) {
            observe({ 'musixmatchNegativeCacheHit': true });
            return null;
        }

        // 2. Check Positive Cache
        let cachedData = await this.cacheService.getMusixmatchLyrics("youtube_music", videoId);
        let forceRefetch = false;

        if (cachedData) {
            // Check stale
            const now = Math.floor(Date.now() / 1000);
            const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : DEFAULT_REFETCH_THRESHOLD;
            const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : DEFAULT_REFETCH_CHANCE;

            if (now - cachedData.lastUpdatedAt > threshold) {
                if (Math.random() < chance) {
                    forceRefetch = true;
                    observe({ 'musixmatchCacheRefetch': true });
                }
            }

            if (!forceRefetch) {
                let richSynced: string | null = null;
                let normalSynced: string | null = null;

                for (const lyric of cachedData.lyrics) {
                    if (lyric.format == "rich_sync") {
                        richSynced = lyric.content;
                    } else if (lyric.format == "normal_sync") {
                        normalSynced = lyric.content;
                    }
                }

                return {
                    richSynced: richSynced, synced: normalSynced, unsynced: null, debugInfo: {
                        lyricMatchingStats: null,
                        comment: 'musixmatch cache'
                    }, ttml: null
                };
            }
        }

        // 3. Fetch from API
        await tokenPromise;
        observe({ 'musixMatchHasValidToken': token !== null });
        if (token === null) {
             return null;
        }

        let query: [string, string][] = [
            ['q_track', track],
            ['q_artist', artist],
            ['page_size', '1'],
            ['page', '1'],
        ];
        if (album) {
            // @ts-ignore
            query.push(['album', album]);
        }
        const response = await this._get('matcher.track.get', query);

        let data = await response.json() as MusixmatchResponse;
        if (data.message.header.status_code === 401) {
            token = null;
        }
        if (data.message.header.status_code !== 200) {
            observe({
                musixMatchCookieError: {
                'invalidStatusCode': data.message.header.status_code,
                body: data.message.body,
                header: data.message.header
                }
            });
            // Negative Cache Save (if 404 or similar, but here status 404 from matcher means not found)
            if (data.message.header.status_code === 404) {
                awaitLists.add(this.cacheService.saveNegative('youtube_music', videoId));
            }
            return null;
        }

        const trackId = data.message.body.track.track_id;
        const hasRichLyrics = data.message.body.track.has_richsync;
        const hasSubtitles = data.message.body.track.has_subtitles;
        const hasLyrics = data.message.body.track.has_lyrics;
        observe({
            'musixMatchHasRichLyrics': hasRichLyrics,
            'musixMatchHasSubtitles': hasSubtitles,
            'musixMatchHasLyrics': hasLyrics
        });
        let result = null;
        if (hasRichLyrics) {
            result = await this.getLrcWordByWord(trackId, lrcLyrics);
        } else if (hasSubtitles) {
            result = await this.getLrcById(trackId);
        }

        if (result) {
            if (result.richSynced) {
                awaitLists.add(
                    this.cacheService.saveMusixmatchLyrics({
                        musixmatch_track_id: Number(trackId),
                        source_platform: "youtube_music",
                        source_track_id: videoId,
                        lyric_format: "rich_sync",
                        lyric_content: result.richSynced,
                    })
                );
            }
            if (result.synced) {
                awaitLists.add(
                    this.cacheService.saveMusixmatchLyrics({
                        musixmatch_track_id: Number(trackId),
                        source_platform: "youtube_music",
                        source_track_id: videoId,
                        lyric_format: 'normal_sync',
                        lyric_content: result.synced,
                    })
                );
            }
        } else {
            // Matcher found track, but no lyrics found in it?
            // Maybe not, maybe just no lyrics YET.
            // But we can negative cache it for a while.
            // Let's assume yes.
             awaitLists.add(this.cacheService.saveNegative('youtube_music', videoId));
        }

        return result;
    }
}


function meanAndVariance(arr: number[]) {
    const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;
    const variance = arr.reduce((acc, val) => acc + (val - mean) ** 2, 0) / arr.length;
    return { mean, variance };
}


function addPlusSign(num: number) {
    if (num > 0) {
        return `+${num}`;
    } else {
        return `${num}`;
    }
}