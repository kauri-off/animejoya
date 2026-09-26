import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { Entry, Settings } from "./schema.ts";

const DEFAULTS: Settings = {
  username: "",
  password: "",
  preloadNext: true,
};

export function configDir(): string {
  const home = os.homedir();
  const base =
    process.platform === "win32"
      ? process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const dir = path.join(base, "animejoya");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/// Через временный файл: оборванная запись не должна съесть библиотеку.
function writeJson(file: string, value: unknown, mode?: number): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

/// Поля проверяем по одному: битое значение откатывается к умолчанию, а лишние ключи
/// вроде `video_dir` из старых конфигов просто отбрасываются.
function lenient<S extends z.ZodObject>(schema: S, raw: unknown, base: z.infer<S>): z.infer<S> {
  const src = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [key, field] of Object.entries(schema.shape)) {
    const r = field.safeParse(src[key]);
    if (r.success) out[key] = r.data;
  }
  return out as z.infer<S>;
}

export const now = (): number => Math.floor(Date.now() / 1000);

export function blank(url: string, title = ""): Entry {
  return {
    url,
    title,
    original: "",
    poster: "",
    description: "",
    genres: [],
    facts: [],
    watched: [],
    lastPlayer: null,
    lastQuality: null,
    total: 0,
    addedAt: now(),
  };
}

const settingsPath = (): string => path.join(configDir(), "config.json");
const libraryPath = (): string => path.join(configDir(), "library.json");

export function loadSettings(): Settings {
  return lenient(Settings, readJson(settingsPath()), DEFAULTS);
}

export function saveSettings(s: Settings): void {
  writeJson(settingsPath(), s, 0o600);
}

const toEntry = (raw: unknown): Entry | null => {
  const url = (raw as { url?: unknown } | null)?.url;
  return typeof url === "string" ? lenient(Entry, raw, blank(url)) : null;
};

/// Первый запуск после CLI-версии: подхватываем старый links.json.
export function loadLibrary(): Entry[] {
  const file = libraryPath();
  if (fs.existsSync(file)) {
    const raw = readJson(file);
    return (Array.isArray(raw) ? raw : []).map(toEntry).filter((e) => e !== null);
  }
  const old = readJson(path.join(configDir(), "links.json"));
  return (Array.isArray(old) ? old : []).map(toEntry).filter((e) => e !== null);
}

export function saveLibrary(items: Entry[]): void {
  writeJson(libraryPath(), items);
}

/// `.../5499-o-moem-pererozhdenii-v-sliz-4-sezon.html` -> `5499-o-moem-...`
export function slug(url: string): string {
  return (url.split("/").pop() ?? url).replace(/(\.html)+$/, "");
}

/// «21 серия» -> «21», иначе безопасное имя из заголовка.
export function epTag(title: string): string {
  const num = /^[0-9]+/.exec(title);
  if (num) return num[0].padStart(2, "0");
  return Array.from(title)
    .map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "_"))
    .join("");
}

export function normalizeUrl(url: string): string {
  const u = url.trim();
  return u.startsWith("http") ? u : `https://${u.replace(/^(\/\/)+/, "")}`;
}
