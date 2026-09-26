import open from "open";
import { app, sweep } from "./app.ts";

const HOST = process.env.ANIMEJOYA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ANIMEJOYA_PORT ?? 7788);

void sweep();
setInterval(sweep, 1_800_000).unref();

// В контейнере сервер — PID 1, и без явного обработчика SIGTERM игнорируется.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));

// sendfile для кэша и прямая передача потока с CDN — node:http на слабом CPU упирался в 100%.
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  fetch(req, srv) {
    // Плеер на паузе и SSE подолгу молчат — не рвём их по простою.
    if (/^\/(media\/|api\/events$)/.test(new URL(req.url).pathname)) srv.timeout(req, 0);
    return app.fetch(req, srv);
  },
});

const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${server.port}/`;
console.log(`AnimeJoy: ${url}`);
if (process.env.ANIMEJOYA_NO_OPEN === undefined && !process.argv.includes("--no-open")) {
  open(url).catch(() => {});
}
