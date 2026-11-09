// Выгружает переписку именованных сессий Claude Code в Markdown рядом с их CLAUDE.md.
//
// Зачем: jsonl в ~/.claude/projects не вечны (инцидент 22.09.2026) и непонятны другим
// агентам. Выгрузка лежит в папке сессии — её прочтёт и человек, и Codex (для него
// рядом кладётся симлинк AGENTS.md → CLAUDE.md).
//
// Куда: <папка с CLAUDE.md сессии>/_история_сессии/<название>.md
//   - папка = ближайшая вверх от cwd запуска, где есть CLAUDE.md;
//   - cwd = домашняя папка → по таблице в ~/CLAUDE.md, иначе ~/Documents/Claude — история сессий/.
// Что попадает: реплики пользователя, ответы Claude, сводки после compact, одной строкой —
// какие инструменты вызывались. Выводы инструментов и thinking — нет.
// Сессии без /rename (служебные запуски claude -p) пропускаются.
//
// Запускается сервером дашборда раз в час отдельным процессом. Вручную:
//   bun run tools/export-transcripts.ts [--dry-run] [--only "<название>"]
// --only — одна сессия, по списку её jsonl из индекса прошлого полного прогона
// (~/.cc-dashboard/transcripts-index.json): так сервер раз в минуту дёшево обновляет
// сессии из «живого» списка, не перечитывая все jsonl.
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync, existsSync, lstatSync, mkdirSync, writeFileSync, renameSync, symlinkSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

const HOME = homedir();
const PROJECTS = join(HOME, ".claude", "projects");
const OUT_DIR = "_история_сессии";
const FALLBACK_DIR = join(HOME, "Documents", "Claude — история сессий");
const MIN_USER_MSGS = 3;
const DRY = process.argv.includes("--dry-run");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const INDEX = join(HOME, ".cc-dashboard", "transcripts-index.json");
const NOISE = /<(system-reminder|local-command-stdout|local-command-caveat|command-message|command-args)>[\s\S]*?<\/\1>/g;

// Сразу при чтении от записи остаётся только то, что пойдёт в md (выводы инструментов
// весят сотни мегабайт — их не держим).
type Rec = { ts: string; kind: "user" | "summary" | "text" | "tool"; text: string };
type Sess = { recs: Map<string, Rec>; sids: Set<string>; files: string[]; cwd: string };

function slim(j: any): Rec[] {
  const ts = j.timestamp || "", msg = j.message || {};
  if (j.type === "user") {
    if (j.isMeta) return [];
    const t = userText(msg.content);
    return t ? [{ ts, kind: j.isCompactSummary ? "summary" : "user", text: t }] : [];
  }
  const out: Rec[] = [];
  for (const b of msg.content || []) {
    if (b.type === "text" && b.text?.trim()) out.push({ ts, kind: "text", text: b.text.trim() });
    else if (b.type === "tool_use") out.push({ ts, kind: "tool", text: toolLine(b) });
  }
  return out;
}

// Построчно, кусками по 4 МБ: jsonl бывают по полгигабайта, целиком в память не тянем.
function forEachLine(path: string, cb: (line: string) => void) {
  const fd = openSync(path, "r"), buf = Buffer.alloc(4 << 20);
  let rest = Buffer.alloc(0), n: number;
  try {
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]), i: number;
      while ((i = chunk.indexOf(10)) >= 0) { cb(chunk.subarray(0, i).toString("utf8")); chunk = chunk.subarray(i + 1); }
      rest = Buffer.from(chunk);
    }
    if (rest.length) cb(rest.toString("utf8"));
  } finally { closeSync(fd); }
}

