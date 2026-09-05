import { AnimatePresence, motion } from "motion/react";
import { bytes, type Progress } from "../api";
import { X } from "../icons";

const name = (id: string) => id.split("/").pop() ?? id;

export default function Queue({
  jobs,
  onCancel,
}: {
  jobs: Record<string, Progress>;
  onCancel: (id: string) => void;
}) {
  const list = Object.values(jobs);
  return (
    <div className="queue">
      <AnimatePresence initial={false}>
        {list.map((j) => {
          const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
          return (
            <motion.div
              key={j.id}
              className="job"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            >
              <div className="row">
                <b>{name(j.id)}</b>
                <span>
                  {j.bytesPerSec ? `${bytes(j.bytesPerSec)}/с` : "…"} · {Math.round(pct)}%
                </span>
                <button className="x" onClick={() => onCancel(j.id)}>
                  <X size={13} />
                </button>
              </div>
              <div className="track">
                <i style={{ width: `${pct}%` }} />
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
