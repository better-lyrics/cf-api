import { OpenAPIRoute, OpenAPIRouteSchema } from "chanfana";
import { z } from "zod";
import { verifyTurnstileToken, createJwt } from "../auth";
import { AppContext } from "../types";

export class VerifyTurnstile extends OpenAPIRoute {
    schema: OpenAPIRouteSchema = {
        summary: "Verify Turnstile Token",
        tags: ["Auth"],
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            token: z.string()
                        })
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "JWT Token",
                content: {
                    "application/json": {
                        schema: z.object({
                            jwt: z.string()
                        })
                    }
                }
            },
            "400": { description: "Bad Request" },
            "401": { description: "Invalid Token" }
        }
    };

    async handle(c: AppContext) {
        const data = await this.getValidatedData<any>();
        const turnstileToken = data.body?.token;

        if (!turnstileToken) {
            return c.json({ error: 'Missing token' }, 400);
        }

        const isValid = await verifyTurnstileToken(turnstileToken, c.env.TURNSTILE_SECRET_KEY);

        const corsHeaders = {
            'Access-Control-Allow-Origin': 'https://music.youtube.com',
            'Access-Control-Allow-Credentials': 'true',
        };

        if (isValid) {
            const jwt = await createJwt(c.env.JWT_SECRET, c.req.raw.headers.get("CF-Connecting-IP") || "");
            return c.json({ jwt }, 200, corsHeaders);
        } else {
            return c.json({ error: 'Invalid Turnstile token' }, 401, corsHeaders);
        }
    }
}