// Вшивает содержимое dist/ в server/assets.generated.ts, чтобы `bun build --compile`
// собрал одиночный бинарник без внешних файлов. С `--stub` возвращает файл в пустой
// вид, чтобы после сборки в репозитории не оставалось полмегабайта base64.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "server", "assets.generated.ts");
const HEAD = "// Сгенерировано scripts/embed.mjs — не редактировать руками.";

if (process.argv.includes("--stub")) {
  fs.writeFileSync(
    out,
    `${HEAD}\n// Пусто — сервер отдаёт файлы из ./dist с диска.\nexport const assets: Record<string, string> = {};\n`,
  );
  console.log("assets.generated.ts очищен");
  process.exit(0);
}

const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) {
  console.error("нет папки dist — сначала выполните npm run build");
  process.exit(1);
}

const files = [];
for (const entry of fs.readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const abs = path.join(entry.parentPath, entry.name);
  files.push([path.relative(dist, abs).split(path.sep).join("/"), fs.readFileSync(abs)]);
}

const body = files
  .map(([name, buf]) => `  ${JSON.stringify(name)}: ${JSON.stringify(buf.toString("base64"))},`)
  .join("\n");

fs.writeFileSync(out, `${HEAD}\nexport const assets: Record<string, string> = {\n${body}\n};\n`);

const total = files.reduce((n, [, b]) => n + b.length, 0);
console.log(`вшито файлов: ${files.length}, ${(total / 1024).toFixed(0)} КБ`);
