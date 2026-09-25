import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  api,
  media,
  on,
  saveAs,
  type Entry,
  type Episode,
  type Progress,
  type Settings,
  type Title,
} from "./api";
import Library from "./components/Library";
import TitleScreen, { type Actions } from "./components/TitleScreen";
import Queue from "./components/Queue";
import { AddSheet, HelpSheet, SettingsSheet } from "./components/Sheets";
import { Back, ExternalLink, Gear, Keyboard, Plus, Refresh } from "./icons";

type Action = { label: string; run: () => void };
type Toast = { id: number; text: string; bad?: boolean; action?: Action };
type Sheet = "add" | "settings" | "help" | null;

const needsLogin = (text: string) => text.includes("нужен вход");
const titleFromHash = () => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "сайте";
  }
};

const page = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
};

export default function App() {
  const [library, setLibrary] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState<Title | null>(null);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<Record<string, Progress>>({});
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [syncing, setSyncing] = useState(0);
  const seq = useRef(0);
  const libRef = useRef(library);
  libRef.current = library;
  const openUrl = useRef<string | null>(null);
  openUrl.current = open?.entry.url ?? null;

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (text: string, bad = false, action?: Action) => {
      const id = ++seq.current;
      setToasts((t) => [...t, { id, text, bad, action }]);
      setTimeout(() => dismiss(id), bad || action ? 6000 : 3200);
    },
    [dismiss],
  );

  const fail = useCallback(
    (e: unknown) => {
      const text = String(e);
      toast(text, true, needsLogin(text) ? { label: "Настройки", run: () => setSheet("settings") } : undefined);
    },
    [toast],
  );

  useEffect(() => {
    api
      .libraryGet()
      .then((lib) => {
        setLibrary(lib);
        // Записи из старого links.json приходят без обложек — догружаем их фоном.
        return api.librarySync(false);
      })
      .catch((e) => toast(String(e), true));
    api.settingsGet().then(setSettings).catch(() => {});
  }, [toast]);

  useEffect(() => {
    const drop = (id: string) => setJobs((j) => Object.fromEntries(Object.entries(j).filter(([k]) => k !== id)));
    const uns = [
      on.progress((p) => setJobs((j) => ({ ...j, [p.id]: p }))),
      on.done(({ id, file }) => {
        drop(id);
        setOpen((t) => (t ? markFile(t, file) : t));
      }),
      on.failed(({ id, message }) => {
        drop(id);
        if (!message.includes("отменена")) toast(message, true);
      }),
      on.entry((entry) =>
        setLibrary((lib) => lib.map((e) => (e.url === entry.url ? entry : e))),
      ),
      on.syncing(setSyncing),
    ];
    return () => {
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [toast]);

  // Тайтл живёт в адресе: работают «Назад» браузера/мыши и F5.
  const load = useCallback(
    async (url: string, push = true) => {
      setLoading(true);
      try {
        const data = await api.titleOpen(url);
        setOpen(data);
        if (push && history.state?.title !== data.entry.url) {
          history.pushState({ title: data.entry.url }, "", `#${encodeURIComponent(data.entry.url)}`);
        }
        setLibrary(await api.libraryGet());
      } catch (e) {
        fail(e);
        setOpen(null);
        if (history.state?.title) history.replaceState(null, "", location.pathname);
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  const close = useCallback(() => {
    if (history.state?.title) history.back();
    else setOpen(null);
  }, []);

  useEffect(() => {
    const initial = titleFromHash();
    if (initial) {
      history.replaceState(null, "", location.pathname);
      void load(initial);
    }
    const onPop = () => {
      const url: string | undefined = history.state?.title;
      if (!url) setOpen(null);
      else if (url !== openUrl.current) void load(url, false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  const openEntry = useCallback((e: Entry) => load(e.url), [load]);

  const removeEntry = useCallback(
    (e: Entry) => {
      const index = libRef.current.findIndex((x) => x.url === e.url);
      api.libraryRemove(e.url).then(() => {
        setLibrary((l) => l.filter((x) => x.url !== e.url));
        toast(`«${e.title || e.url}» убран из библиотеки`, false, {
          label: "Вернуть",
          run: () => api.libraryRestore(e, index).then(setLibrary, fail),
        });
      }, fail);
    },
    [toast, fail],
  );

  const reorderLibrary = useCallback((next: Entry[]) => setLibrary(next), []);

  const commitLibraryOrder = useCallback(
    (next: Entry[]) => {
      api
        .libraryReorder(next.map((e) => e.url))
        .then(setLibrary)
        .catch((e) => {
          toast(String(e), true);
          return api.libraryGet().then(setLibrary);
        })
        .catch(() => {});
    },
    [toast],
  );

  const openAdd = useCallback(() => {
    setDraft("");
    setAddError(null);
    setSheet("add");
  }, []);

  const add = useCallback(
    async (url: string) => {
      setAdding(true);
      setAddError(null);
      try {
        const entry = await api.libraryAdd(url);
        setLibrary(await api.libraryGet());
        setSheet(null);
        setDraft("");
        await load(entry.url);
      } catch (e) {
        setAddError(String(e));
      } finally {
        setAdding(false);
      }
    },
    [load],
  );

  // Ctrl+V в любом месте библиотеки = добавить тайтл по ссылке из буфера.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (sheet || open) return;
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (!/^https?:\/\/\S+\/\d+-[^/]*\.html?$/.test(text)) return;
      setDraft(text);
      setAddError(null);
      setSheet("add");
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "?" && !typing && !sheet) {
        setSheet("help");
        return;
      }
      if (e.key !== "Escape" || document.fullscreenElement) return;
      if (sheet) setSheet(null);
      else if (open) close();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [sheet, open, close]);

  const actions: Actions = {
    download: (ep, quality) => {
      const src = ep.sources.find((s) => s.quality === quality) ?? ep.sources[0];
      if (!open || (!ep.file && !src)) return;
      const q = ep.file ? (ep.file.split("-").pop()?.replace(/\.mp4$/, "") ?? quality) : src!.quality;
      const name = `${open.entry.title} — ${ep.title} [${q}].mp4`.replace(/[\\/:*?"<>|]/g, "_");
      saveAs(ep.file ? media.file(ep.file, name) : media.remote(src!, name));
    },
    preload: (ep, quality) => {
      const src = ep.sources.find((s) => s.quality === quality) ?? ep.sources[0];
      if (!src || !open || ep.file) return;
      api
        .preloadStart({
          pageUrl: open.entry.url,
          episode: ep.title,
          quality: src.quality,
          sourceUrl: src.url,
          referer: src.referer,
        })
        .then(
          (id) => setJobs((j) => (j[id] ? j : { ...j, [id]: { id, done: 0, total: 0, bytesPerSec: 0 } })),
          (e) => toast(String(e), true),
        );
    },
    dropCache: (ep) => {
      if (!ep.file) return;
      api.cacheDrop(ep.file).then(
        () => setOpen((t) => (t ? dropFile(t, ep.file!) : t)),
        (e) => toast(String(e), true),
      );
    },
    resolvePlayer: async (playerId) => {
      if (!open) return;
      try {
        const episodes = await api.playerResolve(open.entry.url, playerId);
        setOpen((t) =>
          t
            ? { ...t, players: t.players.map((p) => (p.id === playerId ? { ...p, episodes } : p)) }
            : t,
        );
      } catch (e) {
        toast(String(e), true);
      }
    },
    markWatched: (ep) => markWatched([ep], true),
    markUpTo: (eps) => {
      markWatched(eps, true);
      toast(`Отмечено серий: ${eps.length}`);
    },
    toggleWatched: (ep) => {
      if (!open) return;
      markWatched([ep], !open.entry.watched.includes(ep.title));
    },
    remember: (player, quality) => {
      if (open) api.rememberChoice(open.entry.url, player, quality).catch(() => {});
    },
  };

  function markWatched(eps: Episode[], watched: boolean) {
    if (!open) return;
    api.markWatched(open.entry.url, eps.map((e) => e.title), watched).then((list) => {
      setOpen((t) => (t ? { ...t, entry: { ...t.entry, watched: list } } : t));
      setLibrary((lib) =>
        lib.map((e) => (e.url === open.entry.url ? { ...e, watched: list } : e)),
      );
    }, fail);
  }

  return (
    <div className="app">
      <header className="topbar">
        {open ? (
          <button className="ghost" title="Библиотека (Esc)" onClick={close}>
            <Back size={15} /> <span className="wide">Библиотека</span>
          </button>
        ) : (
          <div className="brand">
            <i />
            AnimeJoy
          </div>
        )}

        <div className="spacer" />

        {open && (
          <>
            <a
              href={open.entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ghost"
              title={`Открыть на ${hostOf(open.entry.url)}`}
            >
              <ExternalLink size={15} />
            </a>
            <button className="ghost" title="Обновить" onClick={() => load(open.entry.url)}>
              <Refresh size={15} />
            </button>
          </>
        )}
        {!open && syncing > 0 && (
          <div className="sync">
            <span className="spin" /> <span className="wide">Обложки:</span> {syncing}
          </div>
        )}
        {!open && (
          <button className="primary" title="Добавить по ссылке" onClick={openAdd}>
            <Plus size={15} /> <span className="wide">Ссылка</span>
          </button>
        )}
        <Queue jobs={jobs} onCancel={(id) => api.preloadCancel(id)} />
        <button className="ghost desk" title="Горячие клавиши (?)" onClick={() => setSheet("help")}>
          <Keyboard size={16} />
        </button>
        <button className="ghost" title="Настройки" onClick={() => setSheet("settings")}>
          <Gear size={15} />
        </button>
      </header>

      <main className="scroll">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="load" className="center" {...page}>
              <span className="spin" />
            </motion.div>
          ) : open ? (
            <motion.div key={open.entry.url} {...page}>
              <TitleScreen data={open} jobs={jobs} actions={actions} />
            </motion.div>
          ) : (
            <motion.div key="lib" {...page} style={{ height: "100%" }}>
              <Library
                items={library}
                onOpen={openEntry}
                onRemove={removeEntry}
                onAdd={openAdd}
                onReorder={reorderLibrary}
                onReorderCommit={commitLibraryOrder}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <div className="toasts">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className={`toast${t.bad ? " bad" : ""}`}
              initial={{ opacity: 0, y: -14, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
            >
              {t.text}
              {t.action && (
                <button
                  className="toast-act"
                  onClick={() => {
                    dismiss(t.id);
                    t.action!.run();
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {sheet === "add" && (
          <AddSheet
            key="add"
            busy={adding}
            error={addError}
            initial={draft}
            onClose={() => setSheet(null)}
            onSubmit={add}
            onSettings={addError && needsLogin(addError) ? () => setSheet("settings") : undefined}
          />
        )}
        {sheet === "help" && <HelpSheet key="help" onClose={() => setSheet(null)} />}
        {sheet === "settings" && settings && (
          <SettingsSheet
            key="settings"
            value={settings}
            onClose={() => setSheet(null)}
            onSave={(s) => {
              api.settingsSet(s).then(
                () => {
                  setSettings(s);
                  setSheet(null);
                  toast("Настройки сохранены");
                },
                (e) => toast(String(e), true),
              );
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function markFile(t: Title, file: string): Title {
  if (!file.startsWith(`${t.dir}/`)) return t;
  const tag = file.split("/").pop()?.split("-")[0];
  return {
    ...t,
    players: t.players.map((p) => ({
      ...p,
      episodes: p.episodes.map((e) => (e.tag === tag ? { ...e, file } : e)),
    })),
  };
}

function dropFile(t: Title, file: string): Title {
  return {
    ...t,
    players: t.players.map((p) => ({
      ...p,
      episodes: p.episodes.map((e) => (e.file === file ? { ...e, file: null } : e)),
    })),
  };
}
