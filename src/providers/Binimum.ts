import { addAwait, observe } from '../observability';
import { CacheService, SaveLyricsData, SourcePlatform } from '../services/CacheService';
import { Env } from '../types';

const BINIMUM_API_URL = 'https://lyrics-api.binimum.org/';
const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const SOURCE_PLATFORM: SourcePlatform = 'binimum';

const DEFAULT_REFETCH_THRESHOLD = 2 * 86400;
const DEFAULT_REFETCH_CHANCE = 0.15;

export interface BinimumParameters {
    song: string;
    artist: string;
    album: string | null;
    duration: string;
    videoId: string;
    isrc: string | null;
}

export type BinimumTimingType = 'syllable' | 'line';

export interface BinimumLyrics {
    lyrics: string | null;
    timingType: BinimumTimingType | null;
}

interface BinimumSearchResult {
    timing_type?: BinimumTimingType;
    lyricsUrl?: string;
}

interface BinimumSearchResponse {
    results?: BinimumSearchResult[];
}

function normalizeIsrc(input: string | null | undefined): string | null {
    if (!input) return null;
    const candidate = input.trim().toUpperCase();
    return ISRC_REGEX.test(candidate) ? candidate : null;
}

export class Binimum {
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.cacheService = new CacheService(env);
    }

    private buildSearchUrl(params: BinimumParameters): string {
        const url = new URL(BINIMUM_API_URL);
        const isrc = normalizeIsrc(params.isrc);

        if (isrc) {
            url.searchParams.append('isrc', isrc);
            return url.toString();
        }

        url.searchParams.append('track', params.song);
        url.searchParams.append('artist', params.artist);
        if (params.album) url.searchParams.append('album', params.album);
        if (params.duration) url.searchParams.append('duration', String(Math.round(Number(params.duration))));
        return url.toString();
    }

    private async _fetch(params: BinimumParameters): Promise<BinimumLyrics | null> {
        const searchUrl = this.buildSearchUrl(params);
        const searchResponse = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Better Lyrics Cloudflare API' }
        });

        observe({ binimumSearch: { responseStatus: searchResponse.status, isrcUsed: !!normalizeIsrc(params.isrc) } });

        if (!searchResponse.ok) return null;

        const searchData = await searchResponse.json() as BinimumSearchResponse;
        const selected = searchData.results?.[0];
        if (!selected?.lyricsUrl) return null;

        const ttmlResponse = await fetch(selected.lyricsUrl, {
            headers: { 'User-Agent': 'Better Lyrics Cloudflare API' }
        });

        observe({ binimumFetch: { responseStatus: ttmlResponse.status } });

        if (!ttmlResponse.ok) return null;

        const ttml = await ttmlResponse.text();
        if (!ttml) return null;

        return { lyrics: ttml, timingType: selected.timing_type ?? null };
    }

    private async fetchAndSave(videoId: string, params: BinimumParameters, cachedData?: { lyrics: any[], lastUpdatedAt: number, timingType: BinimumTimingType | null } | null): Promise<BinimumLyrics | null> {
        const result = await this._fetch(params);

        if (!result || !result.lyrics) {
            addAwait(this.cacheService.saveNegative(SOURCE_PLATFORM, videoId));
            return null;
        }

        let identical = false;
        if (cachedData) {
            let cachedTtml: string | null = null;
            for (const lyric of cachedData.lyrics) {
                if (lyric.format === 'ttml') cachedTtml = lyric.content;
            }
            if (cachedTtml === result.lyrics && cachedData.timingType === result.timingType) {
                identical = true;
            }
        }

        if (identical) {
            addAwait(this.cacheService.touchBinimumLyrics('youtube_music', videoId));
        } else {
            const saveData: SaveLyricsData = {
                source_track_id: videoId,
                source_platform: 'youtube_music',
                lyric_format: 'ttml',
                lyric_content: result.lyrics,
            };
            addAwait(this.cacheService.saveBinimumLyrics(saveData, result.timingType));

            addAwait(this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2")
                .bind(SOURCE_PLATFORM, videoId).run());
        }

        return result;
    }

    async getLrc(videoId: string, params: BinimumParameters, force: boolean = false): Promise<BinimumLyrics & { action?: string, timestamp?: number, error?: string } | null> {
        const cachedData = await this.cacheService.getBinimumLyrics('youtube_music', videoId);

        if (!force) {
            const negativeStatus = await this.cacheService.getNegative(SOURCE_PLATFORM, videoId);
            if (negativeStatus.hit) {
                if (negativeStatus.stale) {
                    addAwait(this.fetchAndSave(videoId, params, cachedData));
                }
                return null;
            }

            if (cachedData) {
                const now = Math.floor(Date.now() / 1000);
                const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : DEFAULT_REFETCH_THRESHOLD;
                const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : DEFAULT_REFETCH_CHANCE;

                if (now - cachedData.lastUpdatedAt > threshold && Math.random() < chance) {
                    observe({ binimumCacheRefetch: true });
                    addAwait(this.fetchAndSave(videoId, params, cachedData));
                }

                let ttml: string | null = null;
                for (const lyric of cachedData.lyrics) {
                    if (lyric.format === 'ttml') ttml = lyric.content;
                }
                return {
                    lyrics: ttml,
                    timingType: cachedData.timingType,
                    action: 'same',
                    timestamp: cachedData.lastUpdatedAt,
                };
            }
        }

        try {
            const result = await this.fetchAndSave(videoId, params, cachedData);
            if (result) {
                let action = 'updated';
                let cachedTtml: string | null = null;
                if (cachedData) {
                    for (const lyric of cachedData.lyrics) {
                        if (lyric.format === 'ttml') cachedTtml = lyric.content;
                    }
                }
                if (cachedTtml === result.lyrics) action = 'same';
                return { ...result, action, timestamp: Math.floor(Date.now() / 1000) };
            }
            return null;
        } catch (e: any) {
            return { lyrics: null, timingType: null, action: 'failed', error: e.message, timestamp: Math.floor(Date.now() / 1000) };
        }
    }
}
