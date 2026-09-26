import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, X } from "lucide-react";
import { bytes, type Progress } from "../api";

const name = (id: string) => id.split("/").pop() ?? id;
const C = 2 * Math.PI * 15;

export default function Queue({
  jobs,
  onCancel,
}: {
  jobs: Record<string, Progress>;
  onCancel: (id: string) => void;
}) {
  const list = Object.values(jobs);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const was = useRef(0);

  useEffect(() => {
    if (!list.length) setOpen(false);
    else if (!was.current) setOpen(true);
    was.current = list.length;
  }, [list.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const done = list.reduce((s, j) => s + j.done, 0);
  const total = list.reduce((s, j) => s + (j.total || 0), 0);
  const all = total ? Math.min(100, (done / total) * 100) : 0;

  return (
    <AnimatePresence>
      {list.length > 0 && (
        <motion.div
          className="dl"
          ref={box}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ type: "spring", stiffness: 480, damping: 32 }}
        >
          <button className="dl-btn" title="Предзагрузка" onClick={() => setOpen((o) => !o)}>
            <svg className="ring" viewBox="0 0 32 32">
              <circle className="bg" cx="16" cy="16" r="15" />
              <circle
                className="fg"
                cx="16"
                cy="16"
                r="15"
                strokeDasharray={`${(all / 100) * C} ${C}`}
              />
            </svg>
            <Download size={15} />
            {list.length > 1 && <b>{list.length}</b>}
          </button>

          <AnimatePresence>
            {open && (
              <motion.div
                className="dl-pop"
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 500, damping: 36 }}
              >
                {list.map((j) => {
                  const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
                  return (
                    <div className="job" key={j.id}>
                      <div className="row">
                        <b>{name(j.id)}</b>
                        <span>{j.bytesPerSec ? `(${bytes(j.bytesPerSec)}/с)` : "…"}</span>
                        <button className="x" onClick={() => onCancel(j.id)}>
                          <X size={13} />
                        </button>
                      </div>
                      <div className="track">
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
