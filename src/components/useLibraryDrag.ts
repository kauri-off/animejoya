import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entry } from "../api";

const MOUSE_THRESHOLD = 8;
const TOUCH_HOLD_MS = 260;
const TOUCH_HOLD_SLOP = 10;
const SLOT_HYSTERESIS = 24;
const EDGE_ZONE = 75;
const EDGE_OVERSHOOT = 20;
const SCROLL_MIN_SPEED = 2;
const SCROLL_MAX_SPEED = 14;
const DROP_MS = 200;
const DROP_EASE = "cubic-bezier(0.2, 0.9, 0.3, 1)";

export type DragState = {
  item: Entry;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
};

type Slot = { x: number; y: number; w: number; h: number; cx: number; cy: number };

const translate = (x: number, y: number) => `translate3d(${x}px, ${y}px, 0)`;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

export function useLibraryDrag({
  items,
  gridRef,
  onReorder,
  onCommit,
}: {
  items: Entry[];
  gridRef: React.RefObject<HTMLDivElement | null>;
  onReorder: (items: Entry[]) => void;
  onCommit: (items: Entry[]) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);

  const itemsRef = useRef(items);
  const cardsRef = useRef(new Map<string, HTMLElement>());
  const cardRefSetters = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotsRef = useRef<Slot[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const slotIndexRef = useRef(0);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const scrollSpeedRef = useRef(0);
  const rafRef = useRef(0);
  const dropTimerRef = useRef(0);
  const pendingCommitRef = useRef<(() => void) | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const releaseRef = useRef<(() => void) | null>(null);

  const registerCard = useCallback((url: string) => {
    let fn = cardRefSetters.current.get(url);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) cardsRef.current.set(url, el);
        else {
          cardsRef.current.delete(url);
          cardRefSetters.current.delete(url);
        }
      };
      cardRefSetters.current.set(url, fn);
    }
    return fn;
  }, []);

  // offset* даёт позицию, в которую карточка встала по вёрстке, без учёта transform от layout-анимации
  const measureSlots = useCallback(() => {
    if (!gridRef.current) return;
    const measured: Slot[] = [];
    for (const e of itemsRef.current) {
      const el = cardsRef.current.get(e.url);
      if (!el) return;
      const { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h } = el;
      measured.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
    }
    slotsRef.current = measured;
  }, [gridRef]);

  const hitTest = useCallback(
    (clientX: number, clientY: number) => {
      const d = dragRef.current;
      const grid = gridRef.current;
      const slots = slotsRef.current;
      if (!d || !grid || slots.length === 0) return;

      const gr = grid.getBoundingClientRect();
      const cx = clientX - d.offsetX - gr.left + d.width / 2;
      const cy = clientY - d.offsetY - gr.top + d.height / 2;

      let best = slotIndexRef.current;
      let bestDist = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        const dist = Math.hypot(s.cx - cx, s.cy - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }

      const current = slotIndexRef.current;
      if (best === current) return;

      const currentSlot = slots[current];
      const currentDist = currentSlot
        ? Math.hypot(currentSlot.cx - cx, currentSlot.cy - cy)
        : Infinity;
      const candidate = slots[best]!;
      const inside =
        cx >= candidate.x &&
        cx <= candidate.x + candidate.w &&
        cy >= candidate.y &&
        cy <= candidate.y + candidate.h;
      if (!inside && bestDist >= currentDist - SLOT_HYSTERESIS) return;

      slotIndexRef.current = best;
      const list = itemsRef.current;
      const from = list.findIndex((x) => x.url === d.item.url);
      if (from < 0 || from === best || best >= list.length) return;

      const next = [...list];
      next.splice(best, 0, next.splice(from, 1)[0]!);
      itemsRef.current = next;
      movedRef.current = true;
      onReorder(next);
    },
    [gridRef, onReorder],
  );

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    scrollSpeedRef.current = 0;
  }, []);

  const startAutoScroll = useCallback(() => {
    if (rafRef.current) return;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const el = scrollElRef.current;
      const speed = scrollSpeedRef.current;
      if (!el || speed === 0) return;
      const before = el.scrollTop;
      el.scrollTop = before + speed;
      if (el.scrollTop !== before) hitTest(pointerRef.current.x, pointerRef.current.y);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [hitTest]);

  const updateScrollSpeed = useCallback((clientY: number) => {
    const el = scrollElRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ramp = (over: number) => Math.max(SCROLL_MIN_SPEED, (over / EDGE_ZONE) * SCROLL_MAX_SPEED);
    if (clientY < r.top + EDGE_ZONE && clientY >= r.top - EDGE_OVERSHOOT) {
      scrollSpeedRef.current = -ramp(r.top + EDGE_ZONE - clientY);
    } else if (clientY > r.bottom - EDGE_ZONE && clientY <= r.bottom + EDGE_OVERSHOOT) {
      scrollSpeedRef.current = ramp(clientY - (r.bottom - EDGE_ZONE));
    } else {
      scrollSpeedRef.current = 0;
    }
  }, []);

  const flushDrop = useCallback(() => {
    if (dropTimerRef.current) clearTimeout(dropTimerRef.current);
    dropTimerRef.current = 0;
    const pending = pendingCommitRef.current;
    pendingCommitRef.current = null;
    pending?.();
  }, []);

  const animateDrop = useCallback(
    (item: Entry, moved: boolean) => {
      const commit = () => {
        dropTimerRef.current = 0;
        pendingCommitRef.current = null;
        dragRef.current = null;
        setDrag(null);
        if (moved) onCommit(itemsRef.current);
      };

      const preview = previewRef.current;
      const target = cardsRef.current.get(item.url);
      const grid = gridRef.current;
      if (!preview || !target || !grid) {
        commit();
        return;
      }

      const gr = grid.getBoundingClientRect();
      preview.style.transition = `transform ${DROP_MS}ms ${DROP_EASE}`;
      preview.style.transform = translate(gr.left + target.offsetLeft, gr.top + target.offsetTop);

      const card = preview.firstElementChild as HTMLElement | null;
      if (card) {
        card.style.transition = `transform ${DROP_MS}ms ${DROP_EASE}, filter ${DROP_MS}ms ease`;
        card.style.transform = "none";
        card.style.filter = "none";
      }

      pendingCommitRef.current = commit;
      dropTimerRef.current = window.setTimeout(commit, DROP_MS);
    },
    [gridRef, onCommit],
  );

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLElement>, item: Entry) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest("button")) return;
      flushDrop();
      if (dragRef.current || releaseRef.current) return;

      suppressClickRef.current = false;
      movedRef.current = false;

      const rect = ev.currentTarget.getBoundingClientRect();
      const pointerId = ev.pointerId;
      const touch = ev.pointerType === "touch";
      const startX = ev.clientX;
      const startY = ev.clientY;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;
      const width = rect.width;
      const height = rect.height;
      const orderAtStart = itemsRef.current;

      pointerRef.current = { x: startX, y: startY };

      let started = false;
      let holdTimer = 0;

      function blockTouchScroll(e: TouchEvent) {
        e.preventDefault();
      }

      function blockContextMenu(e: Event) {
        e.preventDefault();
      }

      function teardown() {
        releaseRef.current = null;
        stopAutoScroll();
        scrollElRef.current = null;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = 0;
        document.body.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("touchmove", blockTouchScroll);
        window.removeEventListener("contextmenu", blockContextMenu);
      }

      function begin(x: number, y: number) {
        if (started) return;
        started = true;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = 0;

        measureSlots();
        const idx = itemsRef.current.findIndex((e) => e.url === item.url);
        slotIndexRef.current = idx >= 0 ? idx : 0;
        scrollElRef.current = scrollParent(gridRef.current);

        const state: DragState = { item, width, height, offsetX, offsetY, x, y };
        dragRef.current = state;
        setDrag(state);
        document.body.classList.add("is-dragging");

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("contextmenu", blockContextMenu);
        // touch-action: pan-y отдал бы жест браузеру — отменяем скролл, пока он ещё не начался
        if (touch) window.addEventListener("touchmove", blockTouchScroll, { passive: false });
        startAutoScroll();
      }

      function onMove(e: PointerEvent) {
        if (e.pointerId !== pointerId) return;
        const x = e.clientX;
        const y = e.clientY;
        pointerRef.current = { x, y };

        if (!started) {
          const dist = Math.hypot(x - startX, y - startY);
          if (touch) {
            if (dist > TOUCH_HOLD_SLOP) teardown();
          } else if (dist >= MOUSE_THRESHOLD) {
            begin(x, y);
          }
          return;
        }

        if (previewRef.current) previewRef.current.style.transform = translate(x - offsetX, y - offsetY);
        updateScrollSpeed(y);
        hitTest(x, y);
      }

      function onUp(e: PointerEvent) {
        if (e.pointerId !== pointerId) return;
        teardown();
        if (!started) return;
        suppressClickRef.current = true;
        animateDrop(item, movedRef.current);
      }

      function abort() {
        teardown();
        if (!started) return;
        suppressClickRef.current = true;
        dragRef.current = null;
        setDrag(null);
        if (movedRef.current) {
          itemsRef.current = orderAtStart;
          onReorder(orderAtStart);
        }
        movedRef.current = false;
      }

      function onCancel(e: PointerEvent) {
        if (e.pointerId !== pointerId) return;
        abort();
      }

      function onKeyDown(e: KeyboardEvent) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        abort();
      }

      releaseRef.current = teardown;
      if (touch) holdTimer = window.setTimeout(() => begin(pointerRef.current.x, pointerRef.current.y), TOUCH_HOLD_MS);

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [
      animateDrop,
      flushDrop,
      gridRef,
      hitTest,
      measureSlots,
      onReorder,
      startAutoScroll,
      stopAutoScroll,
      updateScrollSpeed,
    ],
  );

  const setPreviewEl = useCallback((el: HTMLDivElement | null) => {
    previewRef.current = el;
    const d = dragRef.current;
    if (el && d) el.style.transform = translate(d.x - d.offsetX, d.y - d.offsetY);
  }, []);

  const consumeClickSuppression = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  useLayoutEffect(() => {
    itemsRef.current = items;
    const d = dragRef.current;
    if (!d) return;
    measureSlots();
    const fresh = items.find((e) => e.url === d.item.url);
    if (fresh && fresh !== d.item) {
      dragRef.current = { ...d, item: fresh };
      setDrag(dragRef.current);
    }
  }, [items, measureSlots]);

  useEffect(() => {
    const onResize = () => {
      if (dragRef.current) measureSlots();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureSlots]);

  useEffect(
    () => () => {
      releaseRef.current?.();
      flushDrop();
      stopAutoScroll();
      document.body.classList.remove("is-dragging");
    },
    [flushDrop, stopAutoScroll],
  );

  return { drag, onPointerDown, registerCard, setPreviewEl, consumeClickSuppression };
}
