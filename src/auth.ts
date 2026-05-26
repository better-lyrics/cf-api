// src/auth.ts

import { observe } from './observability';
import { env } from 'cloudflare:workers';

interface TurnstileVerificationResponse {
    'success': boolean;
    'error-codes'?: string[];
    'challenge_ts'?: string;
    'hostname'?: string;
    'action'?: string;
    'cdata'?: string;
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify endpoint.
 * @param token The Turnstile token from the client.
 * @param secretKey Your Turnstile secret key.
 * @returns True if the token is valid, false otherwise.
 */
export async function verifyTurnstileToken(token: string, secretKey: string): Promise<boolean> {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            secret: secretKey,
            response: token,
        }),
    });

    const data: TurnstileVerificationResponse = await response.json();
    return data.success;
}

// --- JWT HELPER FUNCTIONS ---

function base64UrlEncode(str: string): string {
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
        str += '=';
    }
    return atob(str);
}


/**
 * Creates a new JWT and includes the user's IP address.
 * @param secretKey The secret to sign the token with.
 * @param ipAddress The IP address of the user requesting the token.
 * @returns A promise that resolves with the JWT string.
 */
export async function createJwt(secretKey: string, ipAddress: string): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24), // 24-hour expiration
        jti: crypto.randomUUID(),
        ip: ipAddress, // Bind the token to the user's IP address
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secretKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );

    const encodedSignature = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

export type JwtVerificationResult =
    | { valid: true, jti: string }
    | { valid: false; reason: 'malformed' | 'expired' | 'ip_mismatch' | 'bad_signature' | 'rate_limited' | 'bad_jti' | 'error'  };

/**
 * Verifies an incoming JWT's signature, expiration, and IP address claim.
 * @param token The JWT from the Authorization header.
 * @param secretKey The secret key to verify the signature with.
 * @param requestIp The IP address of the incoming request.
 * @returns A result object indicating validity and, on failure, the reason.
 */
export async function verifyJwt(token: string, secretKey: string, requestIp: string): Promise<JwtVerificationResult> {
    try {
        const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
        if (!encodedHeader || !encodedPayload || !encodedSignature) {
            return { valid: false, reason: 'malformed' };
        }

        const payload = JSON.parse(base64UrlDecode(encodedPayload));

        // 1. Check if the token has expired
        if (payload.exp && Date.now() / 1000 > payload.exp) {
            observe({ jwtLog: 'JWT has expired' });
            return { valid: false, reason: 'expired' };
        }

        // 2. Verify the signature
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secretKey),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );

        const signature = Uint8Array.from(base64UrlDecode(encodedSignature), c => c.charCodeAt(0));

        const signatureValid = await crypto.subtle.verify(
            'HMAC',
            key,
            signature,
            new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
        );

        if (!signatureValid) {
            observe({ jwtLog: 'JWT signature verification failed' });
            return { valid: false, reason: 'bad_signature' };
        }

        if (!payload.jti) {
            return { valid: false, reason: 'bad_jti' };
        }

        try {
            const { success } = await env.RATE_LIMIT.limit({ key: payload.jti })

            if (!success) {
                return { valid: false, reason: 'rate_limited' };
            }
        } catch (e) {
            observe({ jwtLog: 'Rate Limit Error', error: e });
        }


        return { valid: true, jti: payload.jti };
    } catch (e) {
        console.error("JWT verification error:", e);
        return { valid: false, reason: 'error' };
    }
}

const JWT_REASON_MESSAGES: Record<Exclude<JwtVerificationResult, { valid: true }>['reason'], string> = {
    malformed: 'Authorization token is malformed',
    expired: 'Authorization token has expired',
    ip_mismatch: 'Authorization token IP does not match request IP',
    bad_signature: 'Authorization token signature verification failed',
    rate_limited: 'Too many requests with this Authorization token. Try again later',
    bad_jti: 'JTI is invalid',
    error: 'Authorization token could not be verified',
};

export function jwtFailureMessage(reason: Exclude<JwtVerificationResult, { valid: true }>['reason']): string {
    return JWT_REASON_MESSAGES[reason];
}

