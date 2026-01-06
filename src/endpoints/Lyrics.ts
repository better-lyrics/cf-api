import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { LyricsService } from "../services/LyricsService";
import { LyricsResponseSchema, AppContext } from "../types";
import { observe } from "../observability";
import { verifyJwt } from "../auth";

export class Lyrics extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Get Lyrics",
        tags: ["Lyrics"],
        request: {
            query: z.object({
                videoId: z.string(),
                song: z.string().optional(),
                artist: z.string().optional(),
                album: z.string().optional(),
                duration: z.string().optional(),
                alwaysFetchMetadata: z.string().optional(),
                useLrcLib: z.string().optional(),
            })
        },
        responses: {
            "200": {
                description: "Lyrics found",
                content: {
                    "application/json": {
                        schema: LyricsResponseSchema
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

        if (!(env.BYPASS_AUTH && env.BYPASS_AUTH === "true")) {
            const authHeader = request.headers.get('Authorization');
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return c.json({ error: 'Authorization header missing or malformed' }, 403);
            }
            const token = authHeader.substring(7);
            const isTokenValid = await verifyJwt(token, env.JWT_SECRET, request.headers.get("CF-Connecting-IP") || "");
            if (!isTokenValid) {
                return c.json({ error: 'Invalid or expired token' }, 403);
            }
        }

        const cache = caches.default;
        let cachedResponse = await cache.match(request.url);
        if (cachedResponse) {
             observe({ usingCachedLyrics: true });
             return cachedResponse;
        }
        observe({ usingCachedLyrics: false });

        const service = new LyricsService(env);
        const url = new URL(request.url);
        
        try {
            const result = await service.getLyrics(url.searchParams);
            
            let corsHeaders =  {
                "Content-Type": "application/json",
                'Access-Control-Allow-Origin': 'https://music.youtube.com',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Vary': 'Origin'
            };

            const response = c.json(result, 200, corsHeaders);

            if (result.musixmatchSyncedLyrics || result.lrclibSyncedLyrics || result.goLyricsApiTtml) {
                response.headers.set('Cache-control', 'public; max-age=259200');
            } else {
                response.headers.set("Cache-control", "public; max-age=600");
            }

            c.executionCtx.waitUntil(cache.put(request.url, response.clone()));

            return response;
        } catch (e: any) {
            console.error(e);
            return c.json({ error: e.message || "Internal Error" }, 500);
        }
    }
}