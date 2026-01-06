import { awaitLists, observe } from "../observability";
import { Env } from "../types";

const youtubeSnippetAPI = "https://www.googleapis.com/youtube/v3/videos";

type videoMetaType = {
    kind: string,
    etag: string,
    items: {
        contentDetails: {
            duration: string // ISO 8601
        },
        kind: string,
        etag: string,
        id: string,
        snippet: {
            publishedAt: string,
            channelId: string
            title: string,
            description: string,
            channelType: string
            defaultLanguage: string,
            tags: string[],
            channelTitle: string,
        }
    }[]
}

export interface YoutubeMetadata {
    videoId: string;
    song: string | null;
    artists: string[] | null;
    album: string | null;
    duration: number | null;
    found: boolean;
}

export class MetadataService {
    constructor(private env: Env) {}

    async getMetadata(videoId: string, alwaysFetch: boolean = false): Promise<YoutubeMetadata | null> {
        if (!alwaysFetch) {
            const cached = await this.getFromCache(videoId);
            if (cached) {
                if (!cached.found) {
                     // Negative cache hit
                     // Maybe check TTL for negative cache? e.g. 1 week
                     // For now just return it.
                     return cached;
                }
                return cached;
            }
        }

        const fromApi = await this.fetchFromApi(videoId);
        if (fromApi) {
            await this.saveToCache(fromApi);
            return fromApi;
        } else {
            // Negative cache
            const notFound: YoutubeMetadata = {
                videoId,
                song: null,
                artists: null,
                album: null,
                duration: null,
                found: false
            };
            await this.saveToCache(notFound);
            return notFound;
        }
    }

    private async getFromCache(videoId: string): Promise<YoutubeMetadata | null> {
        const stmt = this.env.DB.prepare(
            'SELECT song, artists, album, duration, last_accessed_at, found FROM youtube_cache WHERE video_id = ?1'
        );
        const result = await stmt.bind(videoId).first<{ 
            song: string | null; 
            artists: string | null; 
            album: string | null; 
            duration: number | null; 
            last_accessed_at: number;
            found: number; // 0 or 1
        }>();

        if (!result) {
            observe({ youtubeCacheLookup: { videoId, hit: false } });
            return null;
        }

        observe({ youtubeCacheLookup: { videoId, hit: true } });

        const now = Math.floor(Date.now() / 1000);
        // Update last_accessed_at if > 1 day
        if (now - result.last_accessed_at > 86400) {
            const updateTimestampPromise = this.env.DB.prepare(
                'UPDATE youtube_cache SET last_accessed_at = ?1 WHERE video_id = ?2'
            ).bind(now, videoId).run();
            awaitLists.add(updateTimestampPromise);
        }

        return {
            videoId,
            song: result.song,
            artists: result.artists ? result.artists.split(',') : null,
            album: result.album,
            duration: result.duration,
            found: result.found === 1
        };
    }

    private async saveToCache(data: YoutubeMetadata): Promise<void> {
        const artists = data.artists ? data.artists.join(',') : null;
        const now = Math.floor(Date.now() / 1000);
        const found = data.found ? 1 : 0;

        const stmt = this.env.DB.prepare(
            `INSERT INTO youtube_cache (video_id, song, artists, album, duration, last_accessed_at, found) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) 
             ON CONFLICT(video_id) DO UPDATE SET 
             song = ?2, artists = ?3, album = ?4, duration = ?5, last_accessed_at = ?6, found = ?7`
        );

        try {
            await stmt.bind(data.videoId, data.song, artists, data.album, data.duration, now, found).run();
            observe({ youtubeCacheSave: { success: true, data } });
        } catch (error) {
            observe({ youtubeCacheSave: { success: false, data, error } });
        }
    }

    private async fetchFromApi(videoId: string): Promise<YoutubeMetadata | null> {
        let snippetUrl = new URL(youtubeSnippetAPI);
        snippetUrl.searchParams.set('id', videoId);
        snippetUrl.searchParams.set('key', this.env.GOOGLE_API_KEY);
        snippetUrl.searchParams.set('part', 'snippet,contentDetails');

        const response = await fetch(snippetUrl.toString());
        if (response.status !== 200) {
            observe({ youtubeApiError: response.status });
            return null;
        }

        const videoMeta: videoMetaType = await response.json();
        
        if (!videoMeta || !videoMeta.items || videoMeta.items.length === 0) {
             return null;
        }
        
        const item = videoMeta.items[0];
        const snippet = item.snippet;
        const contentDetails = item.contentDetails;

        let song: string | null = null;
        let artists: string[] = [];
        let album: string | null = null;
        let duration: number | null = null;
        
        // Logic from GetLyrics.ts
        if (snippet.description && snippet.description.endsWith('Auto-generated by YouTube.')) {
            let desc = snippet.description.split('\n');
            let parsedSongAndArtist: string | null = null;
            if (desc.length > 4) {
                parsedSongAndArtist = desc[2];
                album = desc[4];
            }

            if (parsedSongAndArtist) {
                let splitSongAndArtist = parsedSongAndArtist.split('·');
                song = splitSongAndArtist[0].trim();
                splitSongAndArtist.shift();

                let newArtists = splitSongAndArtist;
                // Original logic check
                // "Check that the original artist is in the metadata list" - 
                // Wait, the original code had `artists` from params. Here we don't have params yet.
                // The logic was: if (artists.length == 0 || newArtists.includes(artists[0]))
                // Since I'm fetching independently, I'll just trust the parsed ones for now.
                // Or I can return what I found and let the caller merge/verify?
                
                // For "Auto-generated", it's usually reliable.
                // Let's copy the channelTitle logic.
                if (newArtists.length > 3) {
                     if (snippet.channelTitle && snippet.channelTitle.endsWith('- Topic')) {
                        newArtists = [snippet.channelTitle.substring(0, snippet.channelTitle.length - 7).trim()];
                     } else {
                        newArtists = [newArtists[0]]; // Take first
                     }
                }
                artists = newArtists;
            }
        }

        if (contentDetails && contentDetails.duration) {
            const match = contentDetails.duration.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
            if (match) {
                const minutes = match[1] ? parseInt(match[1], 10) : 0;
                const seconds = match[2] ? parseInt(match[2], 10) : 0;
                duration = 60 * minutes + seconds;
            }
        }

        return {
            videoId,
            song,
            artists: artists.length > 0 ? artists : null,
            album,
            duration,
            found: true
        };
    }
}
