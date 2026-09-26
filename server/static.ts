import path from "node:path";

const distDir = path.resolve(import.meta.dir, "..", "dist");

/// В бинарник dist вшивает scripts/compile.ts; в разработке embeddedFiles пуст и файлы берутся с диска.
const embedded = new Map(
  Bun.embeddedFiles.map((f) => [(f as Blob & { name: string }).name.replace(/\\/g, "/").replace(/^dist\//, ""), f]),
);

const send = (body: Blob): Response =>
  new Response(body, { headers: { "Content-Type": body.type, "Cache-Control": "no-store" } });

export async function serveStatic(urlPath: string): Promise<Response> {
  const key = urlPath.replace(/^\/+/, "") || "index.html";

  if (embedded.size > 0) return send(embedded.get(key) ?? embedded.get("index.html")!);

  const file = path.resolve(distDir, key);
  if (!file.startsWith(distDir + path.sep)) return new Response(null, { status: 403 });
  const hit = Bun.file(file);
  if (await hit.exists()) return send(hit);
  const index = Bun.file(path.join(distDir, "index.html"));
  if (await index.exists()) return send(index);
  return new Response("dist не собран — выполните npm run build", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
