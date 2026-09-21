import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { media, rank, type Episode, type Progress, type Title } from "../api";
import { Check, Download, Folder, Next, Play, Prev, Screen, Trash, X } from "../icons";

const Watch = lazy(() => import("./Watch"));

const spring = { type: "spring" as const, stiffness: 420, damping: 34 };

// Сайт кладёт выбор в дерево data-id: озвучка → плеер → диапазон серий.
// Уровней бывает два или три, поэтому имя берём по индексу, а не по типу.
const LEVELS = ["Озвучка", "Плеер", "Диапазон"];

export type Actions = {
  stream: (ep: Episode, quality: string) => void;
  download: (ep: Episode, quality: string, autoplay: boolean) => void;
  openFile: (ep: Episode) => void;
  deleteFile: (ep: Episode) => void;
  openDir: () => void;
  resolvePlayer: (playerId: string) => Promise<void>;
  toggleWatched: (ep: Episode) => void;
  markWatched: (ep: Episode) => void;
  remember: (player?: string, quality?: string) => void;
};

export default function TitleScreen({
  data,
  jobs,
  actions,
}: {
  data: Title;
  jobs: Record<string, Progress>;
  actions: Actions;
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
  const playSrc = playing?.file
    ? media.file(playing.file)
    : playingSource
      ? media.remote(playingSource)
      : null;

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

  const external = (ep: Episode) => (ep.file ? actions.openFile(ep) : actions.stream(ep, active));
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

  // Esc сначала закрывает плеер, а уже потом — карточку тайтла.
  useEffect(() => {
    if (watching === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      e.stopImmediatePropagation();
      if (pick !== null) setPick(null);
      else setWatching(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [watching, pick]);

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
                  <Prev size={14} />
                </button>
                <div className="label">
                  {playing.title}
                  <small>{path.join(" · ") || (playing.file ? "с диска" : "поток")}</small>
                </div>
                <button
                  className="act quiet"
                  title="Следующая серия"
                  disabled={watching === null || watching + 1 >= episodes.length}
                  onClick={() => watching !== null && setWatching(watching + 1)}
                >
                  <Next size={14} />
                </button>
              </div>

              <div className="tools">
                {!playing.file && qualitySeg}
                <button className="act quiet" title="Во внешнем плеере" onClick={() => external(playing)}>
                  <Screen size={15} />
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
        <h3>Серии</h3>
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
                  onClick={() => setPick(i === pick ? null : i)}
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
                <Play size={13} /> Смотреть
              </button>
              <button className="act quiet" title="Во внешнем плеере" onClick={() => external(episode)}>
                <Screen size={15} />
              </button>
              {episode.file ? (
                <button
                  className="act danger quiet"
                  title="Удалить файл"
                  onClick={() => actions.deleteFile(episode)}
                >
                  <Trash size={14} />
                </button>
              ) : (
                <button
                  className="act quiet"
                  title="Скачать"
                  onClick={() => actions.download(episode, active, false)}
                >
                  <Download size={14} />
                </button>
              )}
              <button
                className="act quiet"
                title="Отметить просмотренной"
                onClick={() => actions.toggleWatched(episode)}
              >
                <Check size={14} />
              </button>
              <button className="act quiet" title="Папка тайтла" onClick={actions.openDir}>
                <Folder size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
