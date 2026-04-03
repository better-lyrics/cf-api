import { addAwait, observe } from '../observability';
import { CacheService, SaveLyricsData, SourcePlatform } from '../services/CacheService';
import { Env } from '../types';

const Constants = {
    LYRICS_API_URL: 'https://lyrics-api.boidu.dev/getLyrics'
}

export interface BoiduLyricsApiParameters {
    song: string;
    artist: string;
    album: string | null;
    duration: string;
    videoId: string;
}

const DEFAULT_REFETCH_THRESHOLD = 2 * 86400;
const DEFAULT_REFETCH_CHANCE = 0.15;
export interface BoiduLyrics {
    lyrics: string | null;
}


export class BoiduLyricsApi {
    private readonly ROOT_URL: string;
    private readonly sourceName: SourcePlatform;
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env, sourceName: SourcePlatform = 'golyrics', endpointUrl: string = Constants.LYRICS_API_URL) {
        this.env = env;
        this.cacheService = new CacheService(env);
        this.sourceName = sourceName;
        this.ROOT_URL = endpointUrl;
    }

    private async _get(providerParameters: BoiduLyricsApiParameters): Promise<Response> {
        const url = new URL(this.ROOT_URL);
        url.searchParams.append("s", providerParameters.song);
        url.searchParams.append("a", providerParameters.artist);
        url.searchParams.append("d", String(providerParameters.duration));
        url.searchParams.append("videoId", providerParameters.videoId);
        if (providerParameters.album != null) {
            url.searchParams.append("al", providerParameters.album);
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

        const teeBody = response.body.tee();
        const newResponse = new Response(teeBody[1], response); // make mutable
        const keys = [...newResponse.headers.keys()];
        keys.forEach((key) => newResponse.headers.delete(key));

        observe({ [`${this.sourceName}Api`]: { responseStatus: response.status } });

        return new Response(teeBody[0], newResponse);
    }

    private async getCache(sourcePlatform: SourcePlatform, videoId: string) {
        if (this.sourceName === 'qq') return this.cacheService.getQqLyrics(sourcePlatform, videoId);
        if (this.sourceName === 'kugou') return this.cacheService.getKugouLyrics(sourcePlatform, videoId);
        return this.cacheService.getGoLyrics(sourcePlatform, videoId);
    }

    private async saveCache(data: SaveLyricsData) {
        if (this.sourceName === 'qq') return this.cacheService.saveQqLyrics(data);
        if (this.sourceName === 'kugou') return this.cacheService.saveKugouLyrics(data);
        return this.cacheService.saveGoLyrics(data);
    }

    private async fetchAndSave(videoId: string, providerParameters: BoiduLyricsApiParameters, cachedData?: { lyrics: any[], lastUpdatedAt: number } | null): Promise<BoiduLyrics | null> {
        const response = await this._get(providerParameters);

        if (response.status !== 200) {
            observe({
                [`${this.sourceName}ApiError`]: {
                    'invalidStatusCode': response.status,
                    body: await response.text(),
                }
            });
            if (response.status === 404) {
                addAwait(this.cacheService.saveNegative(this.sourceName, videoId));
            }
            return null;
        }

        const ttml = await response.text();

        if (ttml) {
            let identical = false;
            if (cachedData) {
                let cachedTtml: string | null = null;
                for (const lyric of cachedData.lyrics) {
                    if (lyric.format == "ttml") cachedTtml = lyric.content;
                }
                if (cachedTtml === ttml) {
                    identical = true;
                }
            }

            if (identical) {
                if (this.sourceName === 'qq') {
                    addAwait(this.cacheService.touchQqLyrics("youtube_music", videoId));
                } else if (this.sourceName === 'kugou') {
                    addAwait(this.cacheService.touchKugouLyrics("youtube_music", videoId));
                } else {
                    addAwait(this.cacheService.touchGoLyrics("youtube_music", videoId));
                }
            } else {
                addAwait(
                    this.saveCache({
                        source_track_id: videoId,
                        source_platform: "youtube_music",
                        lyric_format: "ttml",
                        lyric_content: ttml,
                    })
                );

                addAwait(this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2")
                    .bind(this.sourceName, videoId).run());
            }

        } else {
            addAwait(this.cacheService.saveNegative(this.sourceName, videoId));
        }

        return {
            lyrics: ttml
        };
    }

    async getLrc(videoId: string, providerParameters: BoiduLyricsApiParameters, force: boolean = false): Promise<BoiduLyrics & { action?: string, timestamp?: number, error?: string } | null> {
        // 1. Check Positive Cache (always check for comparison)
        const cachedData = await this.getCache("youtube_music", videoId);

        if (!force) {
            // 1. Check Negative Cache
            const negativeStatus = await this.cacheService.getNegative(this.sourceName, videoId);
            if (negativeStatus.hit) {
                if (negativeStatus.stale) {
                    // SWR: Return null, but fetch in background
                    addAwait(this.fetchAndSave(videoId, providerParameters, cachedData));
                }
                return null;
            }

            let shouldRefetch = false;

            if (cachedData) {
                const now = Math.floor(Date.now() / 1000);
                const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : DEFAULT_REFETCH_THRESHOLD;
                const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : DEFAULT_REFETCH_CHANCE;

                if (now - cachedData.lastUpdatedAt > threshold) {
                    if (Math.random() < chance) {
                        shouldRefetch = true;
                        observe({ [`${this.sourceName}CacheRefetch`]: true });
                    }
                }

                if (shouldRefetch) {
                    // SWR: Use cached data, but fetch in background
                    addAwait(this.fetchAndSave(videoId, providerParameters, cachedData));
                }

                // Return cached data
                let ttml: string | null = null;
                for (const lyric of cachedData.lyrics) {
                    if (lyric.format == "ttml") {
                        ttml = lyric.content;
                    }
                }
                return {
                    lyrics: ttml, action: 'same', timestamp: cachedData.lastUpdatedAt
                };
            }
        }

        // 3. No Cache, Fetch Synchronously
        try {
            const result = await this.fetchAndSave(videoId, providerParameters, cachedData);
            if (result) {
                let action = 'updated';
                let cachedTtml: string | null = null;
                if (cachedData) {
                    for (const lyric of cachedData.lyrics) {
                        if (lyric.format == "ttml") {
                            cachedTtml = lyric.content;
                        }
                    }
                }
                if (cachedTtml === result.lyrics) {
                    action = 'same';
                }
                return { ...result, action: action, timestamp: Math.floor(Date.now() / 1000) };
            }
            return null;
        } catch (e: any) {
            return { lyrics: null, action: 'failed', error: e.message, timestamp: Math.floor(Date.now() / 1000) };
        }
    }
}
