import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { Fact } from "./store.ts";

export const SIBNET = "https://video.sibnet.ru";
export const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

export type Source = { quality: string; url: string; referer: string };
export type Episode = { playerId: string; title: string; sources: Source[]; embed: string };
export type Player = { id: string; name: string };
export type Choice = { id: string; path: string[]; resolvable: boolean };
export type Meta = {
  title: string;
  original: string;
  poster: string;
  description: string;
  genres: string[];
  facts: Fact[];
};

export type Kind = "direct" | "allvideo" | "sibnet" | "external";

export function kind(dataFile: string): Kind {
  if (dataFile.includes("playerjs.html")) return "direct";
  if (dataFile.includes("fsst.online")) return "allvideo";
  if (dataFile.includes("sibnet.ru")) return "sibnet";
  return "external";
}

/// `true` — ссылки достаются отдельным запросом, `null` — не умеем вовсе.
function usable(ep: Episode): boolean | null {
  switch (kind(ep.embed)) {
    case "direct":
      return ep.sources.length > 0 ? false : null;
    case "allvideo":
    case "sibnet":
      return true;
    default:
      return null;
  }
}

const absolute = (url: string): string => (url.startsWith("//") ? `https:${url}` : url);

/// У сайта несколько доменов-зеркал — всё строим от того, с которого пришли.
const originOf = (url: string): string => new URL(url).origin;

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
};

/// Минимальная банка кук: сайт один, поэтому хватает пары имя-значение на хост.
class Jar {
  private byHost = new Map<string, Map<string, string>>();

  read(url: string): string {
    const jar = this.byHost.get(new URL(url).hostname);
    if (!jar || jar.size === 0) return "";
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  write(url: string, res: Response): void {
    const set = res.headers.getSetCookie();
    if (set.length === 0) return;
    const host = new URL(url).hostname;
    const jar = this.byHost.get(host) ?? new Map<string, string>();
    for (const line of set) {
      const pair = line.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    this.byHost.set(host, jar);
  }
}

type Init = { method?: string; headers: Record<string, string>; body?: string };

/// Редиректы ведём вручную: иначе куки, выставленные на промежуточном 302
/// (а именно так приходит сессия после логина), до нас не доедут.
async function hop(start: string, init: Init, jar: Jar, timeoutMs: number): Promise<Response> {
  let url = start;
  let opts = { ...init };
  for (let n = 0; n < 10; n++) {
    const cookie = jar.read(url);
    const headers = { ...BASE_HEADERS, ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) };
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar.write(url, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url).toString();
      await res.body?.cancel();
      if (res.status === 303 || (opts.method === "POST" && res.status !== 307 && res.status !== 308)) {
        opts = { headers: opts.headers };
      }
      url = next;
      continue;
    }
    return res;
  }
  throw new Error("слишком много редиректов");
}

export class Site {
  private jar = new Jar();

  /// GET страницы «как из браузера».
  async getPage(url: string): Promise<string> {
    let res: Response;
    try {
      res = await hop(
        url,
        {
          headers: {
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
          },
        },
        this.jar,
        60_000,
      );
    } catch (e) {
      throw new Error(`не удалось открыть ${url}: ${e instanceof Error ? e.message : e}`);
    }
    // Страница без прав доступа отдаётся с кодом 403, но с нужным HTML.
    return res.text();
  }

