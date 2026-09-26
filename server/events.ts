import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Events } from "./schema.ts";

const clients = new Set<SSEStreamingApi>();

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  const data = JSON.stringify(payload);
  for (const s of clients) s.writeSSE({ event, data }).catch(() => clients.delete(s));
}

export const events = (c: Context): Response =>
  streamSSE(c, async (s) => {
    clients.add(s);
    s.onAbort(() => {
      clients.delete(s);
    });
    await s.write(": ok\n\n");
    while (!s.aborted && !s.closed) {
      await s.sleep(25_000);
      await s.write(": beat\n\n");
    }
    clients.delete(s);
  });
