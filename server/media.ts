import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UA } from "./site.ts";

/// `<video>` с чужой страницы тоже дойдёт сюда, поэтому пускаем только свои запросы.
export function sameSite(req: http.IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function parseRange(header: string | undefined, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (m === null) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  const start = a === "" ? Math.max(0, size - Number(b)) : Number(a);
  const end = a === "" || b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return start <= end ? [start, end] : null;
}

/// Отдаёт серию с диска; путь обязан лежать внутри папки с видео.
export async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  file: string,
): Promise<void> {
  const abs = path.resolve(file);
  if (!abs.startsWith(path.resolve(root) + path.sep) || path.extname(abs) !== ".mp4") {
    res.writeHead(403).end();
    return;
  }
  let size: number;
  try {
    size = (await fsp.stat(abs)).size;
  } catch {
    res.writeHead(404).end();
    return;
  }

  const head = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const range = req.headers.range === undefined ? null : parseRange(req.headers.range, size);
  if (req.headers.range !== undefined && range === null) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  const [start, end] = range ?? [0, size - 1];
  res.writeHead(range ? 206 : 200, {
    ...head,
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(abs, { start, end }), res).catch(() => {});
}

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/// Поток с CDN через себя: браузер не умеет подставить нужный Referer, а мы умеем.
export async function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  referer: string,
): Promise<void> {
  if (!/^https?:\/\//.test(url)) {
    res.writeHead(400).end();
    return;
  }
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
  };
  if (referer !== "") headers.Referer = referer;
  if (req.headers.range !== undefined) headers.Range = req.headers.range;

  let up: Response;
  try {
    up = await fetch(url, { headers, signal: ctrl.signal });
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
    return;
  }

  const out: Record<string, string> = { "Cache-Control": "no-store" };
  for (const h of PASS) {
    const v = up.headers.get(h);
    if (v !== null) out[h] = v;
  }
  if (up.ok && !out["content-type"]?.startsWith("video/")) out["content-type"] = "video/mp4";
  res.writeHead(up.status, out);

  if (up.body === null || req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(up.body as never), res).catch(() => {});
}
