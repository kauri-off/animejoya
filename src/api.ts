import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Fact = { key: string; value: string };
export type Source = { quality: string; url: string; referer: string };

export type Entry = {
  url: string;
  title: string;
  original: string;
  poster: string;
  description: string;
  genres: string[];
  facts: Fact[];
  watched: string[];
  lastPlayer: string | null;
  lastQuality: string | null;
  addedAt: number;
};

export type Episode = { title: string; tag: string; sources: Source[]; file: string | null };
export type Player = { id: string; path: string[]; episodes: Episode[]; resolvable: boolean };
export type Title = { entry: Entry; players: Player[]; external: string[]; dir: string };

export type Settings = {
  username: string;
  password: string;
  videoDir: string | null;
  player: string | null;
  streamByDefault: boolean;
};

export type Progress = { id: string; done: number; total: number; bytesPerSec: number };

export const api = {
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (settings: Settings) => invoke<void>("settings_set", { settings }),
  libraryGet: () => invoke<Entry[]>("library_get"),
  libraryAdd: (url: string) => invoke<Entry>("library_add", { url }),
  librarySync: (force: boolean) => invoke<void>("library_sync", { force }),
  libraryRemove: (url: string) => invoke<void>("library_remove", { url }),
  titleOpen: (url: string) => invoke<Title>("title_open", { url }),
  playerResolve: (url: string, playerId: string) =>
    invoke<Episode[]>("player_resolve", { url, playerId }),
  rememberChoice: (url: string, player?: string, quality?: string) =>
    invoke<void>("remember_choice", { url, player, quality }),
  markWatched: (url: string, episode: string, watched: boolean) =>
    invoke<string[]>("mark_watched", { url, episode, watched }),
  stream: (url: string, title: string, referer: string) =>
    invoke<string>("stream", { url, title, referer }),
  playFile: (path: string, title: string) => invoke<string>("play_file", { path, title }),
  downloadStart: (a: {
    pageUrl: string;
    episode: string;
    quality: string;
    sourceUrl: string;
    referer: string;
    autoplay: boolean;
  }) => invoke<string>("download_start", a),
  downloadCancel: (id: string) => invoke<void>("download_cancel", { id }),
  fileDelete: (path: string) => invoke<void>("file_delete", { path }),
  openDir: (path: string) => invoke<void>("open_dir", { path }),
};

export const on = {
  progress: (f: (p: Progress) => void) => listen<Progress>("download:progress", (e) => f(e.payload)),
  done: (f: (p: { id: string; file: string }) => void) =>
    listen<{ id: string; file: string }>("download:done", (e) => f(e.payload)),
  failed: (f: (p: { id: string; message: string }) => void) =>
    listen<{ id: string; message: string }>("download:failed", (e) => f(e.payload)),
  playerError: (f: (m: string) => void) => listen<string>("player:error", (e) => f(e.payload)),
  entry: (f: (e: Entry) => void) => listen<Entry>("library:entry", (e) => f(e.payload)),
  syncing: (f: (n: number) => void) => listen<number>("library:syncing", (e) => f(e.payload)),
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function rank(quality: string): number {
  return parseInt(quality, 10) || 0;
}
