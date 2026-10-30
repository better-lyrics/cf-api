import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { Unison, UnisonEventResults } from '../src/providers/Unison';

const UNISON_ORIGIN = 'https://unison.test';
const testEnv = { ...env, UNISON_API_URL: UNISON_ORIGIN, UNISON_INVALIDATE_SECRET: 'test-secret', UNISON_API_KEY: 'api-key' } as any;

const primary = { id: 7, videoId: 'vid', lyrics: '[00:01.00] hello', format: 'lrc', voteCount: 3, userVote: 1, variant: 'primary' };

function mockUnison(videoId: string, status: number, body?: unknown) {
    fetchMock.get(UNISON_ORIGIN)
        .intercept({ path: `/lyrics?v=${videoId}`, headers: { 'x-blyrics-api-key': 'api-key', 'x-key-id': 'key' } })
        .reply(status, body === undefined ? '' : JSON.stringify(body));
}

async function runStream(videoId: string, keyId: string | null = 'key') {
    const events: UnisonEventResults[] = [];
    const pending: Promise<unknown>[] = [];
    await new Unison(testEnv).stream(videoId, keyId, async results => { events.push(results); }, p => pending.push(p));
    await Promise.all(pending);
    return events;
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS unison_cache (
        video_id TEXT PRIMARY KEY, found INTEGER, payload TEXT,
        fetched_at INTEGER NOT NULL DEFAULT 0, invalidated_at INTEGER NOT NULL DEFAULT 0
    )`).run();
});

beforeEach(async () => {
    await env.DB.prepare('DELETE FROM unison_cache').run();
    fetchMock.activate();
    fetchMock.disableNetConnect();
});

afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
});

describe('Unison stream', () => {
    it('sends only a personal event on a cache miss, then serves the shared copy next time', async () => {
        mockUnison('vid', 200, { success: true, data: primary });
        expect(await runStream('vid')).toEqual([{ stage: 'personal', found: true, data: primary }]);

        mockUnison('vid', 200, { success: true, data: primary });
        const events = await runStream('vid');
        const { userVote: _u, variant: _v, ...shared } = primary;
        const { lyrics: _l, ...withoutLyrics } = primary;
        expect(events).toEqual([
            { stage: 'shared', found: true, data: shared },
            { stage: 'personal', found: true, unchanged: true, data: withoutLyrics },
        ]);
    });

    it('caches a 404 as a shared miss', async () => {
        mockUnison('missing', 404);
        expect(await runStream('missing')).toEqual([{ stage: 'personal', found: false }]);

        mockUnison('missing', 404);
        expect(await runStream('missing')).toEqual([
            { stage: 'shared', found: false },
            { stage: 'personal', found: false },
        ]);
    });

    it('does not share a lyric that was personalized for the caller', async () => {
        mockUnison('own', 200, { success: true, data: { ...primary, variant: 'own' } });
        await runStream('own');
        expect(await new Unison(testEnv).getShared('own')).toBeNull();
    });

    it('does not share a lyric when Unison omits the variant', async () => {
        const { variant: _v, ...legacy } = primary;
        mockUnison('legacy', 200, { success: true, data: legacy });
        await runStream('legacy');
        expect(await new Unison(testEnv).getShared('legacy')).toBeNull();
    });

    it('sends the full lyrics when the personal result differs from the shared one', async () => {
        mockUnison('vid', 200, { success: true, data: primary });
        await runStream('vid');

        const updated = { ...primary, lyrics: '[00:01.00] hello again' };
        mockUnison('vid', 200, { success: true, data: updated });
        const events = await runStream('vid');
        expect(events[1]).toEqual({ stage: 'personal', found: true, data: updated });
    });

    it('reports an error when Unison fails and keeps the shared copy', async () => {
        mockUnison('vid', 200, { success: true, data: primary });
        await runStream('vid');

        mockUnison('vid', 500, { success: false });
        const events = await runStream('vid');
        expect(events.map(e => e.stage)).toEqual(['shared', 'personal']);
        expect(events[1]).toEqual({ stage: 'personal', error: true });
    });
});

describe('Unison shared cache', () => {
    it('ignores a write-back from a fetch that started before an invalidation', async () => {
        const unison = new Unison(testEnv);
        const startedAt = Date.now() - 1000;
        await unison.invalidate(['vid']);
        await unison.saveShared('vid', { found: true, data: primary }, startedAt);
        expect(await unison.getShared('vid')).toBeNull();

        await unison.saveShared('vid', { found: true, data: primary }, Date.now() + 1);
        expect(await unison.getShared('vid')).not.toBeNull();
    });
});

describe('POST /unison/invalidate', () => {
    async function invalidate(authorization: string | null, body: unknown) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authorization) headers.Authorization = authorization;
        const ctx = createExecutionContext();
        const response = await worker.fetch(
            new Request('http://localhost/unison/invalidate', { method: 'POST', headers, body: JSON.stringify(body) }),
            testEnv,
            ctx,
        );
        await waitOnExecutionContext(ctx);
        return response;
    }

    it('rejects a missing or wrong secret', async () => {
        expect((await invalidate(null, { videoIds: ['vid'] })).status).toBe(403);
        expect((await invalidate('Bearer nope', { videoIds: ['vid'] })).status).toBe(403);
    });

    it('drops cached entries for the given videos', async () => {
        const unison = new Unison(testEnv);
        await unison.saveShared('vid', { found: true, data: primary }, Date.now() - 10);

        const response = await invalidate('Bearer test-secret', { videoIds: ['vid', 'vid', 'not valid!'] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true, invalidated: 1 });
        expect(await unison.getShared('vid')).toBeNull();
    });
});

describe('POST /v2/lyrics with unison=1', () => {
    // The test DB has no provider tables, so the pipeline takes its error path; the stream must still carry Unison.
    it('keeps the stream open until the Unison lookup is sent', async () => {
        mockUnison('streamvid', 404);
        const body = new URLSearchParams({ videoId: 'streamvid', unison: '1', unisonKeyId: 'key', token: 'x' });
        const ctx = createExecutionContext();
        const response = await worker.fetch(
            new Request('http://localhost/v2/lyrics', { method: 'POST', body }),
            { ...testEnv, BYPASS_AUTH: 'true' },
            ctx,
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        await waitOnExecutionContext(ctx);

        const events = text.trim().split('\n\n').map(block => {
            const [eventLine, dataLine] = block.split('\n');
            return { type: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
        });
        expect(events).toContainEqual({ type: 'provider', data: { provider: 'unison', results: { stage: 'personal', found: false } } });
        expect(events.some(e => e.type === 'done' || e.type === 'error')).toBe(true);
    });
});
