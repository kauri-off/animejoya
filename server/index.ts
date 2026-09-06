import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as store from "./store.ts";
import type { Entry, Settings } from "./store.ts";
import * as player from "./player.ts";
import { fetchFile } from "./download.ts";
import type { Progress } from "./download.ts";
import { assets } from "./assets.generated.ts";
import {
  ORIGIN,
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

const destPath = (cfg: Settings, pageUrl: string, epTitle: string, quality: string): string =>
  path.join(store.videoDir(cfg), store.slug(pageUrl), `${store.epTag(epTitle)}-${quality}.mp4`);

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

  const cfg = store.loadSettings();
  const dir = path.join(store.videoDir(cfg), store.slug(url));

  const resolved = await mapLimit(
    episodes.map((e) => e.embed),
    4,
    (embed) => site.resolve(embed),
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
    if (!target.includes("animejoya")) throw new Error("это не ссылка на animejoya.ru");
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

  library_reorder: async ({ urls }) => {
    if (!Array.isArray(urls)) return library;
    const urlList = urls as string[];
    const map = new Map(library.map((e) => [e.url, e]));
    const next: Entry[] = [];
    for (const u of urlList) {
      const e = map.get(u);
      if (e) {
        next.push(e);
        map.delete(u);
      }
    }
    for (const e of map.values()) {
      next.push(e);
    }
    library.length = 0;
    library.push(...next);
    store.saveLibrary(library);
    return library;
  },

  /// Полная карточка тайтла: озвучки, серии, что уже лежит на диске.
  title_open: async ({ url }): Promise<TitleView> => {
    const target = store.normalizeUrl(url as string);
    const html = await page(target);
    const newsId = parseNewsId(html);
    if (newsId === null) throw new Error("на странице нет плейлиста (это точно страница тайтла?)");

    const meta = parseMeta(html);
    const playlist = await site.playlist(newsId, target);

    const cfg = store.loadSettings();
    const dir = path.join(store.videoDir(cfg), store.slug(target));

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

  /// Смотреть сразу с CDN, без сохранения файла.
  stream: async ({ url, title, referer }) => {
    const cfg = store.loadSettings();
    const ref = (referer as string) === "" ? ORIGIN : (referer as string);
    return player.launch(cfg.player, url as string, title as string, ref);
  },

  play_file: async ({ path: file, title }) => {
    const cfg = store.loadSettings();
    return player.launch(cfg.player, file as string, title as string, null);
  },

  /// Ставит серию в загрузку; прогресс приходит событиями `download:*`.
  download_start: async ({ pageUrl, episode, quality, sourceUrl, referer, autoplay }) => {
    const cfg = store.loadSettings();
    const dest = destPath(cfg, pageUrl as string, episode as string, quality as string);
    const id = dest;
    if (cancels.has(id)) return id;

    const ctrl = new AbortController();
    cancels.set(id, ctrl);
    const ref = (referer as string) === "" ? ORIGIN : (referer as string);

    void (async () => {
      try {
        const file = await fetchFile(sourceUrl as string, ref, dest, ctrl.signal, (done, total, bytesPerSec) => {
          emit("download:progress", { id, done, total, bytesPerSec } satisfies Progress);
        });
        cancels.delete(id);
        emit("download:done", { id, file });
        if (autoplay) {
          try {
            await player.launch(cfg.player, file, episode as string, null);
          } catch (e) {
            emit("player:error", msg(e));
          }
        }
      } catch (e) {
        cancels.delete(id);
        emit("download:failed", { id, message: msg(e) });
      }
    })();

    return id;
  },

  download_cancel: async ({ id }) => {
    cancels.get(id as string)?.abort();
    cancels.delete(id as string);
  },

  file_delete: async ({ path: file }) => {
    await fsp.rm(file as string);
  },

  open_dir: async ({ path: dir }) => {
    await fsp.mkdir(dir as string, { recursive: true });
    await player.reveal(dir as string);
  },

  open_url: async (args) => {
    const u = (args as Record<string, unknown>).url;
    if (typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"))) {
      openBrowser(u);
    }
  },
};

const HOST = "127.0.0.1";
const PORT = Number(process.env.ANIMEJOYA_PORT ?? 7788);

/// Сервер слушает только петлю, но этого мало: сторонняя страница в браузере
/// может слать сюда запросы. Поэтому сверяем Host и Origin.
function allowed(req: http.IncomingMessage): boolean {
  const local = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!local.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return local.has(new URL(origin).hostname);
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

const server = http.createServer((req, res) => {
  void (async () => {
    if (!allowed(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = req.url ?? "/";
    if (url === "/api/events") sse(req, res);
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
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`AnimeJoy: ${url}`);
  if (process.env.ANIMEJOYA_NO_OPEN === undefined && !process.argv.includes("--no-open")) openBrowser(url);
});