function homeTable(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const line of readFileSync(join(HOME, "CLAUDE.md"), "utf8").split("\n")) {
      const r = line.match(/\|\s*([^|`]+?)\s*\|\s*`([^`]+)\/CLAUDE\.md`/);
      if (r) m.set(r[1].toLowerCase(), r[2].replace(/^~/, HOME));
    }
  } catch {}
  return m;
}

function targetDir(title: string, cwd: string, table: Map<string, string>): { dir: string; own: boolean } {
  if (cwd.replace(/\/$/, "") === HOME) {
    const t = table.get(title.toLowerCase());
    return t ? { dir: t, own: true } : { dir: FALLBACK_DIR, own: false };
  }
  for (let d = cwd; d.startsWith(HOME) && d !== HOME; d = dirname(d)) {
    if (existsSync(join(d, "CLAUDE.md"))) return { dir: d, own: true };
  }
  return existsSync(cwd) ? { dir: cwd, own: true } : { dir: FALLBACK_DIR, own: false };
}

function userText(content: any): string | null {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else for (const b of content || []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "image") parts.push("[изображение]");
    else if (b.type === "tool_result") return null; // ответ инструмента, не реплика
  }
  const t = parts.join("\n").replace(NOISE, "").replace(/<command-name>(.*?)<\/command-name>/g, "$1").trim();
  return t || null;
}

function toolLine(b: any): string {
  const inp = b.input || {};
  let what = inp.description || inp.file_path || inp.query || inp.url || inp.pattern || "";
  if (!what && b.name === "Bash") what = String(inp.command || "").slice(0, 120);
  return `- 🔧 \`${b.name}\` ${String(what).replace(/\n/g, " ").slice(0, 160)}`.trimEnd();
}

function collect(only: string[] | null): Map<string, Sess> {
  const files: { path: string; mtime: number }[] = [];
  if (only) for (const p of only) { try { files.push({ path: p, mtime: statSync(p).mtimeMs }); } catch {} }
  else for (const proj of readdirSync(PROJECTS)) {
    let names: string[] = [];
    try { names = readdirSync(join(PROJECTS, proj)); } catch { continue; }
    for (const n of names) if (n.endsWith(".jsonl")) {
      const p = join(PROJECTS, proj, n);
      try { files.push({ path: p, mtime: statSync(p).mtimeMs }); } catch {}
    }
  }
  // от старых к новым: при нескольких jsonl с одним названием побеждает cwd свежего
  files.sort((a, b) => a.mtime - b.mtime);
  const sessions = new Map<string, Sess>();
  for (const { path } of files) {
    let title: string | null = null, cwd: string | null = null;
    const recs: [string, Rec][] = [];
    forEachLine(path, line => {
      if (!line) return;
      let j: any;
      try { j = JSON.parse(line); } catch { return; }
      if (j.type === "custom-title") title = j.customTitle || title;
      else if ((j.type === "user" || j.type === "assistant") && !j.isSidechain) {
        slim(j).forEach((r, i) => recs.push([`${j.uuid}:${i}`, r]));
        cwd = cwd || j.cwd; // cwd запуска, а не после cd
      }
    });
    if (!title || !cwd) continue;
    const s = sessions.get(title) || { recs: new Map(), sids: new Set(), files: [], cwd };
    s.sids.add(basename(path, ".jsonl"));
    s.files.push(path);
    s.cwd = cwd;
    for (const [k, r] of recs) if (!s.recs.has(k)) s.recs.set(k, r);
    sessions.set(title, s);
  }
  return sessions;
}

function render(title: string, s: Sess): { md: string; n: number } | null {
  const recs = [...s.recs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const out: string[] = [], tools: string[] = [];
  let n = 0;
  const flush = () => {
    if (!tools.length) return;
    out.push(`<details><summary>инструменты: ${tools.length}</summary>\n\n${tools.join("\n")}\n\n</details>\n`);
    tools.length = 0;
  };
  for (const r of recs) {
    const ts = r.ts.slice(0, 16).replace("T", " ");
    if (r.kind === "tool") { tools.push(r.text); continue; }
    flush();
    if (r.kind === "summary") out.push(`<details><summary>📋 Сводка контекста (compact), ${ts}</summary>\n\n${r.text}\n\n</details>\n`);
    else if (r.kind === "user") { n++; out.push(`### 👤 Пользователь · ${ts}\n\n${r.text}\n`); }
    else out.push(`**🤖 Claude:** ${r.text}\n`);
  }
  flush();
  if (n < MIN_USER_MSGS) return null;
  const first = recs[0].ts.slice(0, 10), last = recs[recs.length - 1].ts.slice(0, 10);
  const head = [
    `# Переписка сессии «${title}»`, ``,
    `- Период: ${first} — ${last}, реплик пользователя: ${n}`,
    `- Claude Code sid: ${[...s.sids].sort().join(", ")}`,
    `- Рабочая папка: \`${s.cwd}\``, ``,
    "> Автовыгрузка из `~/.claude/projects/*.jsonl` (дашборд, `tools/export-transcripts.ts`, раз в час),",
    "> перезаписывается целиком — не редактировать. Главная база знаний — `CLAUDE.md` рядом;",
    "> этот файл — для поиска подробностей (grep по ключевым словам), а не для чтения подряд.",
    "> Выводы инструментов не сохраняются; сводки compact — в свёрнутых блоках.", ``, `---`, ``, ``,
  ].join("\n");
  return { md: head + out.join("\n"), n };
}

// Если папка в git — не дать выгрузке и симлинку попасть в коммит (через .git/info/exclude).
function gitExclude(d: string) {
  const r = Bun.spawnSync(["git", "-C", d, "rev-parse", "--absolute-git-dir"], { stdout: "pipe", stderr: "ignore" });
  const gdir = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !gdir) return;
  const ex = join(gdir, "info", "exclude");
  const have = existsSync(ex) ? readFileSync(ex, "utf8").split("\n") : [];
  const add = [OUT_DIR + "/", "AGENTS.md"].filter(x => !have.includes(x));
  if (!add.length) return;
  mkdirSync(dirname(ex), { recursive: true });
  appendFileSync(ex, "\n# cc-dashboard export-transcripts\n" + add.join("\n") + "\n");
}

// Codex читает AGENTS.md — даём ему тот же CLAUDE.md.
function agentsLink(d: string) {
  const a = join(d, "AGENTS.md");
  let exists = false;
  try { lstatSync(a); exists = true; } catch {}
  if (!exists && existsSync(join(d, "CLAUDE.md"))) symlinkSync("CLAUDE.md", a);
}

const table = homeTable();
let onlyFiles: string[] | null = null;
if (ONLY) {
  try { onlyFiles = JSON.parse(readFileSync(INDEX, "utf8"))[ONLY] || null; } catch {}
  if (!onlyFiles) console.error(`!! ${ONLY}: нет в индексе — полный прогон`);
}
const all = collect(onlyFiles);
if (!ONLY && !DRY) {
  const idx: Record<string, string[]> = {};
  for (const [t, s] of all) idx[t] = s.files;
  try { writeFileSync(INDEX, JSON.stringify(idx, null, 1)); } catch (e) { console.error(`!! индекс: ${e}`); }
}
for (const [title, s] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (ONLY && title !== ONLY) continue;
  const r = render(title, s);
  if (!r) continue;
  const { dir, own } = targetDir(title, s.cwd, table);
  const safe = title.replace(/[/\\:*?"<>|]/g, "_");
  const dst = own ? join(dir, OUT_DIR, safe + ".md") : join(dir, safe + ".md");
  console.log(`ok ${title}: ${r.n} реплик, ${Math.round(r.md.length / 1024)} КБ → ${dst}`);
  if (DRY) continue;
  try {
    if (own) { gitExclude(dir); agentsLink(dir); }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst + ".tmp", r.md);
    renameSync(dst + ".tmp", dst);
  } catch (e) { console.error(`!! ${title}: ${e}`); }
}
