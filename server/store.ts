import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Fact = { key: string; value: string };

export type Settings = {
  username: string;
  password: string;
  videoDir: string | null;
  player: string | null;
  streamByDefault: boolean;
};

export type Entry = {
  url: string;
  title: string;
  original: string;
  poster: string;
  description: string;
  genres: string[];
  facts: Fact[];
  watched: string[];
  lastPlayer: string | null;
  lastQuality: string | null;
  addedAt: number;
};

const DEFAULTS: Settings = {
  username: "",
  password: "",
  videoDir: null,
  player: null,
  streamByDefault: false,
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

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
    addedAt: now(),
  };
}

/// Берём только известные поля: в старых конфигах встречается мусор вроде `video_dir`,
/// и serde его отбрасывал — держим то же поведение.
function pickSettings(raw: Partial<Settings>): Settings {
  return {
    username: raw.username ?? DEFAULTS.username,
    password: raw.password ?? DEFAULTS.password,
    videoDir: raw.videoDir ?? DEFAULTS.videoDir,
    player: raw.player ?? DEFAULTS.player,
    streamByDefault: raw.streamByDefault ?? DEFAULTS.streamByDefault,
  };
}

function pickEntry(raw: Partial<Entry>): Entry {
  const base = blank(raw.url ?? "");
  return {
    ...base,
    ...pickDefined(raw, base),
  };
}

function pickDefined(raw: Partial<Entry>, base: Entry): Partial<Entry> {
  const out: Partial<Entry> = {};
  for (const k of Object.keys(base) as (keyof Entry)[]) {
    if (raw[k] !== undefined && raw[k] !== null) (out as Record<string, unknown>)[k] = raw[k];
  }
  return out;
}

export function loadSettings(): Settings {
  return pickSettings(readJson<Partial<Settings>>(path.join(configDir(), "config.json"), {}));
}

export function saveSettings(s: Settings): void {
  const file = path.join(configDir(), "config.json");
  writeJson(file, s);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  }
}

const libraryPath = (): string => path.join(configDir(), "library.json");

/// Первый запуск после CLI-версии: подхватываем старый links.json.
export function loadLibrary(): Entry[] {
  const file = libraryPath();
  if (fs.existsSync(file)) return readJson<Partial<Entry>[]>(file, []).map(pickEntry);
  const old = readJson<{ url: string; title?: string }[]>(path.join(configDir(), "links.json"), []);
  return old.map((l) => blank(l.url, l.title ?? ""));
}

export function saveLibrary(items: Entry[]): void {
  writeJson(libraryPath(), items);
}

export function videoDir(s: Settings): string {
  const env = process.env.ANIMEJOYA_DIR;
  if (env) return env;
  if (s.videoDir && s.videoDir.trim()) return s.videoDir;
  return path.join(os.homedir(), "Videos", "AnimeJoy");
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
