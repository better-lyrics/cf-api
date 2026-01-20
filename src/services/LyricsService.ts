import { Env } from '../types';
import { MetadataService } from './MetadataService';
import { Musixmatch } from '../providers/Musixmatch';
import { GoLyricsApi } from '../providers/GoLyricsApi';
import { LrcLib } from '../providers/LrcLib';
import { observe } from '../observability';
import { LyricsResponse } from '../LyricUtils'; // Interface
import { isTruthy, sleep } from '../utils';

export class LyricsService {
    private metadataService: MetadataService;
    private musixmatch: Musixmatch;
    private goLyrics: GoLyricsApi;
    private lrcLib: LrcLib;
    private env: Env;

    constructor(env: Env) {
        this.env = env;
        this.metadataService = new MetadataService(env);
        this.musixmatch = new Musixmatch(env);
        this.goLyrics = new GoLyricsApi(env);
        this.lrcLib = new LrcLib(env);
    }

    async getLyrics(params: URLSearchParams): Promise<LyricsResponse | any> { // Type 'any' for the unified response object structure
        let artist: string | null | undefined = params.get('artist');
        let song: string | null | undefined = params.get('song');
        let album: string | null | undefined = params.get('album');
        let duration: string | null | undefined = params.get('duration');
        let parsedSongAndArtist: string | null = null;
        let videoId = params.get("videoId");
        let alwaysFetchMetadata = params.get('alwaysFetchMetadata')?.toLowerCase() === 'true';
        let description: string | null = null;

        if (!videoId) {
             throw new Error("Invalid Video Id");
        }

        // Token Promise
        let tokenPromise = this.musixmatch.getToken();

        let artists: string[] = [];
        if (artist) {
            artists = artist.split(',')
                .flatMap(a => a.split('&'))
                .map(a => a.trim()).filter(a => a.length > 0);
        }

        if (alwaysFetchMetadata || !song || song.trim().length === 0 || artists.length === 0 || !album || album.length === 0) {
            const metadata = await this.metadataService.getMetadata(videoId, alwaysFetchMetadata);
            if (metadata && metadata.found) {
                if (!song) song = metadata.song;
                if (!artists || artists.length === 0) artists = metadata.artists || [];
                if (artists && artists.length > 0) artist = artists.join(', ');
                if (!album) album = metadata.album;
                if (!duration) duration = metadata.duration?.toString();
            }
        }

        if (!song || !artist) {
             return {
                message: "A Song or Artist wasn't provided and couldn't be inferred",
                song,
                artist,
                album,
                duration,
                videoId,
            };
        }

        let response = {
            song,
            artist,
            album,
            duration,
            parsedSongAndArtist,
            videoId,
            description,
            debugInfo: null as any,
            musixmatchWordByWordLyrics: null as any,
            musixmatchSyncedLyrics: null as any,
            lrclibSyncedLyrics: null as any,
            lrclibPlainLyrics: null as any,
            goLyricsApiTtml: null as any
        };

        let artistAlbumSongCombos: { artist: string, song: string, album: string | null }[] = [
            {
                artist: artists.join(', '), album: album || null, song
            }
        ];
        // Note: The commented out combos in GetLyrics.ts are skipped here too.

        let foundStats = [];
        for (let index in artistAlbumSongCombos) {
            let combo = artistAlbumSongCombos[index];

            // LrcLib
            let lrcLibLyricsPromise = this.lrcLib.getLyrics(videoId, combo.artist, combo.song, combo.album, duration)
                .then(lyrics => {
                    if (lyrics) {
                        response.lrclibSyncedLyrics = lyrics.synced;
                        response.lrclibPlainLyrics = lyrics.unsynced;
                    }
                    return lyrics;
                });
            
            let lrcLibPromiseRace = Promise.race([lrcLibLyricsPromise, sleep(5500)]);

            // Musixmatch
            let mxmError = null;
            let musixmatchLyrics = this.musixmatch.getLrc(videoId, combo.artist, combo.song, combo.album, lrcLibPromiseRace, tokenPromise)
                .then(lyrics => {
                    if (lyrics) {
                        response.musixmatchWordByWordLyrics = lyrics.richSynced;
                        response.musixmatchSyncedLyrics = lyrics.synced;
                        response.debugInfo = lyrics.debugInfo;
                    }
                })
                .catch(e => {
                    mxmError = e;
                });

            // GoLyrics
            let goLyrics;
            if (duration) {
                goLyrics = this.goLyrics.getLrc(videoId, {
                    song: combo.song,
                    artist: combo.artist,
                    album: combo.album,
                    duration: duration
                }).then(lyrics => {
                    if (lyrics) {
                        response.goLyricsApiTtml = lyrics.ttml;
                    }
                });
            }

            await Promise.all([goLyrics, musixmatchLyrics]);

            let lrcLibTimeout;
            if (response.goLyricsApiTtml) {
                lrcLibTimeout = 4;
            } else {
                lrcLibTimeout = 0.5;
            }
            await Promise.race([lrcLibPromiseRace, sleep(lrcLibTimeout)]);

            foundStats.push({
                'hasWordByWord': isTruthy(response.musixmatchWordByWordLyrics),
                'hasLrcLibSynced': isTruthy(response.lrclibSyncedLyrics),
                'hasMusixmatchSynced': isTruthy(response.musixmatchSyncedLyrics),
                'hasLrcLibPlain': isTruthy(response.lrclibPlainLyrics),
                'hasGoLyricsApiTtml': isTruthy(response.goLyricsApiTtml),
                'musixMatchError': mxmError
            });

            if (isTruthy(response.musixmatchWordByWordLyrics) || isTruthy(response.lrclibSyncedLyrics) || isTruthy(response.musixmatchSyncedLyrics) || isTruthy(response.goLyricsApiTtml)) {
                response.song = combo.song;
                response.artist = combo.artist;
                response.album = combo.album;
                break;
            }
        }

        observe({
            combos: artistAlbumSongCombos,
            foundStats: foundStats,
            foundSyncedLyrics: isTruthy(response.musixmatchWordByWordLyrics) || isTruthy(response.lrclibSyncedLyrics) || isTruthy(response.musixmatchSyncedLyrics) || isTruthy(response.goLyricsApiTtml),
            foundPlainLyrics: isTruthy(response.lrclibPlainLyrics),
            foundRichSyncedLyrics: isTruthy(response.musixmatchSyncedLyrics),
            foundTtml: isTruthy(response.goLyricsApiTtml),
            foundLyrics: isTruthy(response.musixmatchWordByWordLyrics) || isTruthy(response.lrclibSyncedLyrics) || isTruthy(response.musixmatchSyncedLyrics) || isTruthy(response.lrclibPlainLyrics) || isTruthy(response.goLyricsApiTtml),
            response: response
        });

        return response;
    }
}
