// src/auth.ts

import { observe } from './observability';

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

/**
 * Verifies an incoming JWT's signature, expiration, and IP address claim.
 * @param token The JWT from the Authorization header.
 * @param secretKey The secret key to verify the signature with.
 * @param requestIp The IP address of the incoming request.
 * @returns True if the token is valid, false otherwise.
 */
export async function verifyJwt(token: string, secretKey: string, requestIp: string): Promise<boolean> {
    try {
        const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
        if (!encodedHeader || !encodedPayload || !encodedSignature) {
            return false;
        }

        const payload = JSON.parse(base64UrlDecode(encodedPayload));

        // 1. Check if the token has expired
        if (payload.exp && Date.now() / 1000 > payload.exp) {
            observe({jwtLog: 'JWT has expired' });
            return false;
        }

        // 2. Check if the IP address matches the one in the token
        if (payload.ip !== requestIp) {
            observe({jwtLog: `JWT IP mismatch. Token IP: ${payload.ip}, Request IP: ${requestIp}` });
            return false;
        }

        // 3. Verify the signature
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secretKey),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );

        const signature = Uint8Array.from(base64UrlDecode(encodedSignature), c => c.charCodeAt(0));

        return await crypto.subtle.verify(
            'HMAC',
            key,
            signature,
            new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
        );
    } catch (e) {
        console.error("JWT verification error:", e);
        return false;
    }
}

