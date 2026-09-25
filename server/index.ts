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
type CacheFile = { path: string; tag: string; quality: string; size: number; mtime: number; partial: boolean; busy: boolean };
type CacheTitle = { slug: string; url: string | null; title: string; poster: string; size: number; files: CacheFile[] };
type CacheView = { root: string; ttl: number; limit: number; size: number; titles: CacheTitle[] };
type Job = { ctrl: AbortController; task: Promise<void> };

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
const jobs = new Map<string, Job>();
const playlists = new Map<string, Playlist>();

const clients = new Set<ReadableStreamDefaultController<string>>();

function emit(event: string, payload: unknown): void {
  const line = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const c of clients) c.enqueue(line);
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

const dropped = (files: string[]): void => {
  const list = [...new Set(files.map((f) => f.replace(/\.part$/, "")))];
  if (list.length > 0) emit("cache:dropped", list);
};

const sweep = async (): Promise<void> => {
  try {
    dropped(await cache.sweep(new Set(jobs.keys())));
  } catch {}
};

/// Удаление важнее докачки: гасим загрузку и ждём, пока она отпустит файл.
async function stop(match: (dest: string) => boolean): Promise<void> {
  const hit = [...jobs].filter(([dest]) => match(dest)).map(([, j]) => j);
  for (const j of hit) j.ctrl.abort();
  await Promise.all(hit.map((j) => j.task));
}

