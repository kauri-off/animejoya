import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { msg } from "./schema.ts";
import { UA } from "./site.ts";

export type OnProgress = (done: number, total: number, bytesPerSec: number) => void;

/// На Windows rename не перезаписывает существующий файл, в отличие от unix.
async function replace(from: string, to: string): Promise<void> {
  if (process.platform === "win32") await fsp.rm(to, { force: true });
  await fsp.rename(from, to);
}

const size = async (file: string): Promise<number | null> => {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
};

/// Пустой Referer шлём именно как отсутствие заголовка: CDN AllVideo режет чужие.
const withReferer = (headers: Record<string, string>, referer: string): Record<string, string> =>
  referer === "" ? headers : { ...headers, Referer: referer };

/// HEAD на sibnet и filevideo отдаёт 403, поэтому размер спрашиваем диапазоном.
async function remoteSize(url: string, referer: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: withReferer({ "User-Agent": UA, Range: "bytes=0-0" }, referer),
      signal: AbortSignal.timeout(30_000),
    });
    await res.body?.cancel();
    if (!res.ok) return null;
    // `bytes 0-0/12345` при 206; если диапазон проигнорировали — это весь файл.
    const range = res.headers.get("content-range");
    if (range !== null) {
      const n = Number(range.split("/").pop());
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (res.status === 200) {
      const n = Number(res.headers.get("content-length"));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
  }
}

/// Качает файл целиком (с докачкой), сообщая о прогрессе через `onProgress`.
export async function fetchFile(
  url: string,
  referer: string,
  dest: string,
  signal: AbortSignal,
  onProgress: OnProgress,
): Promise<string> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const known = await remoteSize(url, referer);

  const already = await size(dest);
  if (already !== null && (known === null || already === known)) return dest;

  const part = `${dest}.part`;
  let done = (await size(part)) ?? 0;
  // Битый огрызок больше исходника перекачиваем с нуля.
  if (known !== null && done > known) {
    await fsp.rm(part, { force: true });
    done = 0;
  }
  if (known !== null && done === known && done > 0) {
    await replace(part, dest);
    return dest;
  }

  const headers: Record<string, string> = withReferer(
    {
      "User-Agent": UA,
      Accept: "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
      "Sec-Fetch-Dest": "video",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
    },
    referer,
  );
  if (done > 0) headers.Range = `bytes=${done}-`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    if (signal.aborted) throw new Error("загрузка отменена");
    throw new Error(`не удалось начать загрузку: ${msg(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`сервер видео ответил ${res.status}`);
  }

  // Если докачка не поддержана — начинаем заново.
  const resume = done > 0 && res.status === 206;
  const start = resume ? done : 0;
  const total = known ?? start + Number(res.headers.get("content-length") ?? 0);

  // FileSink Bun'а вдвое дешевле по CPU, чем node-стрим, — на слабом сервере это заметно.
  const fd = fs.openSync(part, resume ? "a" : "w");
  const out = Bun.file(fd).writer({ highWaterMark: 1 << 20 });
  let written = start;
  let tick = Date.now();
  let tickBytes = written;
  onProgress(written, total, 0);

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      out.write(chunk);
      written += chunk.length;
      const elapsed = Date.now() - tick;
      if (elapsed >= 250) {
        onProgress(written, total, Math.round(((written - tickBytes) * 1000) / elapsed));
        tick = Date.now();
        tickBytes = written;
      }
    }
  } catch (e) {
    if (signal.aborted) throw new Error("загрузка отменена");
    throw new Error(`обрыв загрузки: ${msg(e)}`);
  } finally {
    await out.end();
    fs.closeSync(fd);
  }

  if (total > 0 && written < total) {
    throw new Error(`скачано ${written} из ${total} байт — запустите ещё раз, докачается`);
  }
  onProgress(written, Math.max(total, written), 0);
  await replace(part, dest);
  return dest;
}
