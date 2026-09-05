import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { rank, type Episode, type Progress, type Title } from "../api";
import { Check, Download, Folder, Play, Trash } from "../icons";

const spring = { type: "spring" as const, stiffness: 420, damping: 34 };

export type Actions = {
  stream: (ep: Episode, quality: string) => void;
  download: (ep: Episode, quality: string, autoplay: boolean) => void;
  openFile: (ep: Episode) => void;
  deleteFile: (ep: Episode) => void;
  openDir: () => void;
  toggleWatched: (ep: Episode) => void;
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
  const { entry, players, external } = data;
  const [playerId, setPlayerId] = useState(
    () => players.find((p) => p.id === entry.lastPlayer)?.id ?? players[0]?.id ?? "",
  );
  const [pick, setPick] = useState<number | null>(null);
  const [quality, setQuality] = useState<string | null>(entry.lastQuality);

  const player = players.find((p) => p.id === playerId) ?? players[0];
  const episodes = player?.episodes ?? [];
  const episode = pick === null ? null : (episodes[pick] ?? null);

  const qualities = useMemo(() => {
    const seen = new Set<string>();
    for (const e of episodes) for (const s of e.sources) seen.add(s.quality);
    return [...seen].sort((a, b) => rank(b) - rank(a));
  }, [episodes]);

  const active = quality && qualities.includes(quality) ? quality : (qualities[0] ?? "");
  const source = episode?.sources.find((s) => s.quality === active) ?? episode?.sources[0];
  const jobFor = (ep: Episode) => running.find((j) => j.id.startsWith(`${data.dir}/${ep.tag}-`)) ?? null;

  const running = useMemo(() => Object.values(jobs), [jobs]);

  useEffect(() => setPick(null), [playerId]);

  const dock = useRef<HTMLDivElement>(null);
  const docked = Boolean(episode && source);

  useEffect(() => {
    const el = dock.current;
    const root = document.documentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--dock-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--dock-h", "0px");
    };
  }, [docked]);

  return (
    <div className="detail">
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

      {players.length > 1 && (
        <div className="section">
          <h3>Озвучка</h3>
          <div className="pills">
            {players.map((p) => (
              <button
                key={p.id}
                className={`pill${p.id === player?.id ? " on" : ""}`}
                onClick={() => {
                  setPlayerId(p.id);
                  actions.remember(p.id, undefined);
                }}
              >
                {p.name} · {p.episodes.length}
              </button>
            ))}
          </div>
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
                  className={`ep${i === pick ? " on" : seen ? " seen" : ""}`}
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
        {external.length > 0 && (
          <p className="hint" style={{ marginTop: 14 }}>
            Внешние плееры без прямых ссылок: {external.join(", ")}
          </p>
        )}
      </div>

      <AnimatePresence>
        {episode && source && (
          <motion.div
            ref={dock}
            className="dock"
            initial={{ opacity: 0, y: 26, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 26, scale: 0.96 }}
            transition={spring}
          >
            <div className="label">
              {episode.title}
              <small>{player?.name}</small>
            </div>

            {qualities.length > 1 && (
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
            )}

            {episode.file ? (
              <>
                <button className="act accent" onClick={() => actions.openFile(episode)}>
                  <Play size={13} /> Смотреть
                </button>
                <button className="act danger quiet" onClick={() => actions.deleteFile(episode)}>
                  <Trash size={14} />
                </button>
              </>
            ) : (
              <>
                <button className="act accent" onClick={() => actions.stream(episode, active)}>
                  <Play size={13} /> Смотреть
                </button>
                <button className="act" onClick={() => actions.download(episode, active, false)}>
                  <Download size={14} /> Скачать
                </button>
              </>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
