import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as store from "./store.ts";
import type { Entry, Settings } from "./store.ts";
import * as cache from "./cache.ts";
import * as media from "./media.ts";
import { fetchFile } from "./download.ts";
import type { Progress } from "./download.ts";
import { assets } from "./assets.generated.ts";
import {
  Playlist,
  Site,
  isAuthorized,
  parseMeta,
  parseNewsId,
} from "./site.ts";
import type { Episode, Meta, Source } from "./site.ts";

type EpisodeView = { title: string; tag: string; sources: Source[]; file: string | null };
type PlayerView = { id: string; path: string[]; episodes: EpisodeView[]; resolvable: boolean };
type TitleView = { entry: Entry; players: PlayerView[]; external: string[]; dir: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/// Страница тайтла в DLE: `/<раздел>/<id>-<slug>.html` — домен может быть любым зеркалом.
function isTitleUrl(url: string): boolean {
  try {
    return /\/\d+-[^/]*\.html?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const site = new Site();
const library: Entry[] = store.loadLibrary();
const cancels = new Map<string, AbortController>();
const playlists = new Map<string, Playlist>();

const clients = new Set<http.ServerResponse>();

function emit(event: string, payload: unknown): void {
  const line = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const c of clients) c.write(line);
}

/// Открывает страницу тайтла, при необходимости логинясь один раз за сессию.
async function page(url: string): Promise<string> {
  let html = await site.getPage(url);
  if (isAuthorized(html)) return html;

  const cfg = store.loadSettings();
  if (cfg.username === "") throw new Error("нужен вход: укажите логин и пароль в настройках");
  await site.login(cfg.username, cfg.password, url);

  html = await site.getPage(url);
  if (!isAuthorized(html)) throw new Error("страница недоступна — проверьте ссылку и права аккаунта");
  return html;
}

function merge(entry: Entry, meta: Meta): void {
  entry.title = meta.title;
  entry.original = meta.original;
  entry.poster = meta.poster;
  entry.description = meta.description;
  entry.genres = meta.genres;
  entry.facts = meta.facts;
}

/// Кладёт свежие метаданные в библиотеку, добавляя запись при первой встрече.
function upsert(url: string, meta: Meta): Entry {
  let entry = library.find((e) => e.url === url);
  if (entry === undefined) {
    entry = store.blank(url);
    merge(entry, meta);
    library.unshift(entry);
  } else {
    merge(entry, meta);
  }
  store.saveLibrary(library);
  return { ...entry };
}

function episodeView(e: Episode, dir: string): EpisodeView {
  const tag = store.epTag(e.title);
  let file: string | null = null;
  for (const s of e.sources) {
    const candidate = path.join(dir, `${tag}-${s.quality}.mp4`);
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  return { title: e.title, tag, sources: e.sources, file };
}

const destPath = (pageUrl: string, epTitle: string, quality: string): string =>
  path.join(cache.dirOf(store.slug(pageUrl)), `${store.epTag(epTitle)}-${quality}.mp4`);

const sweep = (): void => void cache.sweep(new Set(cancels.keys())).catch(() => {});

/// Не больше четырёх запросов разом, чтобы не ловить лимиты чужого сайта.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/// Догружает ссылки AllVideo/Sibnet: там на каждую серию своя страница
/// плеера, поэтому дёргаем это только когда озвучку действительно выбрали.
async function resolvePlayer(url: string, playerId: string): Promise<EpisodeView[]> {
  const playlist = playlists.get(url);
  if (playlist === undefined) throw new Error("тайтл не открыт");
  const episodes = playlist.episodesOf(playerId);
  if (episodes.length === 0) throw new Error("у этой озвучки нет серий");

  const dir = cache.dirOf(store.slug(url));

  const from = new URL(url).origin;
  const resolved = await mapLimit(
    episodes.map((e) => e.embed),
    4,
    (embed) => site.resolve(embed, from),
  );

  const out: EpisodeView[] = [];
  let last: unknown = null;
  episodes.forEach((e, i) => {
    const r = resolved[i]!;
    const copy: Episode = { ...e };
    if (r.status === "fulfilled") copy.sources = r.value;
    else last = r.reason;
    out.push(episodeView(copy, dir));
  });

  if (out.every((e) => e.sources.length === 0)) {
    throw last ?? new Error("плеер не отдал ссылок");
  }
  return out;
}

type Args = Record<string, never> & Record<string, any>;

const handlers: Record<string, (a: Args) => Promise<unknown>> = {
  settings_get: async () => store.loadSettings(),

  settings_set: async ({ settings }) => {
    store.saveSettings(settings as Settings);
  },

  library_get: async () => library,

  /// Добавляет ссылку и сразу подтягивает обложку с описанием.
  library_add: async ({ url }) => {
    const target = store.normalizeUrl(url as string);
    if (!isTitleUrl(target)) throw new Error("это не ссылка на страницу тайтла");
    return upsert(target, parseMeta(await page(target)));
  },

  /// Догружает обложки и описания для записей, где их ещё нет.
  library_sync: async ({ force }) => {
    const todo = library.filter((e) => force || e.poster === "").map((e) => e.url);
    if (todo.length === 0) return;
    void (async () => {
      emit("library:syncing", todo.length);
      for (const url of todo) {
        try {
          emit("library:entry", upsert(url, parseMeta(await page(url))));
        } catch {}
      }
      emit("library:syncing", 0);
    })();
  },

  library_remove: async ({ url }) => {
    const i = library.findIndex((e) => e.url === url);
    if (i >= 0) library.splice(i, 1);
    store.saveLibrary(library);
  },

  /// Порядок задаёт клиент; неизвестные ссылки игнорируем, непришедшие оставляем в хвосте.
  library_reorder: async ({ urls }) => {
    const order: unknown = urls;
    if (!Array.isArray(order) || order.some((u: unknown) => typeof u !== "string")) {
      throw new Error("ожидался список ссылок");
    }
    const rest = new Map(library.map((e) => [e.url, e]));
    const next: Entry[] = [];
    for (const url of order as string[]) {
      const e = rest.get(url);
      if (e) {
        next.push(e);
        rest.delete(url);
      }
    }
    next.push(...rest.values());
    store.saveLibrary(next);
    library.length = 0;
    library.push(...next);
    return library;
  },

  /// Полная карточка тайтла: озвучки, серии, что уже лежит в кэше.
  title_open: async ({ url }): Promise<TitleView> => {
    const target = store.normalizeUrl(url as string);
    const html = await page(target);
    const newsId = parseNewsId(html);
    if (newsId === null) throw new Error("на странице нет плейлиста (это точно страница тайтла?)");

    const meta = parseMeta(html);
    const playlist = await site.playlist(newsId, target);

    const dir = cache.dirOf(store.slug(target));

    const players: PlayerView[] = playlist.playable().map((c) => ({
      id: c.id,
      path: c.path,
      resolvable: c.resolvable,
      episodes: playlist.episodesOf(c.id).map((e) => episodeView(e, dir)),
    }));
    const external = playlist.externalNames();

    playlists.set(target, playlist);
    return { entry: upsert(target, meta), players, external, dir };
  },

  player_resolve: async ({ url, playerId }) =>
    resolvePlayer(store.normalizeUrl(url as string), playerId as string),

  /// Запоминает последнюю озвучку/качество, чтобы не спрашивать их каждый раз.
  remember_choice: async ({ url, player: chosen, quality }) => {
    const e = library.find((x) => x.url === url);
    if (e !== undefined) {
      if (chosen != null) e.lastPlayer = chosen as string;
      if (quality != null) e.lastQuality = quality as string;
    }
    store.saveLibrary(library);
  },

  mark_watched: async ({ url, episode, watched }) => {
    const e = library.find((x) => x.url === url);
    if (e === undefined) return [];
    e.watched = e.watched.filter((w) => w !== episode);
    if (watched) e.watched.push(episode as string);
    store.saveLibrary(library);
    return e.watched;
  },

  /// Кладёт серию во временный кэш, чтобы смотреть без подгрузок; прогресс — событиями `preload:*`.
  preload_start: async ({ pageUrl, episode, quality, sourceUrl, referer }) => {
    const dest = destPath(pageUrl as string, episode as string, quality as string);
    const id = dest;
    if (cancels.has(id)) return id;

    const ctrl = new AbortController();
    cancels.set(id, ctrl);

    void (async () => {
      try {
        const file = await fetchFile(sourceUrl as string, referer as string, dest, ctrl.signal, (done, total, bytesPerSec) => {
          emit("preload:progress", { id, done, total, bytesPerSec } satisfies Progress);
        });
        cancels.delete(id);
        emit("preload:done", { id, file });
        sweep();
      } catch (e) {
        cancels.delete(id);
        emit("preload:failed", { id, message: msg(e) });
      }
    })();

    return id;
  },

  preload_cancel: async ({ id }) => {
    cancels.get(id as string)?.abort();
    cancels.delete(id as string);
  },

  cache_drop: async ({ path: file }) => {
    const abs = cache.inside(file as string);
    if (abs === null) throw new Error("файл вне кэша");
    await fsp.rm(abs, { force: true });
  },
};

const HOST = process.env.ANIMEJOYA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ANIMEJOYA_PORT ?? 7788);

/// Домены, под которыми сервер виден снаружи (например, через Caddy), через запятую.
const hosts = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "::1",
  ...(process.env.ANIMEJOYA_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

/// Сверяем Host и Origin: иначе сторонняя страница или DNS rebinding дотянутся до API.
function allowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!hosts.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return hosts.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");

function send(res: http.ServerResponse, name: string, body: Buffer): void {
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(name)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  const clean = (urlPath.split("?")[0] ?? "/").replace(/^\/+/, "");
  const key = clean === "" ? "index.html" : clean;

  const embedded = assets[key] ?? assets["index.html"];
  if (embedded !== undefined && Object.keys(assets).length > 0) {
    send(res, assets[key] !== undefined ? key : "index.html", Buffer.from(embedded, "base64"));
    return;
  }

  const file = path.resolve(distDir, key);
  if (!file.startsWith(distDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    send(res, key, await fsp.readFile(file));
  } catch {
    try {
      send(res, "index.html", await fsp.readFile(path.join(distDir, "index.html")));
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("dist не собран — выполните npm run build");
    }
  }
}

function sse(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": ok\n\n");
  clients.add(res);
  const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

async function readBody(req: http.IncomingMessage): Promise<Args> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as Args;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Args;
  } catch {
    return {} as Args;
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, name: string): Promise<void> {
  const fn = handlers[name];
  const reply = (code: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
  };
  if (fn === undefined) {
    reply(404, { ok: false, error: `неизвестная команда ${name}` });
    return;
  }
  try {
    reply(200, { ok: true, data: (await fn(await readBody(req))) ?? null });
  } catch (e) {
    reply(200, { ok: false, error: msg(e) });
  }
}

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
  if (!media.sameSite(req)) {
    res.writeHead(403).end();
    return;
  }
  const u = new URL(raw, "http://local");
  const q = (k: string): string => u.searchParams.get(k) ?? "";
  if (u.pathname === "/media/file") {
    const abs = cache.inside(q("path"));
    if (abs === null) {
      res.writeHead(403).end();
      return;
    }
    cache.touch(abs);
    await media.serveFile(req, res, abs, q("name"));
  } else if (u.pathname === "/media/remote") {
    await media.proxy(req, res, q("url"), q("referer"), q("name"));
  } else {
    res.writeHead(404).end();
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (!allowed(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = req.url ?? "/";
    if (url.startsWith("/media/")) await serveMedia(req, res, url);
    else if (url === "/api/events") sse(req, res);
    else if (url.startsWith("/api/")) await handleApi(req, res, url.slice("/api/".length));
    else await serveStatic(res, url);
  })().catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
});

function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const bin = win ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = win ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

sweep();
setInterval(sweep, 1_800_000).unref();

// В контейнере сервер — PID 1, и без явного обработчика SIGTERM игнорируется.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));

server.listen(PORT, HOST, () => {
  const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/`;
  console.log(`AnimeJoy: ${url}`);
  if (process.env.ANIMEJOYA_NO_OPEN === undefined && !process.argv.includes("--no-open")) openBrowser(url);
});
