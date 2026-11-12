#!/usr/bin/env node
// Deletes the cached Musixmatch data that a migration can't, from the production D1 database
// and R2 bucket configured in wrangler.toml:
//   - R2 objects `<musixmatchTrackId>/{rich_sync,normal_sync}.gz` (keys come from the D1 `lyrics` table)
//   - D1 rows in `negative_mappings` with source_platform = 'youtube_music' (Musixmatch's negative cache,
//     in a table shared with other providers)
// The Musixmatch-only tables (`lyrics`, `track_mappings`, `tracks`) are dropped afterwards by
// migrations/0016_drop_musixmatch_tables.sql: `npx wrangler d1 migrations apply lyrics --remote`.
// Data cached for other providers is left alone.
//
// Usage:
//   npm run purge:musixmatch                      # dry run: print what would be deleted
//   npm run purge:musixmatch -- --confirm         # delete it
//   npm run purge:musixmatch -- --scan-bucket     # also list the whole bucket for orphaned Musixmatch objects
//   npm run purge:musixmatch -- --local           # run against local `wrangler dev` state instead of production
//
// Production needs a Cloudflare API token with "D1: Edit" and "Workers R2 Storage: Edit":
//   CLOUDFLARE_API_TOKEN=...  (required)
//   CLOUDFLARE_ACCOUNT_ID=... (optional if the token can see exactly one account)
// R2 is reached through its S3 API, whose credentials are derived from that token.
// Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to use a separate R2 key pair instead.
//
// The deletion is resumable: if it stops partway, run it again. It pauses between write batches
// so live traffic on the same database isn't starved.

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { experimental_readRawConfig, getPlatformProxy } from 'wrangler';

const FLAGS = new Set(['--confirm', '--scan-bucket', '--local']);
const args = process.argv.slice(2);
const unknown = args.filter(arg => !FLAGS.has(arg));
if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}\nAllowed: ${[...FLAGS].join(' ')}`);
    process.exit(2);
}
const confirm = args.includes('--confirm');
const scanBucket = args.includes('--scan-bucket');
const local = args.includes('--local');

// R2 deletes at most 1000 keys per request; each D1 page feeds several of those in parallel.
const R2_BATCH = 1000;
const LYRICS_PAGE = 5000;
const D1_DELETE_BATCH = 5000;
const PAUSE_MS = local ? 0 : 500;
// Musixmatch keys are `<numeric track id>/<format>.gz`. Every other provider uses
// `<videoId>/<provider>_ttml.gz` or `<videoId>/lrclib.gz`, so this cannot match them.
const MUSIXMATCH_KEY = /^\d+\/(rich_sync|normal_sync)\.gz$/;

function chunk(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

async function withRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= 10 || error.retryable === false) throw error;
            const delay = Math.min(60_000, 1000 * 2 ** attempt);
            console.warn(`  ${label} failed (${error.message}); retrying in ${delay / 1000}s`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

function httpError(message, status) {
    const error = new Error(message);
    error.retryable = status === 429 || status >= 500;
    return error;
}

// Both backends expose the same three operations:
//   query(sql, params) -> { results, changes }
//   deleteObjects(keys)
//   listObjects(cursor) -> { keys, cursor }

async function remoteBackend(config) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN (see the header of scripts/purge-musixmatch.mjs).');

    const api = async (path, init = {}) => {
        const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) {
            const detail = body?.errors?.map(e => e.message).join('; ') || response.statusText;
            throw httpError(`Cloudflare API ${init.method ?? 'GET'} ${path}: ${response.status} ${detail}`, response.status);
        }
        return body.result;
    };

    let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
        const accounts = await api('/accounts');
        if (accounts.length !== 1) throw new Error(`The token can see ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID.`);
        accountId = accounts[0].id;
    }

    let accessKeyId = process.env.R2_ACCESS_KEY_ID;
    let secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        // https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token
        const verified = await api('/user/tokens/verify').catch(() => api(`/accounts/${accountId}/tokens/verify`));
        accessKeyId = verified.id;
        secretAccessKey = createHash('sha256').update(token).digest('hex');
    }

    const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
    const bucketUrl = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}`;
    const s3Fetch = async (url, init) => {
        const response = await s3.fetch(url, init);
        const text = await response.text();
        if (!response.ok) throw httpError(`R2 ${init?.method ?? 'GET'}: ${response.status} ${text.slice(0, 300)}`, response.status);
        return text;
    };
    const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

    return {
        target: `production D1 "${config.databaseName}" and R2 "${config.bucketName}" (account ${accountId})`,
        async query(sql, params = []) {
            const [result] = await api(`/accounts/${accountId}/d1/database/${config.databaseId}/query`, {
                method: 'POST',
                body: JSON.stringify({ sql, params }),
            });
            return { results: result.results, changes: result.meta?.changes ?? 0 };
        },
        async deleteObjects(keys) {
            const body = `<Delete><Quiet>true</Quiet>${keys.map(k => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')}</Delete>`;
            const text = await s3Fetch(`${bucketUrl}?delete`, {
                method: 'POST',
                body,
                headers: { 'Content-Type': 'application/xml', 'Content-MD5': createHash('md5').update(body).digest('base64') },
            });
            if (text.includes('<Error>')) throw new Error(`R2 refused some deletes: ${text.slice(0, 500)}`);
        },
        async listObjects(cursor) {
            const params = new URLSearchParams({ 'list-type': '2', 'max-keys': String(R2_BATCH) });
            if (cursor) params.set('continuation-token', cursor);
            const text = await s3Fetch(`${bucketUrl}?${params}`);
            const keys = [...text.matchAll(/<Key>(.*?)<\/Key>/gs)].map(m => xmlUnescape(m[1]));
            const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
            const next = text.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/s)?.[1];
            return { keys, cursor: truncated && next ? xmlUnescape(next) : undefined };
        },
        dispose: async () => {},
    };
}

