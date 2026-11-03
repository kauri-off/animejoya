import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Plus, Search, X } from "lucide-react";
import type { Entry } from "../api";
import { DROP_EASE, SPRING, skipFadeIfCached } from "../motion";

const DROP = { duration: 200, easing: DROP_EASE };
const MOVE_KEYS = "Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown";
const SEARCH_FROM = 6;
const MOUSE_THRESHOLD = 8;
const TOUCH_HOLD_MS = 260;
const TOUCH_HOLD_SLOP = 10;

// Каскад появления карточек — только при первом показе за сессию, дальше библиотека открывается сразу.
let introPlayed = false;
const INTRO_MS = 900;

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
          <img ref={skipFadeIfCached} src={entry.poster} alt="" draggable={false} loading="lazy" decoding="async" />
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
            onMouseDown={(ev) => ev.stopPropagation()}
            onTouchStart={(ev) => ev.stopPropagation()}
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

function SortableCard({
  entry,
  index,
  disabled,
  layoutKey,
  onOpen,
  onRemove,
  onKeyDown,
}: {
  entry: Entry;
  index: number;
  disabled: boolean;
  layoutKey: unknown;
  onOpen: (e: Entry) => void;
  onRemove: (e: Entry) => void;
  onKeyDown: (ev: React.KeyboardEvent, e: Entry) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: entry.url, disabled });
  return (
    // Раскладку при удалении и Ctrl+стрелках анимирует motion, во время перетаскивания — dnd-kit.
    <motion.div layout="position" layoutDependency={layoutKey} transition={{ layout: SPRING.layout }}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition, "--i": index } as React.CSSProperties}
        className={`card${isDragging ? " placeholder" : ""}`}
        role="button"
        tabIndex={0}
        aria-keyshortcuts={MOVE_KEYS}
        {...listeners}
        onClick={() => onOpen(entry)}
        onKeyDown={(ev) => onKeyDown(ev, entry)}
      >
        <CardBody entry={entry} onRemove={onRemove} />
      </div>
    </motion.div>
  );
}

function Library({
  items,
  onOpen,
  onRemove,
  onAdd,
  onReorder,
}: {
  items: Entry[];
  onOpen: (e: Entry) => void;
  onRemove: (e: Entry) => void;
  onAdd: () => void;
  onReorder: (items: Entry[]) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Entry | null>(null);
  const [intro, setIntro] = useState(!introPlayed);

  useEffect(() => {
    if (!intro || items.length === 0) return;
    introPlayed = true;
    const t = setTimeout(() => setIntro(false), INTRO_MS);
    return () => clearTimeout(t);
  }, [intro, items.length]);

  const shown = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return items;
    return items.filter((e) => norm(`${e.title} ${e.original}`).includes(q));
  }, [items, query]);
  const filtering = shown !== items;
  const searchable = items.length >= SEARCH_FROM || query !== "";

  // Пока тянем и в кадре сброса motion не трогает раскладку: карточки уже стоят там, куда их сдвинул dnd-kit.
  const dropped = useRef(false);
  const layoutKey = useRef<unknown>(shown);
  if (active === null && !dropped.current) layoutKey.current = shown;
  useEffect(() => {
    dropped.current = false;
  });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: MOUSE_THRESHOLD } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_SLOP } }),
  );

  const nameOf = useCallback(
    (id: UniqueIdentifier) => {
      const e = items.find((x) => x.url === id);
      return e?.title || String(id);
    },
    [items],
  );
  const posOf = useCallback((id: UniqueIdentifier) => items.findIndex((x) => x.url === id) + 1, [items]);

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) => `«${nameOf(active.id)}» взята`,
      onDragOver: ({ over }) => (over ? `позиция ${posOf(over.id)} из ${items.length}` : undefined),
      onDragEnd: ({ active, over }) =>
        over ? `«${nameOf(active.id)}»: позиция ${posOf(over.id)} из ${items.length}` : undefined,
      onDragCancel: ({ active }) => `«${nameOf(active.id)}» осталась на месте`,
    }),
    [nameOf, posOf, items.length],
  );

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

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      setActive(items.find((e) => e.url === active.id) ?? null);
      document.body.classList.add("is-dragging");
    },
    [items],
  );

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      document.body.classList.remove("is-dragging");
      setActive(null);
      if (!over || over.id === active.id) return;
      const from = items.findIndex((e) => e.url === active.id);
      const to = items.findIndex((e) => e.url === over.id);
      if (from < 0 || to < 0) return;
      dropped.current = true;
      onReorder(arrayMove(items, from, to));
    },
    [items, onReorder],
  );

  const onDragCancel = useCallback(() => {
    document.body.classList.remove("is-dragging");
    setActive(null);
  }, []);

  useEffect(() => () => document.body.classList.remove("is-dragging"), []);

  const move = useCallback(
    (entry: Entry, step: number) => {
      const from = items.findIndex((e) => e.url === entry.url);
      const to = from + step;
      if (from < 0 || to < 0 || to >= items.length) return;
      onReorder(arrayMove(items, from, to));
      setStatus(`${entry.title || entry.url}: позиция ${to + 1} из ${items.length}`);
    },
    [items, onReorder],
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={shown.map((e) => e.url)} strategy={rectSortingStrategy} disabled={filtering}>
          <div className={`grid${searchable ? " tight" : ""}${intro ? " intro" : ""}`} ref={gridRef}>
            {shown.map((e, i) => (
              <SortableCard
                key={e.url}
                entry={e}
                index={i}
                disabled={filtering}
                layoutKey={layoutKey.current}
                onOpen={onOpen}
                onRemove={onRemove}
                onKeyDown={onCardKeyDown}
              />
            ))}
          </div>
        </SortableContext>
        {createPortal(
          <DragOverlay dropAnimation={DROP} className="drag-preview">
            {active && (
              <div className="card floating">
                <CardBody entry={active} />
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
    </>
  );
}

export default memo(Library);
