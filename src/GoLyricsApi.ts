
import { awaitLists, observe } from './index';
import { LyricsResponse } from './LyricUtils';
import { getLyricsFromCache, saveLyricsToCache } from './GoLyricsApiCache';

const Constants = {
    LYRICS_API_URL: "https://lyrics-api-go-better-lyrics-api-pr-12.up.railway.app/getLyrics"
}

export interface GoLyricsApiParameters {
    song: string;
    artist: string;
    album: string | null;
    duration: string;
}

export class GoLyricsApi {
    private readonly ROOT_URL = Constants.LYRICS_API_URL;
    private cache = caches.default;

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

        const response = await fetch(url);

        if (response.body === null) {
            return Promise.reject("Body is missing");
        }

        let teeBody = response.body.tee();
        let newResponse = new Response(teeBody[1], response); // make mutable
        let keys = [...newResponse.headers.keys()];
        keys.forEach((key) => newResponse.headers.delete(key));

        if (newResponse.status === 200) {
            newResponse.headers.set('Cache-control', 'public; max-age=604800');
            awaitLists.add(this.cache.put(cacheUrl, newResponse));
        }

        return new Response(teeBody[0], newResponse);
    }

    async getLrc(videoId: string, providerParameters: GoLyricsApiParameters): Promise<LyricsResponse | null> {
        let cachedLyrics = await getLyricsFromCache("youtube_music", videoId);
        if (cachedLyrics !== null) {
            let ttml: string | null = null;

            for (const lyric of cachedLyrics) {
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

        const response = await this._get(providerParameters);

        if (response.status !== 200) {
            observe({
                goLyricsApiError: {
                    'invalidStatusCode': response.status,
                    body: await response.text(),
                }
            });
            return null;
        }

        const ttml = await response.text();

        if (ttml) {
            awaitLists.add(
                saveLyricsToCache({
                    source_track_id: videoId,
                    source_platform: "youtube_music",
                    lyric_format: "ttml",
                    lyric_content: ttml,
                })
            );
        }

        return {
            ttml: ttml,
            richSynced: null,
            synced: null,
            unsynced: null,
            debugInfo: null
        };
    }
}
