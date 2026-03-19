import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { LyricsService } from "../services/LyricsService";
import { AppContext } from "../types";
import { verifyTurnstileToken, verifyJwt } from "../auth";

export class RevalidateCache extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Revalidate Cache",
        tags: ["Cache"],
        security: [
            { apiKeyAuth: [] },
            { turnstileAuth: [] },
            { bearerAuth: [] }
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
            }),
        },
        responses: {
            "200": {
                description: "Cache Revalidated",
                content: {
                    "application/json": {
                        schema: z.object({
                            success: z.boolean(),
                            videoId: z.string(),
                            status: z.any()
                        })
                    }
                }
            },
            "403": { description: "Unauthorized" },
            "400": { description: "Bad Request" }
        }
    };

    async handle(c: AppContext) {
        const env = c.env;
        const request = c.req.raw;

        if (!(env.BYPASS_AUTH === "true")) {
            const adminKeys = env.ADMIN_KEYS ? env.ADMIN_KEYS.split(',') : [];
            const apiKey = request.headers.get('x-admin-key');
            const turnstileToken = request.headers.get("turnstile-token");
            const authHeader = request.headers.get('Authorization');

            let isAuthorized = false;

            // 1. Check Admin Key
            if ((apiKey && adminKeys.includes(apiKey)) || env.BYPASS_AUTH === "true") {
                isAuthorized = true;
            }

            // 2. Check Turnstile Token
            if (!isAuthorized && turnstileToken) {
                isAuthorized = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET_KEY);
            }

            // 3. Check JWT
            if (!isAuthorized && authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                isAuthorized = await verifyJwt(token, env.JWT_SECRET, request.headers.get("CF-Connecting-IP") || "");
            }

            if (!isAuthorized) {
                return c.json({ error: 'Unauthorized' }, 403);
            }
        }


        const data = await this.getValidatedData<any>();
        const videoId = data.query?.videoId;

        if (!videoId) return c.json({ error: "Missing videoId" }, 400);

        const service = new LyricsService(env);
        try {
            const queryParams = new URLSearchParams();
            for (const [key, value] of Object.entries(data.query)) {
                if (value !== undefined) {
                    queryParams.set(key, String(value));
                }
            }
            const result = await service.revalidateLyrics(queryParams);

            // Clear the Cloudflare Cache for this videoId to ensure next fetch gets fresh data
            const cache = caches.default;
            const url = new URL(request.url);
            url.pathname = "/lyrics"; // Clear /lyrics
            await cache.delete(url.toString());
            url.pathname = "/v2/lyrics"; // Clear /v2/lyrics
            await cache.delete(url.toString());

            return c.json(result);
        } catch (e: any) {
            console.error(e);
            return c.json({ success: false, error: e.message || "Internal Error" }, 500);
        }
    }
}
