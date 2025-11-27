import { getLyrics } from './GetLyrics';
import { verifyTurnstileToken, createJwt, verifyJwt } from './auth';
import { observabilityData } from './LyricUtils';

export let awaitLists = new Set<Promise<any>>();

const BYPASS_AUTH = true; // Set to true to bypass authentication for local development

export function observe(data: Record<string, any>): void {
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            const value = data[key];

            // If we've never seen this key before, initialize its value as an empty array.
            if (!observabilityData[key]) {
                observabilityData[key] = [];
            }

            // Push the new value into the array for that key.
            observabilityData[key].push(value);
        }
    }
}


export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        Object.keys(observabilityData).forEach(key => delete observabilityData[key]);
        awaitLists = new Set<Promise<any>>();
        const url = new URL(request.url);
        try {
            // Simple Router
            if (request.method === "OPTIONS") {
                return new Response(null, {
                    headers: {
                        "Content-Type": "application/json",
                        'Access-Control-Allow-Origin': 'https://music.youtube.com',
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                        'Access-Control-Max-Age': '86400',
                        'Cache-Control': 'public, max-age=86400',
                        'Vary': 'Origin'

                    },
                });
            }
            if (url.pathname === '/challenge') {
                return env.ASSETS.fetch(request);
            }

            if (url.pathname === '/verify-turnstile' && request.method === 'POST') {
                return handleTurnstileVerification(request, env);
            }

            if (url.pathname === '/' || url.pathname === "/lyrics") {
                return handleLyricsRequest(request, env, ctx);
            }

            return new Response('Not Found', { status: 404 });
        } catch (e) {
            console.error(e);
            return new Response('Internal Error', { status: 500 });
        } finally {
            // console.log(observabilityData);
        }
    },
} satisfies ExportedHandler<Env>;


async function handleTurnstileVerification(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
        'Access-Control-Allow-Origin': 'https://music.youtube.com',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Content-Type': 'application/json'
    };
    try {
        const body: { token: string } = await request.json();
        const turnstileToken = body.token;

        if (!turnstileToken) {
            return new Response(JSON.stringify({ error: 'Turnstile token not provided' }), {
                status: 400,
                headers: corsHeaders
            });
        }

        const isValid = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET_KEY);

        if (isValid) {
            const jwt = await createJwt(env.JWT_SECRET, request.headers.get("CF-Connecting-IP") || "");
            return new Response(JSON.stringify({ jwt }), { status: 200, headers: corsHeaders });
        } else {
            return new Response(JSON.stringify({ error: 'Invalid Turnstile token' }), {
                status: 401,
                headers: corsHeaders
            });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: 'An error occurred' }), { status: 500, headers: corsHeaders });
    }
}

async function handleLyricsRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = {
        'Access-Control-Allow-Origin': 'https://music.youtube.com',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Content-Type': 'application/json'
    };

    if (!BYPASS_AUTH) {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Authorization header missing or malformed' }), {
                status: 403,
                headers: corsHeaders
            });
        }

        const token = authHeader.substring(7); // Remove "Bearer "
        const isTokenValid = await verifyJwt(token, env.JWT_SECRET, request.headers.get("CF-Connecting-IP") || "");

        if (!isTokenValid) {
            return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
                status: 403,
                headers: corsHeaders
            });
        }
    }


    // If token is valid, proceed to get the lyrics
    try {
        let response = await getLyrics(request, env);
        // Re-apply CORS headers to the final response
        response = new Response(response.body, response);
        Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
        });
        for (const awaitList of awaitLists) {
            ctx.waitUntil(awaitList);
        }
        return response;
    } catch (e) {
        console.error(e);
        return new Response('An internal error occurred', { status: 500, headers: corsHeaders });
    }
}


