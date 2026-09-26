import { toast } from "sonner";

type Action = { label: string; onClick: () => void };

export const notify = (text: string, action?: Action) => toast(text, { action, duration: action ? 6000 : 3200 });

export const warn = (e: unknown, action?: Action) => toast.error(String(e), { action, duration: 6000 });
