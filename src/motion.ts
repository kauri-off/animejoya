// Повторяет --ease из styles.css.
export const EASE = [0.22, 1, 0.36, 1] as const;

export const SPRING = {
  pop: { type: "spring" as const, stiffness: 500, damping: 36 },
  panel: { type: "spring" as const, stiffness: 420, damping: 34 },
  layout: { type: "spring" as const, stiffness: 320, damping: 30, mass: 0.8 },
};

// Совпадает с кривой брошенной карточки в dnd-kit.
export const DROP_EASE = "cubic-bezier(0.2, 0.9, 0.3, 1)";

// Картинка из кэша уже готова к первому кадру — проявлять её незачем.
export const skipFadeIfCached = (img: HTMLImageElement | null) => {
  if (img?.complete) img.style.animation = "none";
};

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
