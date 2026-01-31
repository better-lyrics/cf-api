import { addAwait, observe } from '../observability';
import { LyricsResponse } from '../LyricUtils';
import { CacheService } from '../services/CacheService';
import { Env } from '../types';

const Constants = {
    LYRICS_API_URL: 'https://lyrics-api.boidu.dev/getLyrics'
}

export interface GoLyricsApiParameters {
    song: string;
    artist: string;
    album: string | null;
    duration: string;
}

const DEFAULT_REFETCH_THRESHOLD = 0 * 86400;
const DEFAULT_REFETCH_CHANCE = 1;

export class GoLyricsApi {
    private readonly ROOT_URL = Constants.LYRICS_API_URL;
    private cache = caches.default;
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.cacheService = new CacheService(env);
    }

    private async _get(providerParameters: GoLyricsApiParameters): Promise<Response> {
        const url = new URL(this.ROOT_URL);
        url.searchParams.append("s", providerParameters.song);
        url.searchParams.append("a", providerParameters.artist);
        url.searchParams.append("d", String(providerParameters.duration));
        if (providerParameters.album != null) {
            url.searchParams.append("al", providerParameters.album);
        }

        let cacheUrl = url.toString();
        let cachedResponse = await this.cache.match(cacheUrl);
        if (cachedResponse) {
            observe({ 'goLyricsApiCache': { found: true, cacheUrl: cacheUrl } });
            return cachedResponse;
        } else {
            observe({ 'goLyricsApiCache': { found: false, cacheUrl: cacheUrl } });
        }

        const response = await fetch(url.toString(), {
            headers: {
                "User-Agent": "Better Lyrics Cloudflare API",
                'X-API-KEY': this.env.GO_API_KEY
            },

        });

        if (response.body === null) {
            return Promise.reject("Body is missing");
        }

        let teeBody = response.body.tee();
        let newResponse = new Response(teeBody[1], response); // make mutable
        let keys = [...newResponse.headers.keys()];
        keys.forEach((key) => newResponse.headers.delete(key));

        if (newResponse.status === 200) {
            newResponse.headers.set('Cache-control', 'public; max-age=604800');
            addAwait(this.cache.put(cacheUrl, newResponse));
        }

        return new Response(teeBody[0], newResponse);
    }

    private async fetchAndSave(videoId: string, providerParameters: GoLyricsApiParameters): Promise<LyricsResponse | null> {
        const response = await this._get(providerParameters);

        if (response.status !== 200) {
            observe({
                goLyricsApiError: {
                    'invalidStatusCode': response.status,
                    body: await response.text(),
                }
            });
            if (response.status === 404) {
                 addAwait(this.cacheService.saveNegative('golyrics', videoId));
            }
            return null;
        }

        const ttml = await response.text();

        if (ttml) {
            addAwait(
                this.cacheService.saveGoLyrics({
                    source_track_id: videoId,
                    source_platform: "youtube_music",
                    lyric_format: "ttml",
                    lyric_content: ttml,
                })
            );

            addAwait(this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2")
                .bind('golyrics', videoId).run());

        } else {
             addAwait(this.cacheService.saveNegative('golyrics', videoId));
        }

        return {
            ttml: ttml,
            richSynced: null,
            synced: null,
            unsynced: null,
            debugInfo: null
        };
    }

    async getLrc(videoId: string, providerParameters: GoLyricsApiParameters): Promise<LyricsResponse | null> {

        // 1. Check Negative Cache
        const negativeStatus = await this.cacheService.getNegative('golyrics', videoId);
        if (negativeStatus.hit) {
            if (negativeStatus.stale) {
                // SWR: Return null, but fetch in background
                addAwait(this.fetchAndSave(videoId, providerParameters));
            }
            return null;
        }

        // 2. Check Positive Cache
        let cachedData = await this.cacheService.getGoLyrics("youtube_music", videoId);
        let shouldRefetch = false;

        if (cachedData) {
            const now = Math.floor(Date.now() / 1000);
            const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : DEFAULT_REFETCH_THRESHOLD;
            const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : DEFAULT_REFETCH_CHANCE;

            if (now - cachedData.lastUpdatedAt > threshold) {
                if (Math.random() < chance) {
                    shouldRefetch = true;
                    observe({ 'goLyricsCacheRefetch': true });
                }
            }

            if (shouldRefetch) {
                 // SWR: Use cached data, but fetch in background
                 addAwait(this.fetchAndSave(videoId, providerParameters));
            }

            // Return cached data
            let ttml: string | null = null;
            for (const lyric of cachedData.lyrics) {
                if (lyric.format == "ttml") {
                    ttml = lyric.content;
                }
            }
            return {
                ttml: ttml,
                richSynced: null,
                synced: null,
                unsynced: null,
                debugInfo: {
                    comment: 'goLyricsApi cache'
                }
            };
        }

        // 3. No Cache, Fetch Synchronously
        return this.fetchAndSave(videoId, providerParameters);
    }
}