async function localBackend(config) {
    // Same bindings as `wrangler dev` (default persistence under .wrangler/state/v3).
    const dir = await mkdtemp(join(tmpdir(), 'purge-musixmatch-'));
    const configPath = join(dir, 'wrangler.json');
    await writeFile(configPath, JSON.stringify({
        name: 'purge-musixmatch',
        compatibility_date: config.compatibilityDate,
        d1_databases: [{ binding: 'DB', database_name: config.databaseName, database_id: config.databaseId }],
        r2_buckets: [{ binding: 'LYRICS_BUCKET', bucket_name: config.bucketName }],
    }));
    const proxy = await getPlatformProxy({ configPath, persist: { path: resolve('.wrangler/state/v3') } });
    const { DB, LYRICS_BUCKET } = proxy.env;
    return {
        target: 'local wrangler dev state',
        async query(sql, params = []) {
            const result = await DB.prepare(sql).bind(...params).all();
            return { results: result.results, changes: result.meta.changes ?? 0 };
        },
        deleteObjects: keys => LYRICS_BUCKET.delete(keys),
        async listObjects(cursor) {
            const page = await LYRICS_BUCKET.list({ cursor, limit: R2_BATCH });
            return { keys: page.objects.map(o => o.key), cursor: page.truncated ? page.cursor : undefined };
        },
        dispose: async () => {
            await proxy.dispose();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

const pause = () => new Promise(r => setTimeout(r, PAUSE_MS));

async function deleteInBatches(backend, table, where = '1 = 1') {
    let total = 0;
    for (;;) {
        const { changes } = await withRetry(`delete from ${table}`, () => backend.query(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${D1_DELETE_BATCH})`
        ));
        total += changes;
        if (changes === 0) return total;
        console.log(`  deleted ${total} ${table} rows`);
        await pause();
    }
}

async function main() {
    const { rawConfig } = experimental_readRawConfig({ config: resolve('wrangler.toml') });
    const db = rawConfig.d1_databases?.find(d => d.binding === 'DB');
    const bucket = rawConfig.r2_buckets?.find(b => b.binding === 'LYRICS_BUCKET');
    if (!db || !bucket) throw new Error('wrangler.toml is missing the DB or LYRICS_BUCKET binding');
    const config = {
        databaseName: db.database_name,
        databaseId: db.database_id,
        bucketName: bucket.bucket_name,
        compatibilityDate: rawConfig.compatibility_date,
    };

    const backend = local ? await localBackend(config) : await remoteBackend(config);
    try {
        console.log(`Target: ${backend.target}`);
        console.log(confirm ? 'Mode: DELETE' : 'Mode: dry run (pass --confirm to delete)');

        const { results: tables } = await backend.query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lyrics', 'track_mappings', 'tracks')");
        const hasLyrics = tables.some(t => t.name === 'lyrics');
        const counts = {};
        for (const { name } of tables) {
            counts[name] = (await backend.query(`SELECT COUNT(*) AS n FROM ${name}`)).results[0].n;
        }
        counts.negative_mappings = (await backend.query(
            "SELECT COUNT(*) AS n FROM negative_mappings WHERE source_platform = 'youtube_music'")).results[0].n;
        console.log('Musixmatch rows in D1 (each lyrics row is one R2 object):');
        console.table(counts);
        if (!hasLyrics) console.log('The lyrics table is gone, so R2 keys can only be found with --scan-bucket.');

        if (confirm && hasLyrics) {
            // R2 objects first, then their lyrics rows, so the key list is never lost
            // before the objects it points at are gone.
            let deletedObjects = 0;
            for (;;) {
                const { results } = await withRetry('read lyrics keys', () =>
                    backend.query('SELECT id, r2_object_key FROM lyrics ORDER BY id LIMIT ?', [LYRICS_PAGE]));
                if (results.length === 0) break;
                await Promise.all(chunk(results.map(row => row.r2_object_key), R2_BATCH)
                    .map(keys => withRetry('delete R2 objects', () => backend.deleteObjects(keys))));
                await withRetry('delete lyrics rows', () =>
                    backend.query('DELETE FROM lyrics WHERE id <= ?', [results.at(-1).id]));
                deletedObjects += results.length;
                console.log(`  deleted ${deletedObjects}/${counts.lyrics} R2 objects and lyrics rows`);
                await pause();
            }
        }
        if (confirm) {
            await deleteInBatches(backend, 'negative_mappings', "source_platform = 'youtube_music'");
        }

        if (scanBucket) {
            console.log('Scanning the whole bucket for leftover Musixmatch objects...');
            let scanned = 0;
            let matched = 0;
            let cursor;
            do {
                const page = await withRetry('list R2 objects', () => backend.listObjects(cursor));
                scanned += page.keys.length;
                const keys = page.keys.filter(key => MUSIXMATCH_KEY.test(key));
                matched += keys.length;
                if (confirm && keys.length > 0) await withRetry('delete R2 objects', () => backend.deleteObjects(keys));
                cursor = page.cursor;
                if (scanned % 50_000 < R2_BATCH) console.log(`  scanned ${scanned} objects, ${matched} Musixmatch`);
            } while (cursor);
            console.log(`  ${confirm ? 'deleted' : 'found'} ${matched} Musixmatch objects out of ${scanned} scanned`);
        }

        console.log(confirm ? 'Done.' : 'Dry run complete. Nothing was deleted.');
        if (confirm && tables.length > 0) {
            console.log('Next: drop the Musixmatch tables with `npx wrangler d1 migrations apply lyrics --remote`.');
        }
    } finally {
        await backend.dispose();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
