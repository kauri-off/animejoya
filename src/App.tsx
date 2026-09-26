import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster } from "sonner";
import { useLocation, useRoute } from "wouter";
import { ChevronLeft, ExternalLink, HardDrive, Keyboard, Plus, RotateCw, Settings as Gear } from "lucide-react";
import { api, media, on, saveAs, type Entry, type Episode, type Progress, type Settings, type Title } from "./api";
import { notify, warn } from "./toast";
import Library from "./components/Library";
import TitleScreen, { type Actions } from "./components/TitleScreen";
import Queue from "./components/Queue";
import Cache from "./components/Cache";
import { AddSheet, HelpSheet, SettingsSheet } from "./components/Sheets";

type Sheet = "add" | "settings" | "help" | null;

const needsLogin = (text: string) => text.includes("нужен вход");

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

const titlePath = (url: string) => `/title/${encodeURIComponent(url)}`;

/// Откуда пришли на экран — туда ведёт «Назад»; после F5 состояние истории сохраняется.
const cameFrom = (): string | null => {
  const from: unknown = history.state?.from;
  return typeof from === "string" ? from : null;
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
  const [location, navigate] = useLocation();
  const [isTitle, params] = useRoute<{ url: string }>("/title/:url");
  const titleUrl = isTitle ? decode(params.url) || null : null;
  const cacheOpen = location === "/cache";

  const [library, setLibrary] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState<Title | null>(null);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<Record<string, Progress>>({});
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(0);
  const manualSync = useRef(false);
  const libRef = useRef(library);
  libRef.current = library;
  const openUrl = useRef<string | null>(null);
  openUrl.current = open?.entry.url ?? null;
  const pending = useRef<string | null>(null);

  const fail = useCallback((e: unknown) => {
    const text = String(e);
    warn(text, needsLogin(text) ? { label: "Настройки", onClick: () => setSheet("settings") } : undefined);
  }, []);

  const go = useCallback((to: string) => navigate(to, { state: { from: location } }), [navigate, location]);
  const openTitle = useCallback((url: string) => go(titlePath(url)), [go]);

  useEffect(() => {
    api
      .libraryGet()
      .then((lib) => {
        setLibrary(lib);
        // Записи из старого links.json приходят без обложек — догружаем их фоном.
        return api.librarySync(false);
      })
      .catch(warn);
    api.settingsGet().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const drop = (id: string) => setJobs(({ [id]: _, ...rest }) => rest);
    const uns = [
      on("preload:progress", (p) => setJobs((j) => ({ ...j, [p.id]: p }))),
      on("preload:done", ({ id, file }) => {
        drop(id);
        setOpen((t) => (t ? markFile(t, file) : t));
      }),
      on("preload:failed", ({ id, message }) => {
        drop(id);
        if (!message.includes("отменена")) warn(message);
      }),
      on("library:entry", (entry) => setLibrary((lib) => lib.map((e) => (e.url === entry.url ? entry : e)))),
      on("library:syncing", setSyncing),
      on("library:synced", ({ total, failed }) => {
        if (failed > 0) warn(`Не удалось обновить ${failed} из ${total}`);
        else if (manualSync.current) notify(`Обновлено тайтлов: ${total}`);
        manualSync.current = false;
      }),
      on("cache:dropped", (files) => setOpen((t) => (t ? files.reduce(dropFile, t) : t))),
    ];
    return () => uns.forEach((u) => u());
  }, []);

  const load = useCallback(
    async (url: string) => {
      pending.current = url;
      setLoading(true);
      try {
        const data = await api.titleOpen(url);
        if (pending.current !== url) return;
        setOpen(data);
        setLibrary((lib) =>
          lib.some((e) => e.url === data.entry.url)
            ? lib.map((e) => (e.url === data.entry.url ? data.entry : e))
            : [data.entry, ...lib],
        );
        if (data.entry.url !== url) navigate(titlePath(data.entry.url), { replace: true, state: history.state });
      } catch (e) {
        if (pending.current !== url) return;
        fail(e);
        setOpen(null);
        navigate(cameFrom() ?? "/", { replace: true });
      } finally {
        if (pending.current === url) {
          pending.current = null;
          setLoading(false);
        }
      }
    },
    [fail, navigate],
  );

  // Тайтл живёт в адресе: работают «Назад» браузера/мыши и F5.
  useEffect(() => {
    if (titleUrl === null) {
      pending.current = null;
      setLoading(false);
      setOpen(null);
    } else if (titleUrl !== openUrl.current) {
      void load(titleUrl);
    }
  }, [titleUrl, load]);

  const close = useCallback(() => {
    if (cameFrom() !== null) history.back();
    else navigate("/", { replace: true });
  }, [navigate]);

  const openEntry = useCallback((e: Entry) => openTitle(e.url), [openTitle]);

  const removeEntry = useCallback(
    (e: Entry) => {
      const index = libRef.current.findIndex((x) => x.url === e.url);
      api.libraryRemove(e.url).then(() => {
        setLibrary((l) => l.filter((x) => x.url !== e.url));
        notify(`«${e.title || e.url}» убран из библиотеки`, {
          label: "Вернуть",
          onClick: () => api.libraryRestore(e, index).then(setLibrary, fail),
        });
      }, fail);
    },
    [fail],
  );

  const reorderLibrary = useCallback((next: Entry[]) => {
    setLibrary(next);
    api
      .libraryReorder(next.map((e) => e.url))
      .then(setLibrary)
      .catch((e) => {
        warn(e);
        return api.libraryGet().then(setLibrary);
      })
      .catch(() => {});
  }, []);

  const openAdd = useCallback(() => {
    setDraft("");
    setAddError(null);
    setSheet("add");
  }, []);

  const syncAll = useCallback(() => {
    manualSync.current = true;
    api.librarySync(true).catch(fail);
  }, [fail]);

  const add = useCallback(
    async (url: string) => {
      setAdding(true);
      setAddError(null);
      try {
        const entry = await api.libraryAdd(url);
        setLibrary(await api.libraryGet());
        setSheet(null);
        setDraft("");
        openTitle(entry.url);
      } catch (e) {
        setAddError(String(e));
      } finally {
        setAdding(false);
      }
    },
    [openTitle],
  );

  // Ctrl+V в любом месте библиотеки = добавить тайтл по ссылке из буфера.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (sheet || titleUrl || cacheOpen) return;
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (!/^https?:\/\/\S+\/\d+-[^/]*\.html?$/.test(text)) return;
      setDraft(text);
      setAddError(null);
      setSheet("add");
    };
    // Esc в открытом окне обрабатывает сам Radix.
    const onKey = (e: KeyboardEvent) => {
      if (sheet) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "?" && !typing) setSheet("help");
      else if (e.key === "Escape" && !document.fullscreenElement && (titleUrl || cacheOpen)) close();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [sheet, titleUrl, cacheOpen, close]);

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
        .then((id) => setJobs((j) => (j[id] ? j : { ...j, [id]: { id, done: 0, total: 0, bytesPerSec: 0 } })), warn);
    },
    dropCache: (ep) => {
      if (!ep.file) return;
      api.cacheDrop(ep.file).then(() => setOpen((t) => (t ? dropFile(t, ep.file!) : t)), warn);
    },
    resolvePlayer: async (playerId) => {
      if (!open) return;
      try {
        const episodes = await api.playerResolve(open.entry.url, playerId);
        setOpen((t) =>
          t ? { ...t, players: t.players.map((p) => (p.id === playerId ? { ...p, episodes } : p)) } : t,
        );
      } catch (e) {
        warn(e);
      }
    },
    markWatched: (ep) => markWatched([ep], true),
    markUpTo: (eps) => {
      markWatched(eps, true);
      notify(`Отмечено серий: ${eps.length}`);
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
    const url = open.entry.url;
    api.markWatched(url, eps.map((e) => e.title), watched).then((list) => {
      setOpen((t) => (t ? { ...t, entry: { ...t.entry, watched: list } } : t));
      setLibrary((lib) => lib.map((e) => (e.url === url ? { ...e, watched: list } : e)));
    }, fail);
  }

  const title = titleUrl !== null ? open : null;
  const back = titleUrl !== null && cameFrom() === "/cache" ? "Кэш" : "Библиотека";
  const home = titleUrl === null && !cacheOpen;

  return (
    <div className="app">
      <header className="topbar">
        {home ? (
          <div className="brand">
            <i />
            AnimeJoy
          </div>
        ) : (
          <button className="ghost" title={`${back} (Esc)`} onClick={close}>
            <ChevronLeft size={15} /> <span className="wide">{back}</span>
          </button>
        )}

        <div className="spacer" />

        {title && (
          <>
            <a
              href={title.entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ghost"
              title={`Открыть на ${hostOf(title.entry.url)}`}
            >
              <ExternalLink size={15} />
            </a>
            <button className="ghost" title="Обновить" onClick={() => load(title.entry.url)}>
              <RotateCw size={15} />
            </button>
          </>
        )}
        {home && syncing > 0 && (
          <div className="sync">
            <span className="spin" /> <span className="wide">Обновление:</span> {syncing}
          </div>
        )}
        {home && syncing === 0 && library.length > 0 && (
          <button className="ghost" title="Обновить все тайтлы" onClick={syncAll}>
            <RotateCw size={15} />
          </button>
        )}
        {home && (
          <button className="primary" title="Добавить по ссылке" onClick={openAdd}>
            <Plus size={15} /> <span className="wide">Ссылка</span>
          </button>
        )}
        <Queue jobs={jobs} onCancel={(id) => void api.preloadCancel(id)} />
        {!cacheOpen && (
          <button className="ghost" title="Кэш" onClick={() => go("/cache")}>
            <HardDrive />
          </button>
        )}
        <button className="ghost desk" title="Горячие клавиши (?)" onClick={() => setSheet("help")}>
          <Keyboard />
        </button>
        <button className="ghost" title="Настройки" onClick={() => setSheet("settings")}>
          <Gear size={15} />
        </button>
      </header>

      <main className="scroll">
        <AnimatePresence mode="wait">
          {loading || (titleUrl !== null && title === null) ? (
            <motion.div key="load" className="center" {...page}>
              <span className="spin" />
            </motion.div>
          ) : title ? (
            <motion.div key={title.entry.url} {...page}>
              <TitleScreen data={title} jobs={jobs} actions={actions} preloadNext={settings?.preloadNext ?? true} />
            </motion.div>
          ) : cacheOpen ? (
            <motion.div key="cache" {...page} style={{ height: "100%" }}>
              <Cache jobs={jobs} onOpen={openTitle} />
            </motion.div>
          ) : (
            <motion.div key="lib" {...page} style={{ height: "100%" }}>
              <Library items={library} onOpen={openEntry} onRemove={removeEntry} onAdd={openAdd} onReorder={reorderLibrary} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <Toaster
        position="top-center"
        expand
        gap={8}
        offset={{ top: "calc(74px + env(safe-area-inset-top))" }}
        mobileOffset={{ top: "calc(62px + env(safe-area-inset-top))" }}
        toastOptions={{ unstyled: true, classNames: { toast: "toast", error: "bad", actionButton: "toast-act" } }}
        icons={{ error: null }}
      />

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
              api.settingsSet(s).then(() => {
                setSettings(s);
                setSheet(null);
                notify("Настройки сохранены");
              }, warn);
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
