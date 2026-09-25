import { useState } from "react";
import { motion } from "motion/react";
import type { Settings } from "../api";

const spring = { type: "spring" as const, stiffness: 460, damping: 36 };

function Veil({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <motion.div
      className="veil"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="sheet"
        initial={{ opacity: 0, y: 22, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.15 } }}
        transition={spring}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function AddSheet({
  busy,
  error,
  initial,
  onClose,
  onSubmit,
  onSettings,
}: {
  busy: boolean;
  error: string | null;
  initial: string;
  onClose: () => void;
  onSubmit: (url: string) => void;
  onSettings?: () => void;
}) {
  const [url, setUrl] = useState(initial);
  return (
    <Veil onClose={onClose}>
      <h2>Новый тайтл</h2>
      <p className="sub">
        Откройте тайтл на animejoya.ru, скопируйте адрес страницы и вставьте сюда. Подойдут и
        зеркала сайта.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onSubmit(url.trim());
        }}
      >
        <label className="field">
          <input
            autoFocus
            value={url}
            placeholder="https://animejoya.ru/tv-serialy/…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        {error && (
          <div className="error">
            {error}
            {onSettings && (
              <button type="button" className="link" onClick={onSettings}>
                Открыть настройки
              </button>
            )}
          </div>
        )}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !url.trim()}>
            {busy ? <span className="spin" /> : null}
            {busy ? "Загружаю" : "Добавить"}
          </button>
        </div>
      </form>
    </Veil>
  );
}

export function SettingsSheet({
  value,
  onClose,
  onSave,
}: {
  value: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const [s, setS] = useState(value);
  const set = (patch: Partial<Settings>) => setS((old) => ({ ...old, ...patch }));
  return (
    <Veil onClose={onClose}>
      <h2>Настройки</h2>
      <p className="sub">Логин нужен, чтобы сайт отдал плейлист</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(s);
        }}
      >
        <label className="field">
          <span>Логин</span>
          <input value={s.username} onChange={(e) => set({ username: e.target.value })} />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input
            type="password"
            value={s.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.preloadNext}
            onChange={(e) => set({ preloadNext: e.target.checked })}
          />
          <span>Заранее загружать следующую серию во время просмотра</span>
        </label>
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="primary">Сохранить</button>
        </div>
      </form>
    </Veil>
  );
}

const SHORTCUTS: [string, [string[], string][]][] = [
  [
    "Библиотека",
    [
      [["Ctrl", "V"], "добавить тайтл по ссылке из буфера"],
      [["/"], "поиск по библиотеке"],
      [["Ctrl", "←→↑↓"], "сдвинуть выбранную карточку"],
      [["Enter"], "открыть выбранную карточку"],
    ],
  ],
  [
    "Тайтл и плеер",
    [
      [["Esc"], "закрыть плеер, затем вернуться в библиотеку"],
      [["Shift", "N"], "следующая серия"],
      [["Shift", "P"], "предыдущая серия"],
      [["Space"], "пауза / воспроизведение"],
      [["F"], "во весь экран"],
      [["←", "→"], "перемотка"],
    ],
  ],
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <Veil onClose={onClose}>
      <h2>Горячие клавиши</h2>
      <p className="sub">Двойной клик по серии сразу запускает её, серия отмечается просмотренной ближе к концу</p>
      {SHORTCUTS.map(([group, keys]) => (
        <div className="keys" key={group}>
          <h3>{group}</h3>
          {keys.map(([combo, label]) => (
            <div className="key" key={label}>
              <span>
                {combo.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              {label}
            </div>
          ))}
        </div>
      ))}
      <div className="buttons">
        <button type="button" className="primary" onClick={onClose}>
          Понятно
        </button>
      </div>
    </Veil>
  );
}
