import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { media, rank, type Episode, type Progress, type Title } from "../api";
import { Check, CheckCheck, Download, Play, SkipBack, SkipForward, Trash2, X, Zap } from "lucide-react";

const Watch = lazy(() => import("./Watch"));

const spring = { type: "spring" as const, stiffness: 420, damping: 34 };

// Сайт кладёт выбор в дерево data-id: озвучка → плеер → диапазон серий.
// Уровней бывает два или три, поэтому имя берём по индексу, а не по типу.
const LEVELS = ["Озвучка", "Плеер", "Диапазон"];

export type Actions = {
  download: (ep: Episode, quality: string) => void;
  preload: (ep: Episode, quality: string) => void;
  dropCache: (ep: Episode) => void;
  resolvePlayer: (playerId: string) => Promise<void>;
  toggleWatched: (ep: Episode) => void;
  markWatched: (ep: Episode) => void;
  markUpTo: (eps: Episode[]) => void;
  remember: (player?: string, quality?: string) => void;
};

export default function TitleScreen({
  data,
  jobs,
  actions,
  preloadNext,
}: {
  data: Title;
  jobs: Record<string, Progress>;
  actions: Actions;
  preloadNext: boolean;
}) {
  const { entry, players } = data;
  const [playerId, setPlayerId] = useState(
    () => players.find((p) => p.id === entry.lastPlayer)?.id ?? players[0]?.id ?? "",
  );
  const [pick, setPick] = useState<number | null>(null);
  const [quality, setQuality] = useState<string | null>(entry.lastQuality);
  const [resolving, setResolving] = useState(false);
  const [watching, setWatching] = useState<number | null>(null);
  const tried = useRef(new Set<string>());
  const theater = useRef<HTMLElement>(null);

  const player = players.find((p) => p.id === playerId) ?? players[0];
  const episodes = player?.episodes ?? [];
  const episode = pick === null ? null : (episodes[pick] ?? null);

  const qualities = useMemo(() => {
    const seen = new Set<string>();
    for (const e of episodes) for (const s of e.sources) seen.add(s.quality);
    return [...seen].sort((a, b) => rank(b) - rank(a));
  }, [episodes]);

  const active = quality && qualities.includes(quality) ? quality : (qualities[0] ?? "");
  const sourceOf = (ep: Episode | null) => ep?.sources.find((s) => s.quality === active) ?? ep?.sources[0];
  const source = sourceOf(episode);

  const playing = watching === null ? null : (episodes[watching] ?? null);
  const playingSource = sourceOf(playing);
  // Источник фиксируем на старте серии, иначе догрузка кэша перезапустит плеер.
  const cachedAtStart = useMemo(() => playing?.file ?? null, [watching, playerId]);
  const playFile = cachedAtStart !== null && playing?.file ? playing.file : null;
  const playSrc = playFile
    ? media.file(playFile)
    : playingSource
      ? media.remote(playingSource)
      : null;

  const lastSeen = episodes.reduce((n, e, i) => (entry.watched.includes(e.title) ? i : n), -1);
  const seenHere = episodes.filter((e) => entry.watched.includes(e.title)).length;
  const finished = episodes.length > 0 && lastSeen === episodes.length - 1;
  const upNext = episodes.length === 0 ? null : finished ? 0 : lastSeen + 1;

  const watch = (i: number) => {
    setWatching(i);
    setPick(null);
  };

  const qualitySeg = qualities.length > 1 && (
    <div className="seg">
      {qualities.map((q) => (
        <button
          key={q}
          className={q === active ? "on" : ""}
          onClick={() => {
            setQuality(q);
            actions.remember(undefined, q);
          }}
        >
          {q}
        </button>
      ))}
    </div>
  );

  const jobFor = (ep: Episode) => running.find((j) => j.id.startsWith(`${data.dir}/${ep.tag}-`)) ?? null;

  const running = useMemo(() => Object.values(jobs), [jobs]);

  const path = player?.path ?? [];
  const depth = players.reduce((n, p) => Math.max(n, p.path.length), 0);

  const matching = (prefix: string[]) =>
    players.filter((p) => prefix.every((v, k) => p.path[k] === v));

  const optionsAt = (level: number) => {
    const seen: string[] = [];
    for (const p of matching(path.slice(0, level))) {
      const v = p.path[level];
      if (v !== undefined && !seen.includes(v)) seen.push(v);
    }
    return seen;
  };

  const choose = (level: number, value: string) => {
    const found = matching([...path.slice(0, level), value]);
    // Держимся уже выбранного на уровнях ниже, если такая ветка ещё есть.
    const next =
      found.find((p) => path.slice(level + 1).every((v, k) => p.path[level + 1 + k] === v)) ??
      found[0];
    if (!next) return;
    setPlayerId(next.id);
    actions.remember(next.id, undefined);
  };

  // Уровень с единственным вариантом выбирать не из чего — не показываем.
  const levels = Array.from({ length: depth }, (_, i) => i).filter((i) => optionsAt(i).length > 1);

  useEffect(() => {
    setPick(null);
    setWatching(null);
  }, [playerId]);

  useEffect(() => {
    if (watching !== null) theater.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [watching]);

  // Пока смотрим серию, следующая тихо ложится во временный кэш.
  useEffect(() => {
    if (watching === null || !preloadNext) return;
    const next = episodes[watching + 1];
    if (next && !next.file && next.sources.length > 0 && !jobFor(next)) actions.preload(next, active);
  }, [watching, playerId, preloadNext]);

  // Esc сначала закрывает плеер, а уже потом — карточку тайтла.
  useEffect(() => {
    if (watching === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.code === "KeyN" || e.code === "KeyP")) {
        const to = watching + (e.code === "KeyN" ? 1 : -1);
        if (to >= 0 && to < episodes.length) setWatching(to);
        e.preventDefault();
        return;
      }
      if (e.key !== "Escape" || document.fullscreenElement) return;
      e.stopImmediatePropagation();
      if (pick !== null) setPick(null);
      else setWatching(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [watching, pick, episodes.length]);

  // У AllVideo и Sibnet ссылки лежат на их стороне — забираем при выборе озвучки.
  const pending = Boolean(player?.resolvable) && episodes.every((e) => e.sources.length === 0);
  useEffect(() => {
    if (!pending || tried.current.has(playerId)) return;
    tried.current.add(playerId);
    setResolving(true);
    actions.resolvePlayer(playerId).finally(() => setResolving(false));
  }, [playerId, pending]);

  return (
    <div className="detail">
      <AnimatePresence initial={false}>
        {playing && playSrc && (
          <motion.section
            key="theater"
            ref={theater}
            className="theater"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <Suspense fallback={<div className="player placeholder" />}>
              <Watch
                key={`${playerId}|${playing.title}`}
                src={playSrc}
                title={`${playing.title} · ${entry.title}`}
                storageKey={`animejoya:${entry.url}|${playing.title}`}
                onWatched={() => {
                  if (!entry.watched.includes(playing.title)) actions.markWatched(playing);
                }}
                onEnded={() => {
                  if (watching !== null && watching + 1 < episodes.length) setWatching(watching + 1);
                }}
              />
            </Suspense>
            <div className="theater-bar">
              <div className="nav">
                <button
                  className="act quiet"
                  title="Предыдущая серия"
                  disabled={!watching}
                  onClick={() => watching && setWatching(watching - 1)}
                >
                  <SkipBack size={14} />
                </button>
                <div className="label">
                  {playing.title}
                  <small>{path.join(" · ") || (playFile ? "из кэша" : "поток")}</small>
                </div>
                <button
                  className="act quiet"
                  title="Следующая серия"
                  disabled={watching === null || watching + 1 >= episodes.length}
                  onClick={() => watching !== null && setWatching(watching + 1)}
                >
                  <SkipForward size={14} />
                </button>
              </div>

              <div className="tools">
                {!playFile && qualitySeg}
                <button className="act quiet" title="Скачать" onClick={() => actions.download(playing, active)}>
                  <Download size={14} />
                </button>
                <button className="act quiet" title="Закрыть плеер" onClick={() => setWatching(null)}>
                  <X size={15} />
                </button>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <div className="hero">
        <div className="poster">
          {entry.poster ? <img src={entry.poster} alt="" draggable={false} decoding="async" /> : null}
        </div>

        <div>
          <h1>{entry.title}</h1>
          {entry.original && <div className="romanji">{entry.original}</div>}

          {upNext !== null && episodes[upNext] && (
            <div className="resume">
              <button
                className="primary big"
                disabled={pending}
                onClick={() => (watching === upNext ? theater.current?.scrollIntoView({ behavior: "smooth" }) : watch(upNext))}
              >
                <Play size={14} fill="currentColor" strokeWidth={0} />
                {finished ? "Пересмотреть" : lastSeen < 0 ? "Смотреть" : "Продолжить"}
                <span className="what">{episodes[upNext].title}</span>
              </button>
              <span className="hint">
                {finished
                  ? "Все серии просмотрены"
                  : seenHere > 0
                    ? `Просмотрено ${seenHere} из ${episodes.length}`
                    : `${episodes.length} ${plural(episodes.length, "серия", "серии", "серий")}`}
              </span>
            </div>
          )}

          {entry.genres.length > 0 && (
            <div className="tags">
              {entry.genres.map((g) => (
                <span className="tag" key={g}>
                  {g}
                </span>
              ))}
            </div>
          )}

          {entry.description && <p className="desc">{entry.description}</p>}

          {entry.facts.length > 0 && (
            <div className="facts">
              {entry.facts
                .filter((f) => f.key.toLowerCase() !== "жанр")
                .slice(0, 8)
                .map((f) => (
                  <div key={f.key}>
                    <b>{f.key}</b>
                    <span>{f.value}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {levels.length > 0 && (
        <div className="section">
          {levels.map((level) => (
            <div className="level" key={level}>
              <h3>{LEVELS[level] ?? `Уровень ${level + 1}`}</h3>
              <div className="pills">
                {optionsAt(level).map((o) => (
                  <button
                    key={o}
                    className={`pill${path[level] === o ? " on" : ""}`}
                    onClick={() => choose(level, o)}
                  >
                    {o}
                    {level === depth - 1 && (
                      <span className="count">
                        {matching([...path.slice(0, level), o])[0]?.episodes.length ?? 0}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="eps-head">
          <h3>Серии</h3>
          {episodes.length > 0 && (
            <div className="legend">
              <span>
                <Check size={11} /> просмотрена
              </span>
              <span>
                <i className="dot" /> в кэше, без подгрузок
              </span>
              <span className="desk">двойной клик — смотреть</span>
            </div>
          )}
        </div>
        {episodes.length === 0 ? (
          <p className="hint">У этого тайтла нет «своего» плеера — только внешние iframe.</p>
        ) : (
          <div className="eps">
            {episodes.map((e, i) => {
              const seen = entry.watched.includes(e.title);
              const job = jobFor(e);
              return (
                <button
                  key={e.title + i}
                  className={`ep${i === pick ? " on" : seen ? " seen" : ""}${i === watching ? " playing" : ""}`}
                  disabled={pending}
                  title={[e.title, seen && "просмотрена", e.file && "в кэше"].filter(Boolean).join(" · ")}
                  onClick={() => setPick(i === pick ? null : i)}
                  onDoubleClick={() => watch(i)}
                >
                  {e.tag.replace(/^0/, "")}
                  {e.file && <span className="dot" />}
                  {seen && (
                    <span className="seenmark">
                      <Check size={11} />
                    </span>
                  )}
                  {job && job.total > 0 && (
                    <span className="bar" style={{ width: `${(job.done / job.total) * 100}%` }} />
                  )}
                </button>
              );
            })}
          </div>
        )}
        {pending && (
          <p className="hint" style={{ marginTop: 14 }}>
            {resolving
              ? "Забираем ссылки из плеера…"
              : "Плеер не отдал ссылок — попробуйте другую озвучку."}
          </p>
        )}
        {data.external.length > 0 && (
          <p className="hint" style={{ marginTop: 14 }}>
            Внешние плееры без прямых ссылок: {data.external.join(", ")}
          </p>
        )}
      </div>

      <AnimatePresence>
        {episode && source && pick !== null && (
          <motion.div
            className="dock"
            initial={{ opacity: 0, y: 26, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 26, scale: 0.96 }}
            transition={spring}
          >
            <div className="head">
              <div className="label">
                {episode.title}
                <small>{path.join(" · ")}</small>
              </div>
              {qualitySeg}
            </div>

            <div className="acts">
              <button className="act accent" onClick={() => watch(pick)}>
                <Play size={13} fill="currentColor" strokeWidth={0} /> Смотреть
              </button>
              <button className="act quiet" title="Скачать" onClick={() => actions.download(episode, active)}>
                <Download size={14} />
              </button>
              {episode.file ? (
                <button
                  className="act danger quiet"
                  title="Убрать из кэша"
                  onClick={() => actions.dropCache(episode)}
                >
                  <Trash2 size={14} />
                </button>
              ) : (
                <button
                  className="act quiet"
                  title="Предзагрузить"
                  disabled={jobFor(episode) !== null}
                  onClick={() => actions.preload(episode, active)}
                >
                  <Zap size={14} />
                </button>
              )}
              <button
                className={`act quiet${entry.watched.includes(episode.title) ? " lit" : ""}`}
                title={entry.watched.includes(episode.title) ? "Снять отметку о просмотре" : "Отметить просмотренной"}
                onClick={() => actions.toggleWatched(episode)}
              >
                <Check size={14} />
              </button>
              {pick > 0 && (
                <button
                  className="act quiet"
                  title="Отметить просмотренными все серии до этой включительно"
                  onClick={() => {
                    actions.markUpTo(episodes.slice(0, pick + 1));
                    setPick(null);
                  }}
                >
                  <CheckCheck size={15} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
