import { hc, type ClientResponse } from "hono/client";
import type { AppType } from "../server/app.ts";
import type { Entry, Events, Settings, Source } from "../server/schema.ts";

export type {
  CacheFile,
  CacheInfo,
  CacheTitle,
  Entry,
  Episode,
  Player,
  Progress,
  Settings,
  Source,
  Title,
} from "../server/schema.ts";

const client = hc<AppType>(location.origin);

// Отклоняемся голой строкой: компоненты пишут String(e) в тост.
async function call<T>(req: Promise<ClientResponse<T, number, "json">>): Promise<T> {
  let res: ClientResponse<T, number, "json">;
  try {
    res = await req;
  } catch {
    throw "нет связи с сервером AnimeJoy";
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw (body as { error?: string } | undefined)?.error ?? `сервер ответил ${res.status}`;
  return body as T;
}

const { api: r } = client;

export const api = {
  settingsGet: () => call(r.settings.$get()),
  settingsSet: (settings: Settings) => call(r.settings.$put({ json: settings })),
  libraryGet: () => call(r.library.$get()),
  libraryAdd: (url: string) => call(r.library.add.$post({ json: { url } })),
  librarySync: (force: boolean) => call(r.library.sync.$post({ json: { force } })),
  libraryRemove: (url: string) => call(r.library.remove.$post({ json: { url } })),
  libraryRestore: (entry: Entry, index: number) => call(r.library.restore.$post({ json: { entry, index } })),
  libraryReorder: (urls: string[]) => call(r.library.reorder.$post({ json: { urls } })),
  titleOpen: (url: string) => call(r.title.$get({ query: { url } })),
  playerResolve: (url: string, playerId: string) => call(r.title.resolve.$post({ json: { url, playerId } })),
  rememberChoice: (url: string, player?: string, quality?: string) =>
    call(r.title.remember.$post({ json: { url, player, quality } })),
  markWatched: (url: string, episodes: string[], watched: boolean) =>
    call(r.title.watched.$post({ json: { url, episodes, watched } })),
  preloadStart: (a: { pageUrl: string; episode: string; quality: string; sourceUrl: string; referer: string }) =>
    call(r.preload.$post({ json: a })),
  preloadCancel: (id: string) => call(r.preload.cancel.$post({ json: { id } })),
  cacheList: () => call(r.cache.$get()),
  cacheDrop: (path: string) => call(r.cache.drop.$post({ json: { path } })),
  cacheDropTitle: (slug: string) => call(r.cache["drop-title"].$post({ json: { slug } })),
  cacheClear: () => call(r.cache.clear.$post()),
  cacheSweep: () => call(r.cache.sweep.$post()),
};

let stream: EventSource | null = null;

// EventSource сам переподключается, поэтому поток поднимаем один раз на страницу.
export function on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
  stream ??= new EventSource("/api/events");
  const handler = (ev: MessageEvent<string>) => cb(JSON.parse(ev.data) as Events[K]);
  stream.addEventListener(event, handler);
  return () => stream?.removeEventListener(event, handler);
}

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

const local = (u: URL): string => u.pathname + u.search;

// С `name` сервер отдаёт файл как вложение, и его забирает менеджер загрузок браузера.
export const media = {
  file: (path: string, name?: string) => local(client.media.file.$url({ query: { path, name } })),
  remote: (s: Source, name?: string) =>
    local(client.media.remote.$url({ query: { url: s.url, referer: s.referer, name } })),
};

export function saveAs(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.click();
}
