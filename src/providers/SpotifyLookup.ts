import { observe } from '../observability';
import { Env } from '../types';

const TOKEN_URL = 'https://tokenapi.spicylyrics.org';
const SEARCH_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const METADATA_URL = 'https://spclient.wg.spotify.com/metadata/4/track/';
const SEARCH_QUERY_HASH = 'f244254b94c0e824d458ac216e0f8406a73f2f69a9ff52831a2f78fa774ff6ce';
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const DURATION_TOLERANCE_MS = 2000;
const MAX_ISRC_CHECKS = 3;

// Spotify rejects these endpoints without a desktop client user agent.
const CLIENT_HEADERS = {
    'accept': 'application/json',
    'accept-language': 'en',
    'app-platform': 'Win32_x86_64',
    'spotify-app-version': '1.3.6.1912',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Spotify/1.3.6.1912 Chrome/138.0.0.0 Safari/537.36',
};

export interface SpotifyLookupParameters {
    song: string;
    artist: string;
    duration: string;
    isrc: string | null;
}

interface SearchTrack {
    id: string;
    name: string;
    artists?: { items?: { profile?: { name?: string } }[] };
    duration?: { totalMilliseconds?: number };
}

interface SearchResponse {
    data?: { searchV2?: { topResultsV2?: { itemsV2?: { item?: { __typename?: string, data?: SearchTrack } }[] } } };
}

interface MetadataResponse {
    external_id?: { type: string, id: string }[];
}

let cachedToken: { value: string, fetchedAt: number } | null = null;

async function getToken(env: Env, force: boolean): Promise<string> {
    if (!force && cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) return cachedToken.value;

    const response = await fetch(TOKEN_URL, { headers: { 'x-auth': env.SPICY_TOKEN_API_KEY } });
    observe({ spotifyToken: { responseStatus: response.status } });
    if (!response.ok) throw new Error(`Spotify token request failed with ${response.status}`);

    const value = (await response.text()).trim();
    cachedToken = { value, fetchedAt: Date.now() };
    return value;
}

async function spotifyFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (force: boolean) => fetch(url, {
        ...init,
        headers: { ...CLIENT_HEADERS, ...init.headers, authorization: `Bearer ${await getToken(env, force)}` },
    });

    const response = await send(false);
    return response.status === 401 ? send(true) : response;
}

function spotifyIdToHex(spotifyId: string): string {
    let value = 0n;
    for (const char of spotifyId) {
        value = value * 62n + BigInt(BASE62.indexOf(char));
    }
    return value.toString(16).padStart(32, '0');
}

function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/\(.*?\)|\[.*?\]|\s-\s.*$/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function isMatch(track: SearchTrack, params: SpotifyLookupParameters): boolean {
    const durationMs = Number(params.duration) * 1000;
    const trackDurationMs = track.duration?.totalMilliseconds;
    if (!Number.isFinite(durationMs) || trackDurationMs === undefined || Math.abs(trackDurationMs - durationMs) > DURATION_TOLERANCE_MS) return false;
    if (normalize(track.name) !== normalize(params.song)) return false;

    const artist = normalize(params.artist);
    return (track.artists?.items ?? []).some(item => {
        const name = normalize(item.profile?.name ?? '');
        return name.length > 0 && artist.includes(name);
    });
}

async function search(env: Env, params: SpotifyLookupParameters): Promise<SearchTrack[]> {
    const response = await spotifyFetch(env, SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
            variables: {
                query: `${params.song} ${params.artist}`,
                limit: 30,
                numberOfTopResults: 30,
                offset: 0,
                includeAuthors: false,
                includeAlbumPreReleases: false,
                includeEpisodeContentRatingsV2: false,
            },
            operationName: 'searchSuggestions',
            extensions: { persistedQuery: { version: 1, sha256Hash: SEARCH_QUERY_HASH } },
        }),
    });
    observe({ spotifySearch: { responseStatus: response.status } });
    if (!response.ok) throw new Error(`Spotify search failed with ${response.status}`);

    const data = await response.json() as SearchResponse;
    return (data.data?.searchV2?.topResultsV2?.itemsV2 ?? [])
        .filter(entry => entry.item?.__typename === 'TrackResponseWrapper' && entry.item.data)
        .map(entry => entry.item!.data!);
}

async function getIsrc(env: Env, spotifyId: string): Promise<string | null> {
    const response = await spotifyFetch(env, `${METADATA_URL}${spotifyIdToHex(spotifyId)}?market=from_token`);
    observe({ spotifyMetadata: { responseStatus: response.status } });
    if (!response.ok) return null;

    const data = await response.json() as MetadataResponse;
    return data.external_id?.find(entry => entry.type === 'isrc')?.id.toUpperCase() ?? null;
}

export async function findSpotifyTrackId(env: Env, params: SpotifyLookupParameters): Promise<string | null> {
    const candidates = (await search(env, params)).filter(track => isMatch(track, params));
    observe({ spotifyLookup: { candidates: candidates.length, isrcProvided: !!params.isrc } });
    if (candidates.length === 0) return null;

    if (params.isrc) {
        const isrc = params.isrc.trim().toUpperCase();
        for (const candidate of candidates.slice(0, MAX_ISRC_CHECKS)) {
            if (await getIsrc(env, candidate.id) === isrc) return candidate.id;
        }
    }

    return candidates[0].id;
}
