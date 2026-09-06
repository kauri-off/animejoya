import { memo, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Entry } from "../api";
import { Plus, X } from "../icons";
import { useLibraryDrag } from "./useLibraryDrag";

const LAYOUT_SPRING = { type: "spring" as const, stiffness: 320, damping: 30, mass: 0.8 };
const MOVE_KEYS = "Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown";

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
        {entry.watched.length > 0 && <div className="badge">{entry.watched.length} просм.</div>}
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
  const [status, setStatus] = useState("");

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
      if (!ev.ctrlKey && !ev.metaKey) return;
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
    [move, onOpen],
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
      <div className="grid" ref={gridRef}>
        {items.map((e) => (
          <motion.div
            key={e.url}
            ref={registerCard(e.url)}
            layout="position"
            transition={{ layout: LAYOUT_SPRING }}
            className={`card${drag?.item.url === e.url ? " placeholder" : ""}`}
            role="button"
            tabIndex={0}
            aria-keyshortcuts={MOVE_KEYS}
            onPointerDown={(ev) => onPointerDown(ev, e)}
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