function cacheView(items: cache.Item[]): CacheView {
  const bySlug = new Map(library.map((e) => [store.slug(e.url), e]));
  const groups = new Map<string, CacheTitle>();
  for (const it of items) {
    const slug = path.relative(cache.root, path.dirname(it.file));
    const name = path.basename(it.file);
    const m = /^(.*)-([^-]*)\.mp4(\.part)?$/.exec(name);
    const partial = name.endsWith(".part");
    let g = groups.get(slug);
    if (g === undefined) {
      const e = bySlug.get(slug);
      g = { slug, url: e?.url ?? null, title: e?.title || slug, poster: e?.poster ?? "", size: 0, files: [] };
      groups.set(slug, g);
    }
    g.size += it.size;
    g.files.push({
      path: it.file,
      tag: m?.[1] ?? name,
      quality: m?.[2] ?? "",
      size: it.size,
      mtime: it.mtime,
      partial,
      busy: jobs.has(it.file.replace(/\.part$/, "")),
    });
  }
  const latest = (g: CacheTitle) => Math.max(...g.files.map((f) => f.mtime));
  const titles = [...groups.values()].sort((a, b) => latest(b) - latest(a));
  for (const g of titles) g.files.sort((a, b) => a.tag.localeCompare(b.tag, "ru", { numeric: true }));
  return {
    root: cache.root,
    ttl: cache.TTL,
    limit: cache.LIMIT,
    size: titles.reduce((s, g) => s + g.size, 0),
    titles,
  };
}

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

  library_restore: async ({ entry, index }) => {
    const e = entry as Entry;
    if (typeof e?.url !== "string" || library.some((x) => x.url === e.url)) return library;
    library.splice(Math.max(0, Math.min(Number(index) || 0, library.length)), 0, store.pickEntry(e));
    store.saveLibrary(library);
    return library;
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
    const entry = upsert(target, meta);
    const tags = new Set(players.flatMap((p) => p.episodes.map((e) => e.tag)));
    const stored = library.find((e) => e.url === target);
    if (stored !== undefined && tags.size > 0 && stored.total !== tags.size) {
      stored.total = entry.total = tags.size;
      store.saveLibrary(library);
    }
    return { entry, players, external, dir };
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

  mark_watched: async ({ url, episode, episodes, watched }) => {
    const e = library.find((x) => x.url === url);
    if (e === undefined) return [];
    const list = new Set<string>(Array.isArray(episodes) ? episodes : [episode]);
    e.watched = e.watched.filter((w) => !list.has(w));
    if (watched) e.watched.push(...list);
    store.saveLibrary(library);
    return e.watched;
  },

  /// Кладёт серию во временный кэш, чтобы смотреть без подгрузок; прогресс — событиями `preload:*`.
  preload_start: async ({ pageUrl, episode, quality, sourceUrl, referer }) => {
    const dest = destPath(pageUrl as string, episode as string, quality as string);
    const id = dest;
    if (jobs.has(id)) return id;

    const ctrl = new AbortController();
    const task = (async () => {
      try {
        const file = await fetchFile(sourceUrl as string, referer as string, dest, ctrl.signal, (done, total, bytesPerSec) => {
          emit("preload:progress", { id, done, total, bytesPerSec } satisfies Progress);
        });
        jobs.delete(id);
        emit("preload:done", { id, file });
        void sweep();
      } catch (e) {
        jobs.delete(id);
        emit("preload:failed", { id, message: msg(e) });
      }
    })();
    jobs.set(id, { ctrl, task });

    return id;
  },

  preload_cancel: async ({ id }) => {
    jobs.get(id as string)?.ctrl.abort();
    jobs.delete(id as string);
  },

  cache_list: async () => cacheView(await cache.list()),

  /// Серию удаляем вместе с недокачанным огрызком.
  cache_drop: async ({ path: file }) => {
    const abs = cache.inside(String(file).replace(/\.part$/, ""));
    if (abs === null) throw new Error("файл вне кэша");
    await stop((dest) => dest === abs);
    await fsp.rm(abs, { force: true });
    await fsp.rm(`${abs}.part`, { force: true });
    await cache.prune();
    dropped([abs]);
  },

  cache_drop_title: async ({ slug }) => {
    const dir = cache.titleDir(String(slug));
    if (dir === null) throw new Error("папка вне кэша");
    await stop((dest) => dest.startsWith(dir + path.sep));
    const files = (await cache.list(dir)).map((it) => it.file);
    await fsp.rm(dir, { recursive: true, force: true });
    dropped(files);
  },

  cache_clear: async () => {
    await stop(() => true);
    const files = (await cache.list()).map((it) => it.file);
    const names = await fsp.readdir(cache.root).catch(() => [] as string[]);
    await Promise.all(names.map((n) => fsp.rm(path.join(cache.root, n), { recursive: true, force: true })));
    dropped(files);
  },

  cache_sweep: async () => {
    await sweep();
    return cacheView(await cache.list());
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
function allowed(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!hosts.has(host)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
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

function send(name: string, body: Uint8Array<ArrayBuffer> | Blob): Response {
  return new Response(body, {
    headers: {
      "Content-Type": MIME[path.extname(name)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

/// base64 раскодируем один раз, а не на каждый запрос.
const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
const embedded = (key: string): Uint8Array<ArrayBuffer> => {
  let buf = decoded.get(key);
  if (buf === undefined) {
    buf = Buffer.from(assets[key]!, "base64");
    decoded.set(key, buf);
  }
  return buf;
};

async function serveStatic(urlPath: string): Promise<Response> {
  const clean = urlPath.replace(/^\/+/, "");
  const key = clean === "" ? "index.html" : clean;

  if (Object.keys(assets).length > 0) {
    const name = assets[key] !== undefined ? key : "index.html";
    return send(name, embedded(name));
  }

  const file = path.resolve(distDir, key);
  if (!file.startsWith(distDir)) return new Response(null, { status: 403 });
  if (await Bun.file(file).exists()) return send(key, Bun.file(file));
  const index = Bun.file(path.join(distDir, "index.html"));
  if (await index.exists()) return send("index.html", index);
  return new Response("dist не собран — выполните npm run build", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function sse(req: Request): Response {
  let ctrl: ReadableStreamDefaultController<string>;
  let beat: ReturnType<typeof setInterval>;
  const drop = (): void => {
    clearInterval(beat);
    clients.delete(ctrl);
  };
  const body = new ReadableStream<string>({
    start(c) {
      ctrl = c;
      c.enqueue(": ok\n\n");
      clients.add(c);
      beat = setInterval(() => c.enqueue(": beat\n\n"), 25_000);
    },
    cancel: drop,
  });
  req.signal.addEventListener("abort", drop);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

async function readBody(req: Request): Promise<Args> {
  try {
    return ((await req.json()) ?? {}) as Args;
  } catch {
    return {} as Args;
  }
}

async function handleApi(req: Request, name: string): Promise<Response> {
  const fn = handlers[name];
  if (fn === undefined) return Response.json({ ok: false, error: `неизвестная команда ${name}` }, { status: 404 });
  try {
    return Response.json({ ok: true, data: (await fn(await readBody(req))) ?? null });
  } catch (e) {
    return Response.json({ ok: false, error: msg(e) });
  }
}

async function serveMedia(req: Request, u: URL): Promise<Response> {
  if (!media.sameSite(req)) return new Response(null, { status: 403 });
  const q = (k: string): string => u.searchParams.get(k) ?? "";
  if (u.pathname === "/media/file") {
    const abs = cache.inside(q("path"));
    if (abs === null) return new Response(null, { status: 403 });
    cache.touch(abs);
    return media.serveFile(req, abs, q("name"));
  }
  if (u.pathname === "/media/remote") return media.proxy(req, q("url"), q("referer"), q("name"));
  return new Response(null, { status: 404 });
}

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

void sweep();
setInterval(sweep, 1_800_000).unref();

// В контейнере сервер — PID 1, и без явного обработчика SIGTERM игнорируется.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));

// sendfile для кэша и прямая передача потока с CDN — node:http на слабом CPU упирался в 100%.
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  async fetch(req, srv) {
    if (!allowed(req)) return new Response(null, { status: 403 });
    const u = new URL(req.url);
    if (u.pathname.startsWith("/media/") || u.pathname === "/api/events") {
      // Плеер на паузе и SSE подолгу молчат — не рвём их по простою.
      srv.timeout(req, 0);
      return u.pathname === "/api/events" ? sse(req) : serveMedia(req, u);
    }
    if (u.pathname.startsWith("/api/")) return handleApi(req, u.pathname.slice("/api/".length));
    return serveStatic(u.pathname);
  },
  error: () => new Response(null, { status: 500 }),
});

const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${server.port}/`;
console.log(`AnimeJoy: ${url}`);
if (process.env.ANIMEJOYA_NO_OPEN === undefined && !process.argv.includes("--no-open")) openBrowser(url);
