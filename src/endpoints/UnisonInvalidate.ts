import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { AppContext } from "../types";
import { isValidVideoId, Unison } from "../providers/Unison";

const MAX_VIDEO_IDS = 500;

async function matchesSecret(header: string | undefined, secret: string | undefined): Promise<boolean> {
    if (!secret || !header?.startsWith("Bearer ")) return false;
    const encoder = new TextEncoder();
    // Hash both sides so timingSafeEqual always compares equal-length buffers.
    const [provided, expected] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7).trim())),
        crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    ]);
    return crypto.subtle.timingSafeEqual(provided, expected);
}

export class UnisonInvalidate extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Invalidate cached Unison lookups",
        description: "Called by Unison whenever the lyrics it would serve for a video may have changed.",
        tags: ["Cache"],
        security: [
            {
                bearerAuth: [],
            },
        ],
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            videoIds: z.array(z.string()).max(MAX_VIDEO_IDS),
                        }),
                    },
                },
            },
        },
        responses: {
            "200": {
                description: "Entries invalidated",
                content: {
                    "application/json": {
                        schema: z.object({ success: z.boolean(), invalidated: z.number() }),
                    },
                },
            },
            "400": { description: "Invalid body" },
            "403": { description: "Unauthorized" },
        },
    };

    async handle(c: AppContext) {
        if (!(await matchesSecret(c.req.header("Authorization"), c.env.UNISON_INVALIDATE_SECRET))) {
            return c.json({ success: false, error: "Unauthorized" }, 403);
        }

        const body = await c.req.json().catch(() => null) as { videoIds?: unknown } | null;
        if (!body || !Array.isArray(body.videoIds) || body.videoIds.length > MAX_VIDEO_IDS) {
            return c.json({ success: false, error: `videoIds must be an array of at most ${MAX_VIDEO_IDS} ids` }, 400);
        }

        const videoIds = [...new Set(body.videoIds.filter(isValidVideoId))];
        await new Unison(c.env).invalidate(videoIds);

        return c.json({ success: true, invalidated: videoIds.length });
    }
}
