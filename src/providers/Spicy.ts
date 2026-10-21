import { addAwait, observe } from '../observability';
import { CacheService, CachedSpicyLyrics, SourcePlatform } from '../services/CacheService';
import { Env } from '../types';
import { findSpotifyTrackId, SpotifyLookupParameters } from './SpotifyLookup';
import { spicyToTtml, SpicyLyricsBody } from './spicyTtml';

const SPICY_API_URL = 'https://api.spicylyrics.org/v1/lyrics/';
const SOURCE_PLATFORM: SourcePlatform = 'spicy';

const DEFAULT_REFETCH_THRESHOLD = 2 * 86400;
const DEFAULT_REFETCH_CHANCE = 0.15;
// Spicy Lyrics terms require stored lyrics to be refetched or discarded within 30 days.
const MAX_CACHE_AGE = 30 * 86400;
const DEFAULT_RETRY_AFTER = 60;
const MAX_RETRY_AFTER = 3600;

export type SpicyTimingType = 'syllable' | 'line';

interface SpicyContributor {
    username: string;
    url: string;
}

export interface SpicyAttribution {
    uploader: SpicyContributor;
    maker?: SpicyContributor;
}

export interface SpicyLyrics {
    lyrics: string | null;
    timingType: SpicyTimingType | null;
    attribution: SpicyAttribution | null;
}

type SpicyResult = SpicyLyrics & { action?: string, timestamp?: number, error?: string };

interface SpicyResponse {
    Body?: SpicyLyricsBody & {
        source?: string;
        UploadAttribution?: { Uploader?: SpicyContributor, Maker?: SpicyContributor };
    };
}

let rateLimitedUntil = 0;

function now(): number {
    return Math.floor(Date.now() / 1000);
}

function contributor(input: SpicyContributor | undefined): SpicyContributor | undefined {
    if (typeof input?.username !== 'string' || typeof input.url !== 'string') return undefined;
    return { username: input.username, url: input.url };
}

export class Spicy {
    private cacheService: CacheService;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.cacheService = new CacheService(env);
    }

    private async _fetch(spotifyId: string): Promise<SpicyLyrics & { lyrics: string } | null> {
        const response = await fetch(`${SPICY_API_URL}${spotifyId}`, {
            headers: { 'Authorization': `Bearer ${this.env.SPICY_API_KEY}` },
        });
        observe({ spicyFetch: { responseStatus: response.status, rateLimitRemaining: response.headers.get('RateLimit-Remaining') } });

        if (response.status === 404) return null;
        if (response.status === 429 || response.status === 503) {
            const retryAfter = Number(response.headers.get('Retry-After'));
            rateLimitedUntil = Date.now() + (retryAfter >= 1 && retryAfter <= MAX_RETRY_AFTER ? retryAfter : DEFAULT_RETRY_AFTER) * 1000;
        }
        if (!response.ok) throw new Error(`Spicy Lyrics request failed with ${response.status}`);

        const body = (await response.json() as SpicyResponse).Body;
        if (!body || body.source !== 'spicy_lyrics') return null;

        const lyrics = spicyToTtml(body);
        const uploader = contributor(body.UploadAttribution?.Uploader);
        if (!lyrics || !uploader) return null;

        return {
            lyrics,
            timingType: body.Type === 'Syllable' ? 'syllable' : 'line',
            attribution: { uploader, maker: contributor(body.UploadAttribution?.Maker) },
        };
    }

    private async fetchAndSave(videoId: string, params: SpotifyLookupParameters, cachedData: CachedSpicyLyrics | null, force: boolean = false): Promise<CachedSpicyLyrics | null> {
        if (Date.now() < rateLimitedUntil) throw new Error('Spicy Lyrics rate limited');

        const spotifyId = (!force && cachedData?.spotifyId) || await findSpotifyTrackId(this.env, params);
        if (!spotifyId) return null;

        const result = await this._fetch(spotifyId);
        if (!result) return null;

        const data = { ...result, spotifyId };
        const identical = cachedData?.lyrics === data.lyrics
            && cachedData.timingType === data.timingType
            && JSON.stringify(cachedData.attribution) === JSON.stringify(data.attribution);

        if (identical) {
            addAwait(this.cacheService.touchSpicyLyrics('youtube_music', videoId));
        } else {
            addAwait(this.cacheService.saveSpicyLyrics('youtube_music', videoId, data));
        }
        addAwait(this.env.DB.prepare("DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2")
            .bind(SOURCE_PLATFORM, videoId).run());

        return { ...data, lastUpdatedAt: now() };
    }

    async purgeExpired(): Promise<number> {
        return this.cacheService.deleteSpicyLyricsUpdatedBefore(now() - MAX_CACHE_AGE);
    }

    async getLrc(videoId: string, params: SpotifyLookupParameters, force: boolean = false): Promise<SpicyResult | null> {
        const cached = await this.cacheService.getSpicyLyrics('youtube_music', videoId);
        const expired = !!cached && now() - cached.lastUpdatedAt > MAX_CACHE_AGE;
        const servable = expired ? null : cached;
        const fromCache = (data: CachedSpicyLyrics, action: string, error?: string): SpicyResult => ({
            lyrics: data.lyrics,
            timingType: data.timingType,
            attribution: data.attribution,
            action,
            timestamp: data.lastUpdatedAt,
            error,
        });

        if (!force && servable) {
            const threshold = this.env.REFETCH_THRESHOLD ? parseInt(this.env.REFETCH_THRESHOLD) : DEFAULT_REFETCH_THRESHOLD;
            const chance = this.env.REFETCH_CHANCE ? parseFloat(this.env.REFETCH_CHANCE) : DEFAULT_REFETCH_CHANCE;
            if (now() - servable.lastUpdatedAt > threshold && Math.random() < chance) {
                observe({ spicyCacheRefetch: true });
                addAwait(this.fetchAndSave(videoId, params, servable).catch(e => observe({ spicyRefetchError: e.message })));
            }
            return fromCache(servable, 'same');
        }

        if (!force && !cached) {
            const negativeStatus = await this.cacheService.getNegative(SOURCE_PLATFORM, videoId);
            if (negativeStatus.hit && !negativeStatus.stale) return null;
        }

        try {
            const result = await this.fetchAndSave(videoId, params, cached, force);
            if (result) return fromCache(result, cached?.lyrics === result.lyrics ? 'same' : 'updated');
            if (servable) return fromCache(servable, 'same');

            if (expired) addAwait(this.cacheService.deleteSpicyLyrics(videoId));
            addAwait(this.cacheService.saveNegative(SOURCE_PLATFORM, videoId));
            return null;
        } catch (e: any) {
            observe({ spicyError: e.message });
            if (servable) return fromCache(servable, 'failed', e.message);

            if (expired) addAwait(this.cacheService.deleteSpicyLyrics(videoId));
            return { lyrics: null, timingType: null, attribution: null, action: 'failed', error: e.message, timestamp: now() };
        }
    }
}
