import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { CacheService } from "../services/CacheService";
import { AppContext } from "../types";

export class DeleteCache extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Delete Cache",
        tags: ["Cache"],
        request: {
            query: z.object({
                videoId: z.string()
            }),
            headers: z.object({
                "x-admin-key": z.string().optional()
            })
        },
        responses: {
            "200": {
                description: "Cache Deleted",
                content: {
                    "application/json": {
                        schema: z.object({
                            success: z.boolean()
                        })
                    }
                }
            },
            "403": { description: "Unauthorized" }
        }
    };

    async handle(c: AppContext) {
        const env = c.env;
        const request = c.req.raw;

        if (!(env.BYPASS_AUTH && env.BYPASS_AUTH === "true")) {
             const adminKeys = env.ADMIN_KEYS ? env.ADMIN_KEYS.split(',') : [];
             const apiKey = request.headers.get('x-admin-key');
             
             if (!apiKey || !adminKeys.includes(apiKey)) {
                 return c.json({ error: 'Unauthorized' }, 403);
             }
        }

        const data = await this.getValidatedData<any>();

        const videoId = data.query?.videoId;

        if (!videoId) return c.json({ error: "Missing videoId" }, 400);

        const cacheService = new CacheService(env);

        await cacheService.deleteCache(videoId);

        return c.json({ success: true });
    }
}