  async login(user: string, pass: string, referer: string): Promise<void> {
    const form = new URLSearchParams({
      login_name: user,
      login_password: pass,
      login_not_save: "0",
      login: "submit",
    });
    let res: Response;
    try {
      res = await hop(
        referer,
        {
          method: "POST",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: originOf(referer),
            Referer: referer,
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
          },
          body: form.toString(),
        },
        this.jar,
        60_000,
      );
    } catch (e) {
      throw new Error(`запрос авторизации не прошёл: ${e instanceof Error ? e.message : e}`);
    }
    const body = await res.text();
    if (body.includes('name="login_name"')) {
      throw new Error("не удалось войти — проверьте логин и пароль");
    }
  }

  /// Страница чужого плеера — берём её так, как её брал бы iframe на сайте.
  private async embedPage(url: string, from: string): Promise<string> {
    let res: Response;
    try {
      res = await hop(
        url,
        {
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: `${from}/`,
            "Sec-Fetch-Dest": "iframe",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
          },
        },
        this.jar,
        60_000,
      );
    } catch (e) {
      throw new Error(`не удалось открыть плеер ${url}: ${e instanceof Error ? e.message : e}`);
    }
    return res.text();
  }

  /// Прямые ссылки для одной серии внешнего плеера.
  async resolve(embed: string, from: string): Promise<Source[]> {
    const url = absolute(embed);
    switch (kind(embed)) {
      case "direct":
        return parseSources(embed);
      case "allvideo":
        return this.allvideo(url, from);
      case "sibnet":
        return this.sibnet(url, from);
      default:
        throw new Error(`плеер ${url} не поддерживается`);
    }
  }

  /// Формат `[качество]ссылка` у fsst.online тот же, что и у своего плеера сайта.
  /// Referer оставляем пустым: CDN за ссылкой пускает только свой домен.
  private async allvideo(url: string, from: string): Promise<Source[]> {
    const html = await this.embedPage(url, from);
    const list = playerjsFile(html);
    const out = list ? parseQualityList(list) : [];
    if (out.length === 0) throw new Error("AllVideo не отдал ссылок на видео");
    return out;
  }

  /// Sibnet прячет видео за редиректом, который без своего Referer даёт 403.
  /// Ссылку `/v/..` не разворачиваем: она вечная, а вот CDN за ней — на пару часов.
  private async sibnet(url: string, from: string): Promise<Source[]> {
    const html = await this.embedPage(url, from);
    const p = sibnetPath(html);
    if (!p) throw new Error("Sibnet не отдал ссылки на видео");
    return [
      {
        quality: "sibnet",
        url: p.startsWith("http") ? p : `${SIBNET}${p}`,
        referer: `${SIBNET}/`,
      },
    ];
  }

  /// Плейлист приходит отдельным ajax-запросом, в HTML страницы его нет.
  async playlist(newsId: string, referer: string): Promise<Playlist> {
    const url = `${originOf(referer)}/engine/ajax/playlists.php?news_id=${newsId}&xfield=playlist`;
    let res: Response;
    try {
      res = await hop(
        url,
        {
          headers: {
            Accept: "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            Referer: referer,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
          },
        },
        this.jar,
        60_000,
      );
    } catch (e) {
      throw new Error(`не удалось получить плейлист: ${e instanceof Error ? e.message : e}`);
    }
    let json: { success?: boolean; response?: string };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new Error("плейлист вернулся не в JSON");
    }
    if (json.success !== true) throw new Error("сайт не отдал плейлист (нет доступа к этой странице?)");
    if (typeof json.response !== "string") throw new Error("в ответе нет поля response");
    return parsePlaylist(json.response);
  }
}

export class Playlist {
  constructor(
    readonly players: Player[],
    readonly episodes: Episode[],
  ) {}

  /// data-id иерархичен: `0_0` — озвучка, `0_0_1` — плеер внутри неё,
  /// а у долгих тайтлов есть ещё `0_0_1_3` — диапазон серий.
  playerPath(id: string): string[] {
    const parts = id.split("_");
    const chain: string[] = [];
    for (let n = 1; n <= parts.length; n++) {
      const label = this.label(parts.slice(0, n).join("_"));
      if (label !== null) chain.push(label);
    }
    return chain.length > 0 ? chain : [id];
  }

  private label(id: string): string | null {
    return this.players.find((p) => p.id === id)?.name ?? null;
  }

  /// Плееры, из которых достаём прямые ссылки. Флаг — нужен ли для этого
  /// отдельный запрос к чужому сайту (AllVideo, Sibnet).
  playable(): Choice[] {
    const out: Choice[] = [];
    for (const ep of this.episodes) {
      const resolvable = usable(ep);
      if (resolvable === null) continue;
      if (out.some((c) => c.id === ep.playerId)) continue;
      out.push({ id: ep.playerId, path: this.playerPath(ep.playerId), resolvable });
    }
    return out;
  }

  externalNames(): string[] {
    const out: string[] = [];
    for (const ep of this.episodes) {
      if (usable(ep) !== null) continue;
      // Название плеера — второй уровень: [озвучка, плеер, диапазон серий].
      const path = this.playerPath(ep.playerId);
      const name = path[1] ?? path[path.length - 1];
      if (name === undefined) continue;
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  episodesOf(playerId: string): Episode[] {
    return this.episodes.filter((e) => e.playerId === playerId);
  }
}

type Api = cheerio.CheerioAPI;

const textOf = ($: Api, el: AnyNode): string => $(el).text().split(/\s+/).filter(Boolean).join(" ");

export function parsePlaylist(html: string): Playlist {
  const $ = cheerio.load(html, null, false);

  const players: Player[] = [];
  $(".playlists-lists li[data-id]").each((_, el) => {
    const id = $(el).attr("data-id");
    if (id !== undefined) players.push({ id, name: textOf($, el) });
  });

  const episodes: Episode[] = [];
  $(".playlists-videos li[data-file]").each((_, el) => {
    const file = $(el).attr("data-file");
    if (file === undefined) return;
    episodes.push({
      playerId: $(el).attr("data-id") ?? "?",
      title: textOf($, el),
      sources: parseSources(file),
      embed: file,
    });
  });

  return new Playlist(players, episodes);
}

/// `//animejoya.ru/player/playerjs.html?file=[1080p]https://..a.mp4,[720p]https://..b.mp4&skip=..`
export function parseSources(dataFile: string): Source[] {
  if (!dataFile.includes("playerjs.html")) return [];
  const q = dataFile.indexOf("?");
  if (q < 0) return [];
  // `skip` встречается и до, и после `file`, поэтому режем по границе параметра.
  for (const pair of dataFile.slice(q + 1).split("&")) {
    if (!pair.startsWith("file=")) continue;
    const raw = pair.slice("file=".length);
    let list: string;
    try {
      list = decodeURIComponent(raw);
    } catch {
      list = raw;
    }
    return parseQualityList(list);
  }
  return [];
}

/// `[1080p]https://a.mp4,[720p]https://b.mp4` — общий формат PlayerJS.
export function parseQualityList(list: string): Source[] {
  // Границы записей — `[` в начале строки или сразу после запятой.
  const marks: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "[" && (i === 0 || list[i - 1] === ",")) marks.push(i);
  }

