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

type Reply = { ok: boolean; data?: unknown; error?: string };

// Отклоняемся голой строкой, как это делал Tauri: компоненты пишут String(e) в тост.
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw "нет связи с сервером AnimeJoy";
  }
  let body: Reply;
  try {
    body = (await res.json()) as Reply;
  } catch {
    throw `сервер ответил ${res.status}`;
  }
  if (!body.ok) throw body.error ?? `сервер ответил ${res.status}`;
  return body.data as T;
}

export const api = {
  settingsGet: () => call<Settings>("settings_get"),
  settingsSet: (settings: Settings) => call<void>("settings_set", { settings }),
  libraryGet: () => call<Entry[]>("library_get"),
  libraryAdd: (url: string) => call<Entry>("library_add", { url }),
  librarySync: (force: boolean) => call<void>("library_sync", { force }),
  libraryRemove: (url: string) => call<void>("library_remove", { url }),
  libraryReorder: (urls: string[]) => call<Entry[]>("library_reorder", { urls }),
  titleOpen: (url: string) => call<Title>("title_open", { url }),
  playerResolve: (url: string, playerId: string) =>
    call<Episode[]>("player_resolve", { url, playerId }),
  rememberChoice: (url: string, player?: string, quality?: string) =>
    call<void>("remember_choice", { url, player, quality }),
  markWatched: (url: string, episode: string, watched: boolean) =>
    call<string[]>("mark_watched", { url, episode, watched }),
  stream: (url: string, title: string, referer: string) =>
    call<string>("stream", { url, title, referer }),
  playFile: (path: string, title: string) => call<string>("play_file", { path, title }),
  downloadStart: (a: {
    pageUrl: string;
    episode: string;
    quality: string;
    sourceUrl: string;
    referer: string;
    autoplay: boolean;
  }) => call<string>("download_start", a),
  downloadCancel: (id: string) => call<void>("download_cancel", { id }),
  fileDelete: (path: string) => call<void>("file_delete", { path }),
  openDir: (path: string) => call<void>("open_dir", { path }),
};

type Handler = (payload: never) => void;

const handlers = new Map<string, Set<Handler>>();
let stream: EventSource | null = null;

// EventSource сам переподключается, поэтому поток поднимаем один раз на страницу.
function ensure(): void {
  if (stream !== null) return;
  stream = new EventSource("/api/events");
  stream.onmessage = (ev) => {
    let parsed: { event: string; payload: never };
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    handlers.get(parsed.event)?.forEach((h) => h(parsed.payload));
  };
}

function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  ensure();
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(cb as Handler);
  handlers.set(event, set);
  return Promise.resolve(() => {
    set.delete(cb as Handler);
  });
}

export const on = {
  progress: (f: (p: Progress) => void) => listen<Progress>("download:progress", f),
  done: (f: (p: { id: string; file: string }) => void) =>
    listen<{ id: string; file: string }>("download:done", f),
  failed: (f: (p: { id: string; message: string }) => void) =>
    listen<{ id: string; message: string }>("download:failed", f),
  playerError: (f: (m: string) => void) => listen<string>("player:error", f),
  entry: (f: (e: Entry) => void) => listen<Entry>("library:entry", f),
  syncing: (f: (n: number) => void) => listen<number>("library:syncing", f),
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

export const media = {
  file: (file: string) => `/media/file?path=${encodeURIComponent(file)}`,
  remote: (s: Source) =>
    `/media/remote?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}`,
};
