import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Entry } from "../api";
import { Plus, X } from "../icons";

type ActiveDrag = {
  item: Entry;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
};

type SlotGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
};

const SPRING_CONFIG = {
  type: "spring" as const,
  stiffness: 320,
  damping: 30,
  mass: 0.8,
};

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
  onReorder?: (items: Entry[]) => void;
}) {
  const [localItems, setLocalItems] = useState(items);
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const localItemsRef = useRef(items);
  const originalItemsRef = useRef(items);
  const isDraggingRef = useRef(false);
  const isDroppingRef = useRef(false);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const currentSlotIndexRef = useRef(0);
  const hasReorderedRef = useRef(false);
  const dragEndedAtRef = useRef(0);

  const slotsRef = useRef<SlotGeometry[]>([]);
  const holdTimerRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollSpeedRef = useRef(0);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const previewElRef = useRef<HTMLDivElement | null>(null);

  // Sync with prop when idle
  useEffect(() => {
    if (!isDraggingRef.current && !isDroppingRef.current) {
      setLocalItems(items);
      localItemsRef.current = items;
      originalItemsRef.current = items;
    }
  }, [items]);

  // Clean up body class, timers, and animation frames on unmount
  useEffect(() => {
    return () => {
      document.body.classList.remove("is-dragging");
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const checkSlotHover = useCallback((clientX: number, clientY: number) => {
    const currentDrag = activeDragRef.current;
    const gridEl = gridRef.current;
    if (!currentDrag || !gridEl) return;

    const slots = slotsRef.current;
    if (slots.length === 0) return;

    const gridRect = gridEl.getBoundingClientRect();
    const cardLeft = clientX - currentDrag.offsetX;
    const cardTop = clientY - currentDrag.offsetY;
    const dragCenterX = cardLeft - gridRect.left + currentDrag.width / 2;
    const dragCenterY = cardTop - gridRect.top + currentDrag.height / 2;

    const currentSlotIdx = currentSlotIndexRef.current;
    let bestIdx = currentSlotIdx;
    let bestDist = Infinity;

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      const dist = Math.hypot(s.cx - dragCenterX, s.cy - dragCenterY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx !== currentSlotIdx) {
      const currentSlot = slots[currentSlotIdx];
      const currentDist = currentSlot
        ? Math.hypot(currentSlot.cx - dragCenterX, currentSlot.cy - dragCenterY)
        : Infinity;

      const candidateSlot = slots[bestIdx]!;
      const insideCandidate =
        dragCenterX >= candidateSlot.x &&
        dragCenterX <= candidateSlot.x + candidateSlot.width &&
        dragCenterY >= candidateSlot.y &&
        dragCenterY <= candidateSlot.y + candidateSlot.height;

      // Hysteresis deadzone: requires moving 24px closer to candidate than current slot, or being inside candidate
      if (insideCandidate || bestDist < currentDist - 24) {
        currentSlotIndexRef.current = bestIdx;

        const list = localItemsRef.current;
        const fromIndex = list.findIndex((x) => x.url === currentDrag.item.url);
        if (fromIndex >= 0 && fromIndex !== bestIdx && bestIdx < list.length) {
          hasReorderedRef.current = true;
          const next = [...list];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(bestIdx, 0, moved!);
          localItemsRef.current = next;
          setLocalItems(next);
        }
      }
    }
  }, []);

  const startAutoScroll = useCallback(() => {
    const scrollLoop = () => {
      if (!isDraggingRef.current) return;
      const speed = scrollSpeedRef.current;
      if (speed !== 0) {
        const scrollEl = document.querySelector(".scroll") as HTMLElement | null;
        if (scrollEl) {
          scrollEl.scrollTop += speed;
          checkSlotHover(lastPointerRef.current.x, lastPointerRef.current.y);
        }
      }
      scrollRafRef.current = requestAnimationFrame(scrollLoop);
    };
    scrollRafRef.current = requestAnimationFrame(scrollLoop);
  }, [checkSlotHover]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, item: Entry) => {
      if (e.button !== 0 || isDroppingRef.current) return;
      if ((e.target as HTMLElement).closest(".kill")) return;

      const card = e.currentTarget;
      const cardRect = card.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const offsetX = startX - cardRect.left;
      const offsetY = startY - cardRect.top;
      const width = cardRect.width;
      const height = cardRect.height;

      originalItemsRef.current = localItemsRef.current;
      hasReorderedRef.current = false;
      lastPointerRef.current = { x: startX, y: startY };

      let started = false;

      const startDrag = (currX: number, currY: number) => {
        if (started) return;
        started = true;
        isDraggingRef.current = true;

        // Snapshot slot geometry relative to grid container
        const gridEl = gridRef.current;
        if (gridEl) {
          const gridRect = gridEl.getBoundingClientRect();
          const cardEls = Array.from(gridEl.querySelectorAll<HTMLElement>(".card[data-url]"));
          slotsRef.current = cardEls.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              x: r.left - gridRect.left,
              y: r.top - gridRect.top,
              width: r.width,
              height: r.height,
              cx: r.left - gridRect.left + r.width / 2,
              cy: r.top - gridRect.top + r.height / 2,
            };
          });
        }

        const initialSlotIndex = localItemsRef.current.findIndex((x) => x.url === item.url);
        currentSlotIndexRef.current = initialSlotIndex >= 0 ? initialSlotIndex : 0;

        const dragInfo: ActiveDrag = {
          item,
          width,
          height,
          offsetX,
          offsetY,
          startX: currX,
          startY: currY,
        };
        activeDragRef.current = dragInfo;
        setActiveDrag(dragInfo);
        document.body.classList.add("is-dragging");

        startAutoScroll();
      };

      // Press and hold timer: 160ms hold engages drag
      holdTimerRef.current = window.setTimeout(() => {
        startDrag(lastPointerRef.current.x, lastPointerRef.current.y);
      }, 160);

      const onPointerMove = (moveEv: PointerEvent) => {
        const currX = moveEv.clientX;
        const currY = moveEv.clientY;
        lastPointerRef.current = { x: currX, y: currY };

        if (!started) {
          const dist = Math.hypot(currX - startX, currY - startY);
          if (dist > 4) {
            if (holdTimerRef.current) {
              clearTimeout(holdTimerRef.current);
              holdTimerRef.current = null;
            }
            startDrag(currX, currY);
          }
        }

        if (started) {
          if (previewElRef.current) {
            previewElRef.current.style.transform = `translate3d(${currX - offsetX}px, ${currY - offsetY}px, 0)`;
          }

          // Container auto-scroll detection
          const scrollEl = document.querySelector(".scroll") as HTMLElement | null;
          if (scrollEl) {
            const sRect = scrollEl.getBoundingClientRect();
            const edgeZone = 75;
            const maxSpeed = 14;

            if (currY < sRect.top + edgeZone && currY >= sRect.top - 20) {
              const intensity = (sRect.top + edgeZone - currY) / edgeZone;
              scrollSpeedRef.current = -Math.max(2, intensity * maxSpeed);
            } else if (currY > sRect.bottom - edgeZone && currY <= sRect.bottom + 20) {
              const intensity = (currY - (sRect.bottom - edgeZone)) / edgeZone;
              scrollSpeedRef.current = Math.max(2, intensity * maxSpeed);
            } else {
              scrollSpeedRef.current = 0;
            }
          }

          checkSlotHover(currX, currY);
        }
      };

      const cleanupListeners = () => {
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        if (scrollRafRef.current) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
        scrollSpeedRef.current = 0;
        document.body.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("keydown", onKeyDown);
      };

      const onPointerUp = () => {
        cleanupListeners();

        if (started) {
          dragEndedAtRef.current = Date.now();
          isDraggingRef.current = false;

          // Perform fluid drop animation to the destination placeholder card
          const gridEl = gridRef.current;
          const placeholderEl = gridEl?.querySelector<HTMLElement>(`.card[data-url="${item.url}"]`);
          const previewEl = previewElRef.current;

          if (placeholderEl && previewEl) {
            isDroppingRef.current = true;
            const destRect = placeholderEl.getBoundingClientRect();

            previewEl.style.transition = "transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1)";
            previewEl.style.transform = `translate3d(${destRect.left}px, ${destRect.top}px, 0)`;

            const innerCard = previewEl.querySelector<HTMLElement>(".card.floating");
            if (innerCard) {
              innerCard.style.transition = "transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1), filter 0.2s ease";
              innerCard.style.transform = "scale(1)";
              innerCard.style.filter = "none";
            }

            window.setTimeout(() => {
              isDroppingRef.current = false;
              activeDragRef.current = null;
              setActiveDrag(null);
              if (hasReorderedRef.current) {
                onReorder?.(localItemsRef.current);
              }
            }, 200);
          } else {
            activeDragRef.current = null;
            setActiveDrag(null);
            if (hasReorderedRef.current) {
              onReorder?.(localItemsRef.current);
            }
          }
        } else {
          isDraggingRef.current = false;
          activeDragRef.current = null;
          setActiveDrag(null);
        }
      };

      const onPointerCancel = () => {
        cleanupListeners();
        isDraggingRef.current = false;
        activeDragRef.current = null;
        setActiveDrag(null);
        if (hasReorderedRef.current) {
          setLocalItems(originalItemsRef.current);
          localItemsRef.current = originalItemsRef.current;
        }
      };

      const onKeyDown = (keyEv: KeyboardEvent) => {
        if (keyEv.key === "Escape") {
          keyEv.preventDefault();
          keyEv.stopPropagation();
          onPointerCancel();
        }
      };

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
    },
    [checkSlotHover, onReorder, startAutoScroll],
  );

  const handleClick = useCallback(
    (e: Entry) => {
      if (Date.now() - dragEndedAtRef.current < 180) return;
      onOpen(e);
    },
    [onOpen],
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
        {localItems.map((e) => {
          const isPlaceholder = activeDrag?.item.url === e.url;
          return (
            <motion.div
              layout="position"
              transition={{ layout: SPRING_CONFIG }}
              key={e.url}
              data-url={e.url}
              className={`card${isPlaceholder ? " placeholder" : ""}`}
              role="button"
              tabIndex={0}
              onPointerDown={(ev) => handlePointerDown(ev, e)}
              onClick={() => handleClick(e)}
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
                  onPointerDown={(ev) => ev.stopPropagation()}
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
            </motion.div>
          );
        })}
      </div>

      {activeDrag &&
        createPortal(
          <div
            ref={previewElRef}
            className="drag-floating-card"
            style={{
              width: activeDrag.width,
              transform: `translate3d(${activeDrag.startX - activeDrag.offsetX}px, ${activeDrag.startY - activeDrag.offsetY}px, 0)`,
            }}
          >
            <div className="card floating">
              <div className="poster">
                {activeDrag.item.poster ? (
                  <img src={activeDrag.item.poster} alt="" draggable={false} />
                ) : (
                  <div className="blank">
                    <span>{(activeDrag.item.title || "?").trim().charAt(0)}</span>
                  </div>
                )}
                {activeDrag.item.watched.length > 0 && (
                  <div className="badge">{activeDrag.item.watched.length} просм.</div>
                )}
              </div>
              <div className="name">{activeDrag.item.title || activeDrag.item.url}</div>
              {activeDrag.item.original && <div className="sub">{activeDrag.item.original}</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default memo(Library);
