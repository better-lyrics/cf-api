import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { LyricsService } from "../services/LyricsService";
import { AppContext, StreamingEvent } from "../types";
import { observe } from "../observability";
import { verifyJwt } from "../auth";

export class LyricsV2 extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Get Lyrics (Streaming v2)",
        tags: ["Lyrics"],
        security: [
            {
                bearerAuth: [],
            },
        ],
        request: {
            query: z.object({
                videoId: z.string(),
                song: z.string().optional(),
                artist: z.string().optional(),
                album: z.string().optional(),
                duration: z.string().optional(),
                alwaysFetchMetadata: z.string().optional(),
                token: z.string().optional().describe("JWT token (alternative to Authorization header)"),
            })
        },
        responses: {
            "200": {
                description: "Streaming lyrics events",
                content: {
                    "text/event-stream": {
                        schema: z.string()
                    }
                }
            },
            "403": {
                description: "Unauthorized"
            },
            "500": {
                description: "Internal Error"
            }
        }
    };

    async handle(c: AppContext) {
        const env = c.env;
        const request = c.req.raw;
        const url = new URL(request.url);
        const queryToken = url.searchParams.get('token');

        if (!(env.BYPASS_AUTH === "true")) {
            const authHeader = request.headers.get('Authorization');
            let token = '';

            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            } else if (queryToken) {
                token = queryToken;
            }

            if (!token) {
                return c.json({ error: 'Authorization token missing or malformed' }, 403);
            }

            const isTokenValid = await verifyJwt(token, env.JWT_SECRET, request.headers.get("CF-Connecting-IP") || "");
            if (!isTokenValid) {
                return c.json({ error: 'Invalid or expired token' }, 403);
            }
        }

        const cacheUrl = new URL(request.url);
        cacheUrl.searchParams.delete('token');
        const cacheKey = cacheUrl.toString();

        const cache = caches.default;
        const cachedResponse = await cache.match(cacheKey);
        
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendEvent = async (event: StreamingEvent) => {
            const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
            await writer.write(encoder.encode(chunk));
        };

        if (cachedResponse) {
             observe({ usingCachedLyrics: true, v2: true });
             const result = await cachedResponse.json() as any;
             
             // Run in background to not block the response return
             (async () => {
                try {
                    await sendEvent({ type: 'metadata', data: { 
                        song: result.song, 
                        artist: result.artist, 
                        album: result.album, 
                        duration: result.duration, 
                        videoId: result.videoId 
                    }});
                    
                    if (result.lrclibSyncedLyrics || result.lrclibPlainLyrics) {
                        await sendEvent({ type: 'provider', data: { 
                            provider: 'lrclib', 
                            results: { synced: result.lrclibSyncedLyrics, plain: result.lrclibPlainLyrics } 
                        }});
                    }
                    if (result.musixmatchSyncedLyrics || result.musixmatchWordByWordLyrics) {
                        await sendEvent({ type: 'provider', data: { 
                            provider: 'musixmatch', 
                            results: { synced: result.musixmatchSyncedLyrics, wordByWord: result.musixmatchWordByWordLyrics } 
                        }});
                    }
                    if (result.goLyricsApiLyrics) {
                        await sendEvent({ type: 'provider', data: { provider: 'golyrics', results: { lyrics: result.goLyricsApiLyrics } }});
                    }
                    if (result.qqLyricsApiLyrics) {
                        await sendEvent({ type: 'provider', data: { provider: 'qq', results: { lyrics: result.qqLyricsApiLyrics } }});
                    }
                    if (result.kugouLyricsApiLyrics) {
                        await sendEvent({ type: 'provider', data: { provider: 'kugou', results: { lyrics: result.kugouLyricsApiLyrics } }});
                    }
                    
                    await sendEvent({ type: 'done', data: {} });
                } catch (e) {
                    console.error("Error streaming cached response:", e);
                } finally {
                    await writer.close();
                }
             })();

             return new Response(readable, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
             });
        }

        observe({ usingCachedLyrics: false, v2: true });
        const service = new LyricsService(env);

        // Background process to fetch and stream
        (async () => {
            try {
                const fullResult = await service.getLyricsStreaming(url.searchParams, async (event) => {
                    await sendEvent(event);
                });

                if (fullResult) {
                    // Cache the full result for future requests (v1 or v2)
                    const cacheResponse = Response.json(fullResult);
                    if (fullResult.musixmatchSyncedLyrics || fullResult.lrclibSyncedLyrics || fullResult.goLyricsApiLyrics || fullResult.qqLyricsApiLyrics || fullResult.kugouLyricsApiLyrics) {
                        cacheResponse.headers.set('Cache-control', 'public; max-age=1080');
                    } else {
                        cacheResponse.headers.set("Cache-control", "public; max-age=600");
                    }
                    c.executionCtx.waitUntil(cache.put(cacheKey, cacheResponse));
                }
            } catch (e: any) {
                console.error("Streaming error:", e);
                await sendEvent({ type: 'error', data: { message: e.message || "Internal Error" } });
            } finally {
                await writer.close();
            }
        })();

        return new Response(readable, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        });
    }
}
