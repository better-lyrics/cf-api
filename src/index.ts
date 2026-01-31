import { fromHono, ApiException } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Lyrics } from "./endpoints/Lyrics";
import { VerifyTurnstile } from "./endpoints/VerifyTurnstile";
import { DeleteCache } from "./endpoints/DeleteCache";
import { flushObservability, runWithObservability } from "./observability";
import { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: 'https://music.youtube.com',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

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

openapi.get("/lyrics", Lyrics);
openapi.post("/verify-turnstile", VerifyTurnstile);
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