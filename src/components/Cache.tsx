import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  api,
  bytes,
  media,
  on,
  saveAs,
  type CacheFile,
  type CacheInfo,
  type CacheTitle,
  type Progress,
} from "../api";
import { Download, Refresh, Trash } from "../icons";

const HOUR = 3_600_000;
const spring = { type: "spring" as const, stiffness: 420, damping: 34 };

const epName = (tag: string) => (/^\d+$/.test(tag) ? `${Number(tag)} серия` : tag.replace(/_+/g, " ").trim());

function left(ms: number): string {
  if (ms <= 0) return "уйдёт при чистке";
  if (ms >= HOUR) return `ещё ${Math.floor(ms / HOUR)} ч`;
  return `ещё ${Math.max(1, Math.round(ms / 60_000))} мин`;
}

export default function Cache({
  jobs,
  onOpen,
  toast,
}: {
  jobs: Record<string, Progress>;
  onOpen: (url: string) => void;
  toast: (text: string, bad?: boolean) => void;
}) {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    api.cacheList().then(setInfo, (e) => toast(String(e), true));
  }, [toast]);

  const running = Object.keys(jobs).sort().join("\n");
  useEffect(reload, [reload, running]);

  useEffect(() => {
    const uns = [on.dropped(reload), on.done(reload)];
    return () => {
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [reload]);

  useEffect(() => () => clearTimeout(disarm.current), []);

  const known = new Set(info?.titles.flatMap((t) => t.files.map((f) => f.path.replace(/\.part$/, ""))));
  const missing = info !== null && Object.keys(jobs).some((id) => !known.has(id));
  useEffect(() => {
    if (!missing) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [missing, reload]);

  const run = useCallback(
    (key: string, task: () => Promise<unknown>) => {
      setPending((p) => new Set(p).add(key));
      task()
        .catch((e) => toast(String(e), true))
        .finally(() => {
          setPending((p) => {
            const next = new Set(p);
            next.delete(key);
            return next;
          });
          reload();
        });
    },
    [toast, reload],
  );

  const clearAll = () => {
    clearTimeout(disarm.current);
    if (!armed) {
      setArmed(true);
      disarm.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    run("*", () => api.cacheClear().then(() => toast("Кэш очищен")));
  };

  if (info === null) {
    return (
      <div className="center">
        <span className="spin" />
      </div>
    );
  }

  const files = info.titles.reduce((n, t) => n + t.files.length, 0);
  const fill = info.limit > 0 ? Math.min(100, (info.size / info.limit) * 100) : 0;

  return (
    <div className="cache">
      <div className="cache-head">
        <div className="cache-intro">
          <h1>Кэш</h1>
          <p>
            Серия живёт {Math.round(info.ttl / HOUR)} ч после последнего просмотра. Когда место кончается, первыми
            уходят самые старые.
          </p>
        </div>
        <div className="cache-meter">
          <div className="row">
            <b>{bytes(info.size)}</b>
            <span>из {bytes(info.limit)}</span>
            <span className="spacer" />
            <span>{files ? `${files} файл.` : ""}</span>
          </div>
          <div className={`track${fill > 90 ? " hot" : ""}`}>
            <i style={{ width: `${fill}%` }} />
          </div>
          <small title={info.root}>{info.root}</small>
        </div>
        <div className="cache-acts">
          <button
            className="act"
            disabled={files === 0 || pending.has("sweep")}
            onClick={() => run("sweep", () => api.cacheSweep().then(setInfo))}
          >
            <Refresh size={14} /> Убрать устаревшее
          </button>
          <button
            className={`act danger${armed ? " armed" : ""}`}
            disabled={files === 0 || pending.has("*")}
            onClick={clearAll}
          >
            <Trash size={14} /> {armed ? "Точно очистить?" : "Очистить всё"}
          </button>
        </div>
      </div>

      {info.titles.length === 0 ? (
        <div className="empty cache-empty">
          <div className="mark" />
          <h2>Кэш пуст</h2>
          <p>Здесь появятся серии, которые вы предзагрузили для просмотра без подгрузок.</p>
        </div>
      ) : (
        <div className="cache-list">
          <AnimatePresence initial={false}>
            {info.titles.map((t) => (
              <TitleBlock
                key={t.slug}
                title={t}
                ttl={info.ttl}
                jobs={jobs}
                pending={pending}
                onOpen={onOpen}
                onDropTitle={() => run(t.slug, () => api.cacheDropTitle(t.slug))}
                onDrop={(f) => run(f.path, () => api.cacheDrop(f.path))}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function TitleBlock({
  title: t,
  ttl,
  jobs,
  pending,
  onOpen,
  onDropTitle,
  onDrop,
}: {
  title: CacheTitle;
  ttl: number;
  jobs: Record<string, Progress>;
  pending: Set<string>;
  onOpen: (url: string) => void;
  onDropTitle: () => void;
  onDrop: (f: CacheFile) => void;
}) {
  const busy = pending.has(t.slug) || pending.has("*");
  return (
    <motion.section
      layout
      className="cache-title"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: busy ? 0.5 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <div className="cache-title-head">
        <button className="thumb" disabled={!t.url} onClick={() => t.url && onOpen(t.url)} title="Открыть тайтл">
          {t.poster ? <img src={t.poster} alt="" loading="lazy" /> : <span>{t.title.charAt(0)}</span>}
        </button>
        <div className="what">
          {t.url ? (
            <button className="name" onClick={() => onOpen(t.url!)}>
              {t.title}
            </button>
          ) : (
            <div className="name" title="Тайтла нет в библиотеке">
              {t.title}
            </div>
          )}
          <div className="meta">
            {t.files.length} файл. · {bytes(t.size)}
          </div>
        </div>
        <button className="act quiet danger" disabled={busy} onClick={onDropTitle} title="Удалить все серии тайтла">
          <Trash size={14} /> <span className="wide">Удалить всё</span>
        </button>
      </div>

      <div className="cache-files">
        <AnimatePresence initial={false}>
          {t.files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              title={t.title}
              ttl={ttl}
              job={jobs[f.path.replace(/\.part$/, "")]}
              busy={busy || pending.has(f.path)}
              onDrop={() => onDrop(f)}
            />
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function FileRow({
  file: f,
  title,
  ttl,
  job,
  busy,
  onDrop,
}: {
  file: CacheFile;
  title: string;
  ttl: number;
  job: Progress | undefined;
  busy: boolean;
  onDrop: () => void;
}) {
  const pct = job?.total ? Math.min(100, (job.done / job.total) * 100) : 0;
  const status = job
    ? `качается ${Math.round(pct)}%`
    : f.partial
      ? "недокачан"
      : left(f.mtime + ttl - Date.now());
  const save = () => {
    const name = `${title} — ${epName(f.tag)} [${f.quality}].mp4`.replace(/[\\/:*?"<>|]/g, "_");
    saveAs(media.file(f.path, name));
  };

  return (
    <motion.div
      layout
      className={`cache-file${f.partial ? " partial" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: busy ? 0.5 : 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={spring}
    >
      <b>{epName(f.tag)}</b>
      {f.quality && <span className="q">{f.quality}</span>}
      <span className="size">{bytes(job?.done ?? f.size)}</span>
      <span className={`status${job ? " live" : ""}`}>{status}</span>
      <span className="spacer" />
      {!f.partial && (
        <button className="act quiet" title="Сохранить на устройство" onClick={save}>
          <Download size={14} />
        </button>
      )}
      <button
        className="act quiet danger"
        disabled={busy}
        title={job ? "Остановить и удалить" : "Удалить"}
        onClick={onDrop}
      >
        <Trash size={14} />
      </button>
      {job && (
        <div className="track">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </motion.div>
  );
}
