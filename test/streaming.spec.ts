import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

describe('LyricsV2 Streaming', () => {
    it('returns a 403 when authorization is missing', async () => {
        const request = new Request('http://localhost/v2/lyrics?videoId=abc');
        const ctx = createExecutionContext();
        // @ts-ignore
        const response = await worker.fetch(request, { ...env, BYPASS_AUTH: "false" }, ctx);
        expect(response.status).toBe(403);
    });

    it('returns a stream when authorized (bypassed)', async () => {
        const request = new Request('http://localhost/v2/lyrics?videoId=abc');
        const ctx = createExecutionContext();
        // @ts-ignore
        const response = await worker.fetch(request, { ...env, BYPASS_AUTH: "true" }, ctx);
        
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/event-stream');
        
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No reader");

        const decoder = new TextEncoder();
        let results = "";
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            results += new TextDecoder().decode(value);
        }

        // We expect at least one error event because videoId 'abc' won't find anything real in tests
        // or a metadata event if it gets that far.
        expect(results).toContain('event:');
    });
});
