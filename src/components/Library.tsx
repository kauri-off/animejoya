import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Entry } from "../api";
import { Check, Plus, Search, X } from "../icons";
import { useLibraryDrag } from "./useLibraryDrag";

const LAYOUT_SPRING = { type: "spring" as const, stiffness: 320, damping: 30, mass: 0.8 };
const MOVE_KEYS = "Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown";
const SEARCH_FROM = 6;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

function Progress({ entry }: { entry: Entry }) {
  const seen = entry.watched.length;
  if (entry.total === 0) return seen > 0 ? <div className="badge">{seen} просм.</div> : null;
  if (seen >= entry.total) {
    return (
      <div className="badge done">
        <Check size={11} /> Просмотрено
      </div>
    );
  }
  return (
    <>
      <div className="badge">{seen > 0 ? `${seen} / ${entry.total}` : `${entry.total} сер.`}</div>
      {seen > 0 && (
        <div className="progress">
          <i style={{ width: `${(seen / entry.total) * 100}%` }} />
        </div>
      )}
    </>
  );
}

function CardBody({ entry, onRemove }: { entry: Entry; onRemove?: (e: Entry) => void }) {
  return (
    <>
      <div className="poster">
        {entry.poster ? (
          <img src={entry.poster} alt="" draggable={false} loading="lazy" decoding="async" />
        ) : (
          <div className="blank">
            <span>{(entry.title || "?").trim().charAt(0)}</span>
          </div>
        )}
        <Progress entry={entry} />
        {onRemove && (
          <button
            type="button"
            className="kill"
            aria-label="Удалить из библиотеки"
            title="Удалить из библиотеки"
            onClick={(ev) => {
              ev.stopPropagation();
              onRemove(entry);
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="name">{entry.title || entry.url}</div>
      {entry.original && <div className="sub">{entry.original}</div>}
    </>
  );
}

function Library({
  items,
  onOpen,
  onRemove,
  onAdd,
  onReorder,
  onReorderCommit,
}: {
  items: Entry[];
  onOpen: (e: Entry) => void;
  onRemove: (e: Entry) => void;
  onAdd: () => void;
  onReorder: (items: Entry[]) => void;
  onReorderCommit: (items: Entry[]) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return items;
    return items.filter((e) => norm(`${e.title} ${e.original}`).includes(q));
  }, [items, query]);
  const filtering = shown !== items;
  const searchable = items.length >= SEARCH_FROM || query !== "";

  useEffect(() => {
    if (!searchable) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const find = (e.key === "f" || e.key === "а") && (e.ctrlKey || e.metaKey);
      if ((e.key === "/" && !typing) || find) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchable]);

  const { drag, onPointerDown, registerCard, setPreviewEl, consumeClickSuppression } = useLibraryDrag({
    items,
    gridRef,
    onReorder,
    onCommit: onReorderCommit,
  });

  const move = useCallback(
    (entry: Entry, step: number) => {
      const from = items.findIndex((e) => e.url === entry.url);
      const to = from + step;
      if (from < 0 || to < 0 || to >= items.length) return;
      const next = [...items];
      next.splice(to, 0, next.splice(from, 1)[0]!);
      onReorder(next);
      onReorderCommit(next);
      setStatus(`${entry.title || entry.url}: позиция ${to + 1} из ${items.length}`);
    },
    [items, onReorder, onReorderCommit],
  );

  const onCardKeyDown = useCallback(
    (ev: React.KeyboardEvent, entry: Entry) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onOpen(entry);
        return;
      }
      if ((!ev.ctrlKey && !ev.metaKey) || filtering) return;
      const grid = gridRef.current;
      const columns = grid
        ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
        : 1;
      const step =
        ev.key === "ArrowLeft" ? -1
        : ev.key === "ArrowRight" ? 1
        : ev.key === "ArrowUp" ? -columns
        : ev.key === "ArrowDown" ? columns
        : 0;
      if (step === 0) return;
      ev.preventDefault();
      move(entry, step);
    },
    [move, onOpen, filtering],
  );

  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="mark" />
        <h2>Пока пусто</h2>
        <p>
          Скопируйте адрес страницы тайтла на animejoya.ru и нажмите <kbd>Ctrl</kbd>+<kbd>V</kbd> —
          обложка и список серий подтянутся сами.
        </p>
        <button className="primary" onClick={onAdd}>
          <Plus /> Вставить ссылку
        </button>
      </div>
    );
  }

  return (
    <>
      {searchable && (
        <div className="lib-bar">
          <label className="search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Поиск по библиотеке"
              aria-keyshortcuts="/ Control+F"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                } else if (e.key === "Enter" && shown.length === 1) {
                  onOpen(shown[0]!);
                }
              }}
            />
            {query ? (
              <button type="button" className="clear" title="Очистить" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>
          <span className="count">
            {filtering
              ? `${shown.length} из ${items.length} · порядок меняется без фильтра`
              : `${items.length} в библиотеке · карточки можно перетаскивать`}
          </span>
        </div>
      )}

      {filtering && shown.length === 0 && (
        <p className="hint nothing">Ничего не нашлось по запросу «{query.trim()}»</p>
      )}

      <div className={`grid${searchable ? " tight" : ""}`} ref={gridRef}>
        {shown.map((e) => (
          <motion.div
            key={e.url}
            ref={registerCard(e.url)}
            layout="position"
            transition={{ layout: LAYOUT_SPRING }}
            className={`card${drag?.item.url === e.url ? " placeholder" : ""}`}
            role="button"
            tabIndex={0}
            aria-keyshortcuts={MOVE_KEYS}
            onPointerDown={(ev) => {
              if (!filtering) onPointerDown(ev, e);
            }}
            onClick={() => {
              if (!consumeClickSuppression()) onOpen(e);
            }}
            onKeyDown={(ev) => onCardKeyDown(ev, e)}
          >
            <CardBody entry={e} onRemove={onRemove} />
          </motion.div>
        ))}
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      {drag &&
        createPortal(
          <div ref={setPreviewEl} className="drag-preview" style={{ width: drag.width }} aria-hidden>
            <div className="card floating">
              <CardBody entry={drag.item} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default memo(Library);
