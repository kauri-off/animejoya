import { spawn } from "node:child_process";
import path from "node:path";

const one = (cmd: string): string[] => [cmd];

/// Что пробуем, если плеер не задан явно. Каждый вариант — уже разобранные argv,
/// потому что пути вроде `C:\Program Files\...` нельзя резать по пробелам.
function defaults(): string[][] {
  if (process.platform !== "win32") {
    return [one("mpv"), one("vlc"), one("ffplay"), one("xdg-open")];
  }
  const out: string[][] = [one("mpv"), one("vlc"), one("ffplay")];
  for (const v of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const base = process.env[v];
    if (base === undefined) continue;
    out.push([path.join(base, "mpv", "mpv.exe")]);
    out.push([path.join(base, "VideoLAN", "VLC", "vlc.exe")]);
  }
  out.push(["cmd", "/c", "start", ""]);
  return out;
}

function candidates(configured: string | null): string[][] {
  const explicit = process.env.ANIMEJOYA_PLAYER ?? configured ?? "";
  if (explicit.trim() !== "") return [explicit.split(/\s+/).filter(Boolean)];
  return defaults();
}

type Spawned = { ok: true } | { ok: false; notFound: boolean; message: string };

/// Запускает и отвязывает процесс — окно приложения остаётся отзывчивым.
function trySpawn(bin: string, args: string[]): Promise<Spawned> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Spawned): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: "ignore" });
    } catch (e) {
      done({ ok: false, notFound: false, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.once("error", (e: NodeJS.ErrnoException) => {
      done({ ok: false, notFound: e.code === "ENOENT", message: e.message });
    });
    child.once("spawn", () => {
      child.unref();
      done({ ok: true });
    });
  });
}

export async function launch(
  configured: string | null,
  target: string,
  title: string,
  referer: string | null,
): Promise<string> {
  for (const c of candidates(configured)) {
    const [bin, ...rest] = c;
    if (bin === undefined) continue;
    const stem = path.basename(bin).replace(/\.[^.]*$/, "");
    const args = [...rest];
    switch (stem) {
      case "ffplay":
        args.push("-autoexit");
        if (referer !== null) args.push("-headers", `Referer: ${referer}\r\n`);
        break;
      case "mpv":
        args.push(`--force-media-title=${title}`);
        if (referer !== null) args.push(`--referrer=${referer}`);
        break;
      case "vlc":
        if (referer !== null) args.push(`--http-referrer=${referer}`);
        break;
    }
    args.push(target);

    const r = await trySpawn(bin, args);
    if (r.ok) return bin;
    if (!r.notFound) throw new Error(`не удалось запустить ${bin}: ${r.message}`);
  }
  throw new Error("плеер не найден — поставьте mpv или укажите его в настройках");
}

/// Показать папку в системном файловом менеджере.
export async function reveal(target: string): Promise<void> {
  const bin =
    process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  const r = await trySpawn(bin, [target]);
  if (!r.ok) throw new Error(`не удалось открыть ${target}`);
}
