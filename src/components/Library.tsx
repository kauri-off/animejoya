import { memo } from "react";
import type { Entry } from "../api";
import { Plus, X } from "../icons";

function Library({
  items,
  onOpen,
  onRemove,
  onAdd,
}: {
  items: Entry[];
  onOpen: (e: Entry) => void;
  onRemove: (e: Entry) => void;
  onAdd: () => void;
}) {
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
    <div className="grid">
      {items.map((e) => (
        <div
          key={e.url}
          className="card"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(e)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onOpen(e);
            }
          }}
        >
          <div className="poster">
            {e.poster ? (
              <img src={e.poster} alt="" draggable={false} loading="lazy" decoding="async" />
            ) : (
              <div className="blank">
                <span>{(e.title || "?").trim().charAt(0)}</span>
              </div>
            )}
            {e.watched.length > 0 && <div className="badge">{e.watched.length} просм.</div>}
            <button
              type="button"
              className="kill"
              aria-label="Удалить из библиотеки"
              title="Удалить из библиотеки"
              onClick={(ev) => {
                ev.stopPropagation();
                onRemove(e);
              }}
            >
              <X size={13} />
            </button>
          </div>
          <div className="name">{e.title || e.url}</div>
          {e.original && <div className="sub">{e.original}</div>}
        </div>
      ))}
    </div>
  );
}

export default memo(Library);
