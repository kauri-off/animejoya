import { UA } from "./site.ts";

/// `<video>` с чужой страницы тоже дойдёт сюда, поэтому пускаем только свои запросы.
export function sameSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (m === null) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  const start = a === "" ? Math.max(0, size - Number(b)) : Number(a);
  const end = a === "" || b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return start <= end ? [start, end] : null;
}

/// С `name` браузер сохраняет файл своим менеджером загрузок, а не играет его.
function attachment(name: string): Record<string, string> {
  if (name === "") return {};
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return {
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf}`,
  };
}

/// Отдаёт серию из кэша через sendfile; путь уже проверен вызывающим.
export async function serveFile(req: Request, abs: string, name: string): Promise<Response> {
  const file = Bun.file(abs);
  if (!(await file.exists())) return new Response(null, { status: 404 });
  const size = file.size;

  const head: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    ...attachment(name),
  };
  const header = req.headers.get("range");
  const range = header === null ? null : parseRange(header, size);
  if (header !== null && range === null) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const [start, end] = range ?? [0, size - 1];
  if (range !== null) head["Content-Range"] = `bytes ${start}-${end}/${size}`;
  // На HEAD Bun сам отбросит тело, оставив Content-Length.
  return new Response(file.slice(start, end + 1), { status: range ? 206 : 200, headers: head });
}

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/// Поток с CDN через себя: браузер не умеет подставить нужный Referer, а мы умеем.
export async function proxy(req: Request, url: string, referer: string, name: string): Promise<Response> {
  if (!/^https?:\/\//.test(url)) return new Response(null, { status: 400 });

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
  };
  if (referer !== "") headers.Referer = referer;
  const range = req.headers.get("range");
  if (range !== null) headers.Range = range;

  let up: Response;
  try {
    up = await fetch(url, { headers, signal: req.signal });
  } catch {
    return new Response(null, { status: 502 });
  }

  const out: Record<string, string> = { "Cache-Control": "no-store", ...(up.ok ? attachment(name) : {}) };
  for (const h of PASS) {
    const v = up.headers.get(h);
    if (v !== null) out[h] = v;
  }
  if (up.ok && !out["content-type"]?.startsWith("video/")) out["content-type"] = "video/mp4";

  if (req.method === "HEAD") {
    await up.body?.cancel();
    return new Response(null, { status: up.status, headers: out });
  }
  return new Response(up.body, { status: up.status, headers: out });
}