  if (marks.length === 0) {
    const url = list.trim();
    return url.startsWith("http") ? [{ quality: "video", url, referer: "" }] : [];
  }

  const out: Source[] = [];
  for (let n = 0; n < marks.length; n++) {
    const start = marks[n]!;
    const end = n + 1 < marks.length ? marks[n + 1]! - 1 : list.length;
    const entry = list.slice(start, end);
    const close = entry.indexOf("]");
    if (close < 0) continue;
    const url = entry.slice(close + 1).trim();
    if (url.startsWith("http")) out.push({ quality: entry.slice(1, close), url, referer: "" });
  }
  return out;
}

/// Значение JS-строки следом за `key`: `file:"..."`, `src: '...'`.
/// Возвращает ещё и позицию за ней, чтобы можно было искать дальше.
function jsStringAfter(hay: string, key: string, from: number): [string, number] | null {
  const found = hay.indexOf(key, from);
  if (found < 0) return null;
  const at = found + key.length;
  const rest = hay.slice(at);
  const open = rest.search(/["']/);
  if (open < 0) return null;
  const quote = rest[open]!;
  const start = open + 1;
  const end = rest.indexOf(quote, start);
  if (end < 0) return null;
  return [rest.slice(start, end), at + end];
}

/// Первый `file:` в конфиге PlayerJS, похожий на список ссылок.
function playerjsFile(html: string): string | null {
  let at = 0;
  for (;;) {
    const hit = jsStringAfter(html, "file:", at);
    if (hit === null) return null;
    const [value, next] = hit;
    if (value.startsWith("[") || value.startsWith("http")) return value;
    at = next;
  }
}

/// `player.src([{src: "/v/<hash>/<id>.mp4", type: "video/mp4"},]);`
function sibnetPath(html: string): string | null {
  const at = html.indexOf("player.src(");
  if (at < 0) return null;
  const hit = jsStringAfter(html, "src", at);
  if (hit === null) return null;
  const [value] = hit;
  return value.includes(".mp4") || value.includes(".m3u8") ? value : null;
}

/// news_id нужен для ajax-запроса плейлиста.
export function parseNewsId(html: string): string | null {
  const i = html.indexOf("data-news_id=");
  if (i < 0) return null;
  const rest = html.slice(i + "data-news_id=".length).replace(/^["']+/, "");
  const id = /^[0-9]+/.exec(rest);
  return id ? id[0] : null;
}

export function parseMeta(html: string): Meta {
  const $ = cheerio.load(html);
  const one = (css: string): string | null => {
    const el = $(css).first();
    return el.length > 0 ? textOf($, el[0]!) : null;
  };
  const attr = (css: string, name: string): string | null => $(css).first().attr(name) ?? null;

  const facts: Fact[] = [];
  let genres: string[] = [];
  $(".blkdesc p").each((_, p) => {
    const lab = $(p).find(".timpact").first();
    if (lab.length === 0) return;
    const labText = textOf($, lab[0]!);
    const key = labText.replace(/:+$/, "");
    const full = textOf($, p);
    const value = (full.startsWith(labText) ? full.slice(labText.length) : full).trim();
    if (key.toLowerCase() === "жанр") {
      genres = $(p)
        .find("a")
        .map((_, a) => textOf($, a))
        .get();
    }
    if (value) facts.push({ key, value });
  });

  const described = one("[itemprop=description]");
  return {
    title: one("h1") ?? "Без названия",
    original: one("h2.romanji") ?? "",
    poster: attr('meta[property="og:image"]', "content") ?? "",
    description:
      (described !== null ? described.replace(/^(Описание:)+/, "").trim() : null) ??
      attr('meta[property="og:description"]', "content") ??
      "",
    genres,
    facts,
  };
}

/// У гостя страница отдаётся без news_id; на зеркалах без входа он есть сразу.
export function isAuthorized(html: string): boolean {
  return parseNewsId(html) !== null;
}
