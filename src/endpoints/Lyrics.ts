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
                useLrcLib: z.string().optional(),
                token: z.string().optional().describe("JWT token (alternative to Authorization header)"),
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
        if (cachedResponse) {
             observe({ usingCachedLyrics: true });
             return cachedResponse;
        }
        observe({ usingCachedLyrics: false });

        const service = new LyricsService(env);

        try {
            const result = await service.getLyrics(url.searchParams);

            const response = c.json(result, 200);

            if (result.musixmatchSyncedLyrics || result.lrclibSyncedLyrics || result.goLyricsApiLyrics || result.qqLyricsApiLyrics || result.kugouLyricsApiLyrics) {
                response.headers.set('Cache-control', 'public; max-age=1080');
            } else {
                response.headers.set("Cache-control", "public; max-age=600");
            }

            c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

            return response;
        } catch (e: any) {
            console.error(e);
            return c.json({ error: e.message || "Internal Error" }, 500);
        }
    }
}
