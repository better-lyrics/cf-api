import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoiduLyricsApi, BoiduLyricsApiParameters } from '../src/providers/BoiduLyricsApi';
import { flushObservability, runWithObservability } from '../src/observability';

const params: BoiduLyricsApiParameters = {
    song: 'MEEEEEE (NAYEON)',
    artist: 'TWICE',
    album: 'TEN: The Story Goes On',
    duration: '166',
    videoId: 'vnA8--MCU_A',
};

function createProvider() {
    const run = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const env = {
        DB: { prepare },
        GO_API_KEY: 'test-key',
    };
    const provider = new BoiduLyricsApi(env as any);
    return { provider: provider as any, prepare, bind, run };
}

describe('BoiduLyricsApi', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves positive cached lyrics even when a negative mapping exists', async () => {
        const { provider } = createProvider();
        provider.cacheService = {
            getGoLyrics: vi.fn().mockResolvedValue({
                lyrics: [{ format: 'ttml', content: '<tt>cached</tt>' }],
                lastUpdatedAt: Math.floor(Date.now() / 1000),
            }),
            getNegative: vi.fn().mockResolvedValue({ hit: true, stale: false }),
        };

        const result = await provider.getLrc(params.videoId, params);

        expect(result?.lyrics).toBe('<tt>cached</tt>');
    });

    it('clears a negative mapping after an identical successful refresh', async () => {
        const { provider, prepare, bind, run } = createProvider();
        provider.cacheService = {
            getGoLyrics: vi.fn().mockResolvedValue({
                lyrics: [{ format: 'ttml', content: '<tt>fresh</tt>' }],
                lastUpdatedAt: Math.floor(Date.now() / 1000),
            }),
            touchGoLyrics: vi.fn().mockResolvedValue(undefined),
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            Response.json({ ttml: '<tt>fresh</tt>' })
        ));

        const result = await runWithObservability(async () => {
            const lyrics = await provider.getLrc(params.videoId, params, true);
            await flushObservability();
            return lyrics;
        });

        expect(result?.lyrics).toBe('<tt>fresh</tt>');
        expect(prepare).toHaveBeenCalledWith(
            'DELETE FROM negative_mappings WHERE source_platform = ?1 AND source_track_id = ?2'
        );
        expect(bind).toHaveBeenCalledWith('golyrics', params.videoId);
        expect(run).toHaveBeenCalled();
    });

    it('retries a stale negative mapping synchronously when no positive cache exists', async () => {
        const { provider } = createProvider();
        provider.cacheService = {
            getGoLyrics: vi.fn().mockResolvedValue(null),
            getNegative: vi.fn().mockResolvedValue({ hit: true, stale: true }),
            saveGoLyrics: vi.fn().mockResolvedValue(true),
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            Response.json({ ttml: '<tt>now available</tt>' })
        ));

        const result = await runWithObservability(async () => {
            const lyrics = await provider.getLrc(params.videoId, params);
            await flushObservability();
            return lyrics;
        });

        expect(result?.lyrics).toBe('<tt>now available</tt>');
    });

    it('does not negative-cache an upstream miss when positive lyrics exist', async () => {
        const { provider } = createProvider();
        const saveNegative = vi.fn().mockResolvedValue(undefined);
        provider.cacheService = {
            getGoLyrics: vi.fn().mockResolvedValue({
                lyrics: [{ format: 'ttml', content: '<tt>cached</tt>' }],
                lastUpdatedAt: Math.floor(Date.now() / 1000),
            }),
            saveNegative,
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response('not found', { status: 404 })
        ));

        const result = await runWithObservability(async () => {
            const lyrics = await provider.getLrc(params.videoId, params, true);
            await flushObservability();
            return lyrics;
        });

        expect(result?.lyrics).toBe('<tt>cached</tt>');
        expect(saveNegative).not.toHaveBeenCalled();
    });

    it('serves positive cached lyrics when a forced refresh throws', async () => {
        const { provider } = createProvider();
        provider.cacheService = {
            getGoLyrics: vi.fn().mockResolvedValue({
                lyrics: [{ format: 'ttml', content: '<tt>cached</tt>' }],
                lastUpdatedAt: 123,
            }),
        };
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream unavailable')));

        const result = await provider.getLrc(params.videoId, params, true);

        expect(result).toMatchObject({
            lyrics: '<tt>cached</tt>',
            action: 'failed',
            error: 'upstream unavailable',
            timestamp: 123,
        });
    });
});
