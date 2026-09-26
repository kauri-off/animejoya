import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import pLimit from "p-limit";
import { z } from "zod";

import * as store from "./store.ts";
import * as cache from "./cache.ts";
import * as media from "./media.ts";
import { emit, events } from "./events.ts";
import { fetchFile } from "./download.ts";
import { serveStatic } from "./static.ts";
import { Playlist, Site, isAuthorized, parseMeta, parseNewsId } from "./site.ts";
import type { Episode as RawEpisode, Meta } from "./site.ts";
import { Entry, Settings, msg } from "./schema.ts";
import type { CacheInfo, CacheTitle, Episode, Player, Title } from "./schema.ts";

type Job = { ctrl: AbortController; task: Promise<void> };

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
const fetchedAt = new Map<string, number>();
const FRESH_MS = 5 * 60_000;
let syncing = false;

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

/// news_id совпадает с id в адресе — плейлист просим сразу, не дожидаясь страницы.
async function fetchTitle(url: string): Promise<{ html: string; playlist: Playlist }> {
  const guess = /\/(\d+)-[^/]*\.html?$/.exec(new URL(url).pathname)?.[1];
  const early = guess === undefined ? null : site.playlist(guess, url).catch(() => null);
  const html = await page(url);
  const newsId = parseNewsId(html);
  if (newsId === null) throw new Error("на странице нет плейлиста (это точно страница тайтла?)");
  const playlist = (newsId === guess ? await early : null) ?? (await site.playlist(newsId, url));
  return { html, playlist };
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
function upsert(url: string, meta: Meta, total = 0): Entry {
  let entry = library.find((e) => e.url === url);
  if (entry === undefined) {
    entry = store.blank(url);
    merge(entry, meta);
    library.unshift(entry);
  } else {
    merge(entry, meta);
  }
  if (total > 0) entry.total = total;
  store.saveLibrary(library);
  return { ...entry };
}

const totalOf = (playlist: Playlist): number =>
  new Set(playlist.playable().flatMap((c) => playlist.episodesOf(c.id).map((e) => store.epTag(e.title)))).size;

/// Тянет страницу и плейлист заново; `add` — завести запись, если её нет в библиотеке.
async function refresh(url: string, add: boolean): Promise<Entry | null> {
  const fresh = await fetchTitle(url);
  playlists.set(url, fresh.playlist);
  fetchedAt.set(url, Date.now());
  if (!add && !library.some((e) => e.url === url)) return null;
  return upsert(url, parseMeta(fresh.html), totalOf(fresh.playlist));
}

function episodeView(e: RawEpisode, dir: string): Episode {
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

export const sweep = async (): Promise<void> => {
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

function cacheView(items: cache.Item[]): CacheInfo {
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

/// Догружает ссылки AllVideo/Sibnet: там на каждую серию своя страница
/// плеера, поэтому дёргаем это только когда озвучку действительно выбрали.
async function resolvePlayer(url: string, playerId: string): Promise<Episode[]> {
  const playlist = playlists.get(url);
  if (playlist === undefined) throw new Error("тайтл не открыт");
  const episodes = playlist.episodesOf(playerId);
  if (episodes.length === 0) throw new Error("у этой озвучки нет серий");

  const dir = cache.dirOf(store.slug(url));
  const from = new URL(url).origin;
  // Не больше четырёх запросов разом, чтобы не ловить лимиты чужого сайта.
  const limit = pLimit(4);
  const resolved = await Promise.allSettled(episodes.map((e) => limit(() => site.resolve(e.embed, from))));

  let last: unknown = null;
  const out = episodes.map((e, i) => {
    const r = resolved[i]!;
    if (r.status === "rejected") last = r.reason;
    return episodeView(r.status === "fulfilled" ? { ...e, sources: r.value } : e, dir);
  });

  if (out.every((e) => e.sources.length === 0)) {
    throw last ?? new Error("плеер не отдал ссылок");
  }
  return out;
}

/// Обновляет записи без обложек, а с `force` — всю библиотеку; итог приходит событием `library:synced`.
async function syncLibrary(force: boolean): Promise<void> {
  if (syncing) return;
  const todo = library.filter((e) => force || e.poster === "").map((e) => e.url);
  if (todo.length === 0) return;
  syncing = true;
  let left = todo.length;
  emit("library:syncing", left);
  const run = async (url: string): Promise<void> => {
    try {
      const entry = await refresh(url, false);
      if (entry !== null) emit("library:entry", entry);
    } finally {
      emit("library:syncing", --left);
    }
  };
  // Первый тайтл отдельно, чтобы вход на сайт случился один раз, а не в каждом потоке.
  const [first, ...rest] = todo;
  const limit = pLimit(3);
  const results = [
    ...(await Promise.allSettled([run(first!)])),
    ...(await Promise.allSettled(rest.map((url) => limit(() => run(url))))),
  ];
  syncing = false;
  emit("library:synced", { total: todo.length, failed: results.filter((r) => r.status === "rejected").length });
}

/// Полная карточка тайтла: озвучки, серии, что уже лежит в кэше.
async function openTitle(url: string): Promise<Title> {
  const target = store.normalizeUrl(url);
  let playlist = playlists.get(target);
  let entry = library.find((e) => e.url === target);
  if (playlist === undefined || entry === undefined || Date.now() - (fetchedAt.get(target) ?? 0) > FRESH_MS) {
    entry = (await refresh(target, true))!;
    playlist = playlists.get(target)!;
  } else {
    entry = { ...entry };
  }

  const dir = cache.dirOf(store.slug(target));
  const players: Player[] = playlist.playable().map((c) => ({
    id: c.id,
    path: c.path,
    resolvable: c.resolvable,
    episodes: playlist.episodesOf(c.id).map((e) => episodeView(e, dir)),
  }));
  return { entry, players, external: playlist.externalNames(), dir };
}

/// Кладёт серию во временный кэш, чтобы смотреть без подгрузок; прогресс — событиями `preload:*`.
function preload(a: { pageUrl: string; episode: string; quality: string; sourceUrl: string; referer: string }): string {
  const id = destPath(a.pageUrl, a.episode, a.quality);
  if (jobs.has(id)) return id;

  const ctrl = new AbortController();
  const task = (async () => {
    try {
      const file = await fetchFile(a.sourceUrl, a.referer, id, ctrl.signal, (done, total, bytesPerSec) => {
        emit("preload:progress", { id, done, total, bytesPerSec });
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
}

/// Ошибку валидации бросаем, а не возвращаем: иначе она попадёт в типы ответа у клиента.
const valid = <T extends z.ZodType, Target extends "json" | "query">(target: Target, schema: T) =>
  zValidator(target, schema, (r) => {
    if (!r.success) throw new HTTPException(400, { message: `неверный запрос: ${z.prettifyError(r.error)}` });
  });

const Url = z.object({ url: z.string() });

const api = new Hono()
  .get("/settings", (c) => c.json(store.loadSettings()))
  .put("/settings", valid("json", Settings), (c) => {
    store.saveSettings(c.req.valid("json"));
    return c.json(null);
  })

  .get("/library", (c) => c.json(library))
  /// Добавляет ссылку и сразу подтягивает обложку с описанием.
  .post("/library/add", valid("json", Url), async (c) => {
    const target = store.normalizeUrl(c.req.valid("json").url);
    if (!isTitleUrl(target)) throw new HTTPException(400, { message: "это не ссылка на страницу тайтла" });
    return c.json(upsert(target, parseMeta(await page(target))));
  })
  .post("/library/sync", valid("json", z.object({ force: z.boolean() })), (c) => {
    void syncLibrary(c.req.valid("json").force);
    return c.json(null);
  })
  .post("/library/restore", valid("json", z.object({ entry: Entry, index: z.number().int() })), (c) => {
    const { entry, index } = c.req.valid("json");
    if (!library.some((x) => x.url === entry.url)) {
      library.splice(Math.max(0, Math.min(index, library.length)), 0, entry);
      store.saveLibrary(library);
    }
    return c.json(library);
  })
  .post("/library/remove", valid("json", Url), (c) => {
    const { url } = c.req.valid("json");
    const i = library.findIndex((e) => e.url === url);
    if (i >= 0) library.splice(i, 1);
    store.saveLibrary(library);
    return c.json(null);
  })
  /// Порядок задаёт клиент; неизвестные ссылки игнорируем, непришедшие оставляем в хвосте.
  .post("/library/reorder", valid("json", z.object({ urls: z.array(z.string()) })), (c) => {
    const rest = new Map(library.map((e) => [e.url, e]));
    const next: Entry[] = [];
    for (const url of c.req.valid("json").urls) {
      const e = rest.get(url);
      if (e) {
        next.push(e);
        rest.delete(url);
      }
    }
    next.push(...rest.values());
    store.saveLibrary(next);
    library.splice(0, library.length, ...next);
    return c.json(library);
  })

  .get("/title", valid("query", Url), async (c) => c.json(await openTitle(c.req.valid("query").url)))
  .post("/title/resolve", valid("json", z.object({ url: z.string(), playerId: z.string() })), async (c) => {
    const { url, playerId } = c.req.valid("json");
    return c.json(await resolvePlayer(store.normalizeUrl(url), playerId));
  })
  /// Запоминает последнюю озвучку/качество, чтобы не спрашивать их каждый раз.
  .post(
    "/title/remember",
    valid("json", z.object({ url: z.string(), player: z.string().optional(), quality: z.string().optional() })),
    (c) => {
      const { url, player, quality } = c.req.valid("json");
      const e = library.find((x) => x.url === url);
      if (e !== undefined) {
        if (player !== undefined) e.lastPlayer = player;
        if (quality !== undefined) e.lastQuality = quality;
        store.saveLibrary(library);
      }
      return c.json(null);
    },
  )
  .post(
    "/title/watched",
    valid("json", z.object({ url: z.string(), episodes: z.array(z.string()), watched: z.boolean() })),
    (c) => {
      const { url, episodes, watched } = c.req.valid("json");
      const e = library.find((x) => x.url === url);
      if (e === undefined) return c.json([] as string[]);
      const list = new Set(episodes);
      e.watched = e.watched.filter((w) => !list.has(w));
      if (watched) e.watched.push(...list);
      store.saveLibrary(library);
      return c.json(e.watched);
    },
  )

  .post(
    "/preload",
    valid(
      "json",
      z.object({
        pageUrl: z.string(),
        episode: z.string(),
        quality: z.string(),
        sourceUrl: z.string(),
        referer: z.string(),
      }),
    ),
    (c) => c.json(preload(c.req.valid("json"))),
  )
  .post("/preload/cancel", valid("json", z.object({ id: z.string() })), (c) => {
    const { id } = c.req.valid("json");
    jobs.get(id)?.ctrl.abort();
    jobs.delete(id);
    return c.json(null);
  })

  .get("/cache", async (c) => c.json(cacheView(await cache.list())))
  .post("/cache/sweep", async (c) => {
    await sweep();
    return c.json(cacheView(await cache.list()));
  })
  /// Серию удаляем вместе с недокачанным огрызком.
  .post("/cache/drop", valid("json", z.object({ path: z.string() })), async (c) => {
    const abs = cache.inside(c.req.valid("json").path.replace(/\.part$/, ""));
    if (abs === null) throw new HTTPException(400, { message: "файл вне кэша" });
    await stop((dest) => dest === abs);
    await fsp.rm(abs, { force: true });
    await fsp.rm(`${abs}.part`, { force: true });
    await cache.prune();
    dropped([abs]);
    return c.json(null);
  })
  .post("/cache/drop-title", valid("json", z.object({ slug: z.string() })), async (c) => {
    const dir = cache.titleDir(c.req.valid("json").slug);
    if (dir === null) throw new HTTPException(400, { message: "папка вне кэша" });
    await stop((dest) => dest.startsWith(dir + path.sep));
    const files = (await cache.list(dir)).map((it) => it.file);
    await fsp.rm(dir, { recursive: true, force: true });
    dropped(files);
    return c.json(null);
  })
  .post("/cache/clear", async (c) => {
    await stop(() => true);
    const files = (await cache.list()).map((it) => it.file);
    const names = await fsp.readdir(cache.root).catch(() => [] as string[]);
    await Promise.all(names.map((n) => fsp.rm(path.join(cache.root, n), { recursive: true, force: true })));
    dropped(files);
    return c.json(null);
  })

  .get("/events", events);

const Name = z.string().default("");

/// `<video>` с чужой страницы тоже дойдёт сюда, поэтому пускаем только свои запросы.
const mediaRoutes = new Hono()
  .use(async (c, next) => {
    if (!media.sameSite(c.req.raw)) return c.body(null, 403);
    await next();
  })
  .get("/file", valid("query", z.object({ path: z.string(), name: Name })), (c) => {
    const q = c.req.valid("query");
    const abs = cache.inside(q.path);
    if (abs === null) return c.body(null, 403);
    cache.touch(abs);
    return media.serveFile(c.req.raw, abs, q.name);
  })
  .get("/remote", valid("query", z.object({ url: z.string(), referer: z.string(), name: Name })), (c) => {
    const q = c.req.valid("query");
    return media.proxy(c.req.raw, q.url, q.referer, q.name);
  });

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

const guard = createMiddleware(async (c, next) => {
  if (!allowed(c.req.raw)) return c.body(null, 403);
  await next();
});

export const app = new Hono()
  .use(guard)
  .route("/api", api)
  .route("/media", mediaRoutes)
  .get("*", (c) => serveStatic(c.req.path));

app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  return c.json({ error: msg(e) }, 500);
});

export type AppType = typeof app;
