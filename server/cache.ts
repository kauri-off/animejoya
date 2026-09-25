import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOUR = 3_600_000;
export const TTL = Number(process.env.ANIMEJOYA_CACHE_HOURS ?? 12) * HOUR;
export const LIMIT = Number(process.env.ANIMEJOYA_CACHE_GB ?? 10) * 1024 ** 3;

export const root = path.resolve(process.env.ANIMEJOYA_CACHE ?? path.join(os.tmpdir(), "animejoya"));

export const dirOf = (slug: string): string => path.join(root, slug);

export function inside(file: string): string | null {
  const abs = path.resolve(file);
  return abs.startsWith(root + path.sep) && path.extname(abs) === ".mp4" ? abs : null;
}

/// Просмотр продлевает жизнь серии в кэше.
export function touch(file: string): void {
  const t = new Date();
  fsp.utimes(file, t, t).catch(() => {});
}

export type Item = { file: string; size: number; mtime: number };

async function walk(dir: string, out: Item[]): Promise<void> {
  let names: fs.Dirent[];
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    const file = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walk(file, out);
      continue;
    }
    try {
      const st = await fsp.stat(file);
      out.push({ file, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
}

export async function list(dir = root): Promise<Item[]> {
  const out: Item[] = [];
  await walk(dir, out);
  return out;
}

/// Папка тайтла прямо в корне кэша, без выхода наружу через `..`.
export function titleDir(slug: string): string | null {
  const abs = path.resolve(root, slug);
  return slug !== "" && path.dirname(abs) === root ? abs : null;
}

/// Убирает опустевшие папки тайтлов.
export async function prune(): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(names.map((n) => fsp.rmdir(path.join(root, n)).catch(() => {})));
}

/// Выкидывает протухшее, затем самое старое, пока кэш не влезет в лимит; возвращает удалённое.
export async function sweep(busy: Set<string>): Promise<string[]> {
  const items = await list();
  const now = Date.now();
  const alive: Item[] = [];
  const gone: string[] = [];
  for (const it of items) {
    if (busy.has(it.file.replace(/\.part$/, ""))) continue;
    if (now - it.mtime > TTL) {
      await fsp.rm(it.file, { force: true });
      gone.push(it.file);
    } else alive.push(it);
  }
  let total = alive.reduce((s, it) => s + it.size, 0);
  alive.sort((a, b) => a.mtime - b.mtime);
  for (const it of alive) {
    if (total <= LIMIT) break;
    await fsp.rm(it.file, { force: true });
    gone.push(it.file);
    total -= it.size;
  }
  await prune();
  return gone;
}
