import { fromHono, ApiException } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Lyrics } from "./endpoints/Lyrics";
import { LyricsV2 } from "./endpoints/LyricsV2";
import { VerifyTurnstile } from "./endpoints/VerifyTurnstile";
import { DeleteCache } from "./endpoints/DeleteCache";
import { RevalidateCache } from "./endpoints/RevalidateCache";
import { flushObservability, runWithObservability } from "./observability";
import { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use('*', (c, next) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS ? c.env.ALLOWED_ORIGINS.split(',') : ['https://music.youtube.com'];
    return cors({
        origin: (origin) => {
            if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
                return origin;
            }
            return allowedOrigins[0];
        },
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'x-admin-key', 'turnstile-token'],
        exposeHeaders: ['Content-Length'],
        maxAge: 86400,
        credentials: true,
    })(c, next);
});

app.onError((err, c) => {
    if (err instanceof ApiException) {
        return c.json(
            { success: false, errors: err.buildResponse() },
            err.status as any,
        );
    }

    console.error("Global error handler caught:", err);
    return c.json(
        {
            success: false,
            errors: [{ code: 7000, message: "Internal Server Error" }],
        },
        500,
    );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
    docs_url: "/",
    schema: {
        info: {
            title: "Better Lyrics API",
            version: "1.0",
            description: "API for fetching synchronized lyrics from multiple sources.",
        },
    },
});

openapi.registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
});
openapi.registry.registerComponent("securitySchemes", "apiKeyAuth", {
    type: "apiKey",
    in: "header",
    name: "x-admin-key",
});
openapi.registry.registerComponent("securitySchemes", "turnstileAuth", {
    type: "apiKey",
    in: "header",
    name: "turnstile-token",
});

openapi.get("/lyrics", Lyrics);
openapi.get("/v2/lyrics", LyricsV2);
openapi.post("/verify-turnstile", VerifyTurnstile);
openapi.post("/revalidate", RevalidateCache);
openapi.delete("/cache", DeleteCache);

// Manual route for assets
app.get("/challenge", (c) => {
    return c.env.ASSETS.fetch(c.req.raw);
});

export default {
    fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
        return runWithObservability(async () => {
            try {
                // Use D1 sessions to enable read replicas and sequential consistency
                const sessionDB = 'withSession' in env.DB ? env.DB.withSession() : env.DB;
                const sessionEnv: Env = { ...env, DB: sessionDB };

                return await app.fetch(request, sessionEnv, ctx);
            } finally {
                ctx.waitUntil(flushObservability());
            }
        });
    }
};
