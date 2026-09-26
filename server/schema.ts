import { z } from "zod";

export const Fact = z.object({ key: z.string(), value: z.string() });
export type Fact = z.infer<typeof Fact>;

export const Settings = z.object({
  username: z.string(),
  password: z.string(),
  preloadNext: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

export const Entry = z.object({
  url: z.string(),
  title: z.string(),
  original: z.string(),
  poster: z.string(),
  description: z.string(),
  genres: z.array(z.string()),
  facts: z.array(Fact),
  watched: z.array(z.string()),
  lastPlayer: z.string().nullable(),
  lastQuality: z.string().nullable(),
  total: z.number(),
  addedAt: z.number(),
});
export type Entry = z.infer<typeof Entry>;

export type Source = { quality: string; url: string; referer: string };
export type Episode = { title: string; tag: string; sources: Source[]; file: string | null };
export type Player = { id: string; path: string[]; episodes: Episode[]; resolvable: boolean };
export type Title = { entry: Entry; players: Player[]; external: string[]; dir: string };

export type CacheFile = {
  path: string;
  tag: string;
  quality: string;
  size: number;
  mtime: number;
  partial: boolean;
  busy: boolean;
};
export type CacheTitle = { slug: string; url: string | null; title: string; poster: string; size: number; files: CacheFile[] };
export type CacheInfo = { root: string; ttl: number; limit: number; size: number; titles: CacheTitle[] };

export type Progress = { id: string; done: number; total: number; bytesPerSec: number };

export type Events = {
  "preload:progress": Progress;
  "preload:done": { id: string; file: string };
  "preload:failed": { id: string; message: string };
  "library:entry": Entry;
  "library:syncing": number;
  "library:synced": { total: number; failed: number };
  "cache:dropped": string[];
};

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
