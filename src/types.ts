import { z } from "zod";
import { Context } from "hono";

export const LyricsResponseSchema = z.object({
  song: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  duration: z.string().nullable(),
  parsedSongAndArtist: z.string().nullable(),
  videoId: z.string().nullable(),
  description: z.string().nullable(),
  musixmatchWordByWordLyrics: z.any().nullable(),
  musixmatchSyncedLyrics: z.any().nullable(),
  lrclibSyncedLyrics: z.any().nullable(),
  lrclibPlainLyrics: z.any().nullable(),
  goLyricsApiLyrics: z.any().nullable(),
  qqLyricsApiLyrics: z.any().nullable(),
  kugouLyricsApiLyrics: z.any().nullable(),
});

export type LyricsResponse = z.infer<typeof LyricsResponseSchema>;

export type StreamingEvent = 
  | { type: 'metadata', data: Partial<LyricsResponse> }
  | { type: 'provider', data: { provider: string, results: any } }
  | { type: 'error', data: { message: string } }
  | { type: 'done', data: Record<string, never> };

export interface Env extends Omit<Cloudflare.Env, "DB"> {
    DB: D1Database | D1DatabaseSession;
    REFETCH_THRESHOLD?: string; // seconds
    REFETCH_CHANCE?: string; // 0.0 to 1.0
    NEGATIVE_CACHE_TTL_LRCLIB?: string; // seconds
    NEGATIVE_CACHE_TTL_MUSIXMATCH?: string; // seconds
    BYPASS_AUTH: string;
    JWT_SECRET: string;
    ADMIN_KEYS: string;
    TURNSTILE_SECRET_KEY: string;
    GOOGLE_API_KEY: string;
    GO_API_KEY: string;
    ALLOWED_ORIGINS: string;
    LYRICS_BUCKET: R2Bucket;
}

export type AppContext = Context<{ Bindings: Env }>;