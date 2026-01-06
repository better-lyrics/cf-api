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
  debugInfo: z.any().nullable(),
  musixmatchWordByWordLyrics: z.any().nullable(),
  musixmatchSyncedLyrics: z.any().nullable(),
  lrclibSyncedLyrics: z.any().nullable(),
  lrclibPlainLyrics: z.any().nullable(),
  goLyricsApiTtml: z.any().nullable(),
});

export type LyricsResponse = z.infer<typeof LyricsResponseSchema>;

export interface Env extends Cloudflare.Env {
    REFETCH_THRESHOLD?: string; // seconds
    REFETCH_CHANCE?: string; // 0.0 to 1.0
}

export type AppContext = Context<{ Bindings: Env }>;
