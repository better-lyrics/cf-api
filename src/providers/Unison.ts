import { Env } from "../types";
import { observe } from "../observability";

const DEFAULT_UNISON_API_URL = "https://unison.betterlyrics.org";
const UNISON_TIMEOUT_MS = 4000;
// Invalidation from Unison keeps entries fresh; the TTL only bounds how long a missed invalidation can linger.
const SHARED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The `data` object Unison returns from `GET /lyrics?v=`. Only the fields we inspect are typed. */
export interface UnisonLyrics {
    id: number;
    lyrics?: string;
    userVote?: 1 | -1 | null;
    variant?: "primary" | "own" | "explore";
    [key: string]: unknown;
}

type UnisonLookup =
    | { found: true; data: UnisonLyrics }
    | { found: false };

export type UnisonEventResults =
    | { stage: "shared"; found: true; data: UnisonLyrics }
    | { stage: "shared"; found: false }
    | { stage: "personal"; found: true; unchanged?: true; data: UnisonLyrics }
    | { stage: "personal"; found: false }
    | { stage: "personal"; error: true };

export function normalizeUnisonKeyId(value: unknown): string | null {
    return typeof value === "string" && KEY_ID_PATTERN.test(value) ? value : null;
}

export function isValidVideoId(value: unknown): value is string {
    return typeof value === "string" && VIDEO_ID_PATTERN.test(value);
}

function sharedPayload(data: UnisonLyrics): UnisonLyrics {
    const { userVote: _userVote, variant: _variant, ...rest } = data;
    return rest as UnisonLyrics;
}

function sameLookup(cached: UnisonLookup | null, fresh: UnisonLookup): boolean {
    if (!cached || cached.found !== fresh.found) return false;
    if (!cached.found || !fresh.found) return true;
    return JSON.stringify(cached.data) === JSON.stringify(sharedPayload(fresh.data));
}

export class Unison {
    private env: Env;

    constructor(env: Env) {
        this.env = env;
    }

    private get baseUrl(): string {
        return (this.env.UNISON_API_URL || DEFAULT_UNISON_API_URL).replace(/\/$/, "");
    }

    async getShared(videoId: string): Promise<UnisonLookup | null> {
        try {
            const row = await this.env.DB.prepare(`
                SELECT found, payload FROM unison_cache
                WHERE video_id = ?1 AND found IS NOT NULL AND fetched_at > ?2
            `).bind(videoId, Date.now() - SHARED_CACHE_TTL_MS).first<{ found: number; payload: string | null }>();

            if (!row) return null;
            if (!row.found) return { found: false };
            return row.payload ? { found: true, data: JSON.parse(row.payload) } : null;
        } catch (e: any) {
            observe({ unisonSharedReadError: e?.message ?? String(e) });
            return null;
        }
    }

    /** Writes a shared lookup unless an invalidation or a newer fetch landed after this fetch started. */
    async saveShared(videoId: string, lookup: UnisonLookup, fetchStartedAt: number): Promise<void> {
        const payload = lookup.found ? JSON.stringify(sharedPayload(lookup.data)) : null;
        await this.env.DB.prepare(`
            INSERT INTO unison_cache (video_id, found, payload, fetched_at, invalidated_at)
            VALUES (?1, ?2, ?3, ?4, 0)
            ON CONFLICT(video_id) DO UPDATE SET
                found = excluded.found,
                payload = excluded.payload,
                fetched_at = excluded.fetched_at
            WHERE unison_cache.invalidated_at <= excluded.fetched_at
              AND unison_cache.fetched_at <= excluded.fetched_at
        `).bind(videoId, lookup.found ? 1 : 0, payload, fetchStartedAt).run();
    }

    async invalidate(videoIds: string[]): Promise<void> {
        if (videoIds.length === 0) return;
        const now = Date.now();
        const statement = this.env.DB.prepare(`
            INSERT INTO unison_cache (video_id, found, payload, fetched_at, invalidated_at)
            VALUES (?1, NULL, NULL, 0, ?2)
            ON CONFLICT(video_id) DO UPDATE SET found = NULL, payload = NULL, invalidated_at = ?2
        `);
        await this.env.DB.batch(videoIds.map(videoId => statement.bind(videoId, now)));
    }

    async purgeExpired(): Promise<number> {
        const cutoff = Date.now() - SHARED_CACHE_TTL_MS;
        const result = await this.env.DB.prepare(
            "DELETE FROM unison_cache WHERE fetched_at < ?1 AND invalidated_at < ?1"
        ).bind(cutoff).run();
        return result.meta.changes ?? 0;
    }

    private async fetchPersonal(videoId: string, keyId: string | null): Promise<UnisonLookup> {
        const url = new URL(`${this.baseUrl}/lyrics`);
        url.searchParams.set("v", videoId);
        const headers: Record<string, string> = {};
        if (keyId) headers["x-key-id"] = keyId;
        if (this.env.UNISON_API_KEY) headers["x-blyrics-api-key"] = this.env.UNISON_API_KEY;

        const response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(UNISON_TIMEOUT_MS) });
        observe({ unisonFetch: { responseStatus: response.status } });

        if (response.status === 404) return { found: false };
        if (!response.ok) throw new Error(`Unison request failed with ${response.status}`);

        const body = await response.json() as { data?: UnisonLyrics };
        if (!body.data || typeof body.data.id !== "number") throw new Error("Unison returned no data");
        return { found: true, data: body.data };
    }

    /**
     * Emits up to two events: `shared` from our cache (only on a hit), then `personal` from a live
     * Unison lookup with the caller's key. `personal` omits `lyrics` when they match what `shared` sent.
     */
    async stream(
        videoId: string,
        keyId: string | null,
        emit: (results: UnisonEventResults) => Promise<void>,
        waitUntil: (promise: Promise<unknown>) => void,
    ): Promise<void> {
        const fetchStartedAt = Date.now();
        const personalPromise = this.fetchPersonal(videoId, keyId).then(
            lookup => ({ lookup }),
            error => ({ error: error as Error }),
        );

        const shared = await this.getShared(videoId);
        observe({ unisonSharedHit: shared !== null });
        if (shared) {
            await emit(shared.found ? { stage: "shared", found: true, data: shared.data } : { stage: "shared", found: false });
        }

        const personal = await personalPromise;
        if ("error" in personal) {
            observe({ unisonError: personal.error.message });
            await emit({ stage: "personal", error: true });
            return;
        }

        const { lookup } = personal;
        if (!lookup.found) {
            await emit({ stage: "personal", found: false });
        } else if (shared?.found && shared.data.id === lookup.data.id && shared.data.lyrics === lookup.data.lyrics) {
            const { lyrics: _lyrics, ...rest } = lookup.data;
            await emit({ stage: "personal", found: true, unchanged: true, data: rest as UnisonLyrics });
        } else {
            await emit({ stage: "personal", found: true, data: lookup.data });
        }

        // A 404 is the same for every caller. A hit is only shareable when Unison says it served the
        // primary lyric rather than the caller's own submission or an exploration arm.
        const shareable = !lookup.found || lookup.data.variant === "primary";
        if (shareable && !sameLookup(shared, lookup)) {
            waitUntil(this.saveShared(videoId, lookup, fetchStartedAt).catch((e: any) => {
                observe({ unisonSharedWriteError: e?.message ?? String(e) });
            }));
        }
    }
}
