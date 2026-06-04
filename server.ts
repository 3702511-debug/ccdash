import { readdir, stat, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHmac } from "node:crypto";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const UPLOAD_DIR = "/tmp/cc-dashboard";
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
await mkdir(UPLOAD_DIR, { recursive: true });

async function cleanupOldUploads(): Promise<void> {
  try {
    const now = Date.now();
    const files = await readdir(UPLOAD_DIR);
    await Promise.all(files.map(async f => {
      const p = join(UPLOAD_DIR, f);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > UPLOAD_MAX_AGE_MS) await unlink(p);
      } catch {}
    }));
  } catch {}
}
cleanupOldUploads();
setInterval(cleanupOldUploads, 60 * 60 * 1000);
const FRESH_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PORT = parseInt(process.env.PORT ?? "8787");
const SELF_SESSION_ID_ENV = (process.env.CLAUDE_SESSION_ID ?? "").trim();

async function detectSelfFromProcessTree(): Promise<string> {
  let pid = process.pid;
  for (let i = 0; i < 15; i++) {
    let ppidStr = "";
    try { ppidStr = (await sh("ps", ["-o", "ppid=", "-p", String(pid)])).trim(); } catch {}
    const ppid = parseInt(ppidStr);
    if (!Number.isFinite(ppid) || ppid <= 1) break;
    let comm = "";
    try { comm = (await sh("ps", ["-o", "comm=", "-p", String(ppid)])).trim(); } catch {}
    if (comm === "claude") {
      try {
        const fp = join(homedir(), ".claude", "sessions", `${ppid}.json`);
        const data = await Bun.file(fp).json();
        if (typeof data?.sessionId === "string") return data.sessionId;
      } catch {}
      return "";
    }
    pid = ppid;
  }
  return "";
}

const SELF_SESSION_AT_STARTUP = SELF_SESSION_ID_ENV || await detectSelfFromProcessTree();
console.log("Self session:", SELF_SESSION_AT_STARTUP || "(not detected — отправка не блокируется)");

async function getSelfSessionId(): Promise<string> {
  return SELF_SESSION_AT_STARTUP;
}

type Status = "thinking" | "tool" | "waiting" | "idle" | "unknown";

interface Session {
  pid: number;
  sessionId: string;
  title: string | null;
  cwd: string;
  cwdLabel: string;
  tty: string | null;
  isDesktop: boolean;
  isSelf: boolean;
  status: Status;
  lastActivity: string;
  lastActivityRel: string;
  busySince?: string;
  inputTokens?: number;
  limitHit?: boolean;
  limitResetAt?: string;
  isMain?: boolean;
  hasOpenQuestion?: boolean;
  openQuestion?: any;  // see OpenQuestion type below — declared later, so use 'any' here to avoid forward-ref
  // kid-dash интеграция: для сессий kid-dash (cwd содержит ~/.kid-dash/ или ~/Documents/клод/kid-dash/)
  // показываем баннер «ребёнок на уроке» и блокируем композер, пока child_active.
  kidDash?: { isChildChat: boolean; isBlocked: boolean; currentSubject: string | null; expectedEnd: string | null };
}

interface SessionMeta {
  jsonlPath: string;
  tty: string | null;
  cwd: string;
  pid: number;
}

const sessionMeta = new Map<string, SessionMeta>();

async function sh(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function shWithInput(cmd: string, args: string[], input: string): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout: out, code };
}

async function findClaudePids(): Promise<number[]> {
  const out = await sh("pgrep", ["-x", "claude"]);
  return out.split("\n").map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
}

async function pidInfo(pid: number): Promise<{ cwd: string | null; tty: string | null; ppidComm: string }> {
  const lsofOut = await sh("lsof", ["-p", String(pid), "-Fn", "-a", "-d", "cwd"]);
  const cwd = lsofOut.match(/^n(.+)$/m)?.[1] ?? null;

  const psOut = await sh("ps", ["-o", "tty=,ppid=", "-p", String(pid)]);
  const m = psOut.trim().match(/^(\S+)\s+(\d+)$/);
  let tty: string | null = null;
  let ppidComm = "";
  if (m) {
    tty = m[1] === "??" ? null : m[1];
    const ppid = m[2];
    ppidComm = (await sh("ps", ["-o", "comm=", "-p", ppid])).trim();
  }
  return { cwd, tty, ppidComm };
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const headlessCache = new Map<string, boolean>();
async function isHeadlessOrSidechain(jsonlPath: string): Promise<boolean> {
  if (headlessCache.has(jsonlPath)) return headlessCache.get(jsonlPath)!;
  let res = false;
  try {
    const head = await Bun.file(jsonlPath).slice(0, 4096).text();
    for (const line of head.split("\n").slice(0, 10)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.isSidechain === true) { res = true; break; }
        if (rec.type === "queue-operation") { res = true; break; }
      } catch {}
    }
  } catch {}
  headlessCache.set(jsonlPath, res);
  return res;
}

async function readTail(path: string, bytes = 64 * 1024): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - bytes);
  return await file.slice(start, size).text();
}

async function readHead(path: string, bytes = 32 * 1024): Promise<string> {
  const file = Bun.file(path);
  return await file.slice(0, Math.min(bytes, file.size)).text();
}

function stripNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .trim();
}

function extractCustomTitle(text: string): string | null {
  const lines = text.split("\n").filter(l => l.trim().startsWith("{"));
  let latest: string | null = null;
  for (const line of lines) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec.customTitle === "string" && rec.customTitle.trim()) {
      latest = rec.customTitle.trim();
    }
  }
  if (!latest) return null;
  let title = latest.replace(/\s+/g, " ");
  if (title.length > 80) title = title.slice(0, 80) + "…";
  return title;
}

async function getTitle(jsonlPath: string): Promise<string | null> {
  // /rename appends customTitle to the end; /title used at session start lives near the head.
  // Check tail first (most recent rename wins), then head as fallback.
  const tail = await readTail(jsonlPath, 64 * 1024);
  const fromTail = extractCustomTitle(tail);
  if (fromTail) return fromTail;
  const head = await readHead(jsonlPath, 32 * 1024);
  return extractCustomTitle(head);
}

const titleCache = new Map<string, { title: string | null; probedAt: number }>();
const TITLE_NULL_RECHECK_MS = 10_000;
const TITLE_VALUE_RECHECK_MS = 60_000;

let tabTitlesCache: { titles: Map<string, string>; at: number } | null = null;
const TAB_TITLES_TTL_MS = 5_000;

const TAB_TITLES_SCRIPT = `
set out to ""
try
  tell application "iTerm"
    if it is running then
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              set out to out & (tty of s) & "|" & (name of s) & linefeed
            end try
          end repeat
        end repeat
      end repeat
    end if
  end tell
end try
try
  tell application "Terminal"
    if it is running then
      repeat with w in windows
        repeat with t in tabs of w
          try
            set tname to ""
            try
              set tname to custom title of t
            end try
            if tname is "" then set tname to name of t
            set out to out & (tty of t) & "|" & tname & linefeed
          end try
        end repeat
      end repeat
    end if
  end tell
end try
return out
`;

function cleanTabTitle(t: string): string {
  // Strip leading status markers (e.g. "✳ ", "⠂ ") and any non-alphanumeric prefix
  return t.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function isUsefulTabTitle(t: string): boolean {
  if (!t) return false;
  // Filter out generic Terminal.app auto-names like "ea — -bash — 80×24"
  if (/\s\d+×\d+\s*$/.test(t)) return false;
  if (/^-?bash$/.test(t) || /^-?zsh$/.test(t)) return false;
  return true;
}

async function getTabTitles(): Promise<Map<string, string>> {
  const now = Date.now();
  if (tabTitlesCache && now - tabTitlesCache.at < TAB_TITLES_TTL_MS) {
    return tabTitlesCache.titles;
  }
  const titles = new Map<string, string>();
  try {
    const proc = Bun.spawn(["osascript", "-e", TAB_TITLES_SCRIPT], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      const idx = line.indexOf("|");
      if (idx < 0) continue;
      const ttyPath = line.slice(0, idx);
      const rawTitle = line.slice(idx + 1);
      const clean = cleanTabTitle(rawTitle);
      if (!ttyPath || !isUsefulTabTitle(clean)) continue;
      const tty = ttyPath.replace(/^\/dev\//, "");
      titles.set(tty, clean);
    }
  } catch {}
  tabTitlesCache = { titles, at: now };
  return titles;
}

async function getTitleCached(sessionId: string, jsonlPath: string): Promise<string | null> {
  const cached = titleCache.get(sessionId);
  const now = Date.now();
  if (cached) {
    const ttl = cached.title ? TITLE_VALUE_RECHECK_MS : TITLE_NULL_RECHECK_MS;
    if (now - cached.probedAt < ttl) return cached.title;
  }
  try {
    const title = await getTitle(jsonlPath);
    titleCache.set(sessionId, { title, probedAt: now });
    return title;
  } catch {
    return cached?.title ?? null;
  }
}

interface StatusInfo {
  status: Status;
  lastActivity: string;
  sessionId: string;
  recordCwd: string | null;
  // Опционально: для активных статусов — когда стартанули и сколько токенов
  busySince?: string;
  inputTokens?: number;
  // Лимит Anthropic API хитнут — claude в терминале спит до ручного вмешательства
  limitHit?: boolean;
  limitResetAt?: string;
  // Открытый AskUserQuestion — модель ждёт ответ-выбор от пользователя; UI показывает кнопки
  openQuestionId?: string;
}

async function readStatus(jsonlPath: string): Promise<StatusInfo | null> {
  const text = await readTail(jsonlPath);
  const lines = text.split("\n").filter(l => l.trim().startsWith("{"));
  if (lines.length === 0) return null;

  const records: any[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < 30; i--) {
    try { records.unshift(JSON.parse(lines[i])); } catch {}
  }
  if (records.length === 0) return null;

  const tsRecord = [...records].reverse().find(r => r.timestamp);
  const ts: string = tsRecord?.timestamp ?? new Date().toISOString();
  const sessionId: string = records.find(r => r.sessionId)?.sessionId ?? "";
  const recordCwd: string | null = [...records].reverse().find(r => typeof r.cwd === "string" && r.cwd.length)?.cwd ?? null;
  const ageSec = (Date.now() - new Date(ts).getTime()) / 1000;

  let lastMessage: any = null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "assistant" || records[i].type === "user") {
      lastMessage = records[i];
      break;
    }
  }

  let status: Status = "unknown";
  if (lastMessage?.type === "user") {
    const c = lastMessage.message?.content;
    const items = Array.isArray(c) ? c : [];
    const textBody = typeof c === "string" ? c : items.filter((x: any) => x?.type === "text").map((x: any) => x?.text ?? "").join("");
    const hasText = textBody.trim().length > 0;
    const hasToolResult = items.some((x: any) => x?.type === "tool_result");
    if (textBody.trimStart().startsWith("/")) {
      // Slash-команды (/rename, /clear, …) — обрабатываются локально клодом
      status = "waiting";
    } else if (!hasText && hasToolResult) {
      // tool_result feedback клоду. Если запись свежая — claude в процессе обработки.
      // Раньше порог был 30 сек, но клод реально может анализировать большой stdout 1-2 мин без эмиссии в jsonl
      // (особенно если стримит ответ в конце). Поднимаем до 3 мин — если за это время не появилось ничего нового,
      // тогда уже считаем что сессия закончила/застряла → "waiting".
      status = ageSec > 180 ? "waiting" : "thinking";
    } else {
      status = ageSec > 600 ? "idle" : "thinking";
    }
  } else if (lastMessage?.type === "assistant") {
    const content = lastMessage.message?.content;
    const items = Array.isArray(content) ? content : [];
    const lastItem = items[items.length - 1];
    if (lastItem?.type === "tool_use") {
      status = ageSec > 600 ? "idle" : "tool";
    } else {
      status = ageSec > 1800 ? "idle" : "waiting";
    }
  }

  // Доп. метрики для активных статусов: время с момента последнего user-сообщения + токены последнего assistant
  let busySince: string | undefined;
  let inputTokens: number | undefined;
  if (status === "thinking" || status === "tool" || status === "waiting") {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].type === "user" && records[i].timestamp) {
        busySince = records[i].timestamp;
        break;
      }
    }
    // Последний assistant-record содержит message.usage.input_tokens / cache_*
    for (let i = records.length - 1; i >= 0; i--) {
      const u = records[i]?.message?.usage;
      if (u && typeof u.input_tokens === "number") {
        inputTokens = (u.input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0);
        break;
      }
    }
  }

  // Детект «лимита Anthropic» в последнем assistant-сообщении
  let limitHit = false;
  let limitResetAt: string | undefined;
  if (lastMessage?.type === "assistant") {
    const c = lastMessage.message?.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join(" ") : "");
    // Авто-сообщения claude code обычно стоят в начале и сами по себе короткие.
    // Чтобы не цеплять случайные упоминания в нормальном тексте — проверяем что текст ИМЕННО НАЧИНАЕТСЯ с лимит-фразы.
    const head = text.trimStart().slice(0, 200);
    // Паттерн 1: персональный лимит — «You've hit your … limit · resets 3:50pm (TZ)»
    const personalLimit = head.match(/^You(?:'ve)?\s+hit\s+your[\s\w-]{0,40}limit[^a-z]*resets\s+(\d{1,2}):(\d{2})(am|pm)?/i);
    if (personalLimit) {
      limitHit = true;
      limitResetAt = `${personalLimit[1]}:${personalLimit[2]}${personalLimit[3] ? personalLimit[3].toLowerCase() : ""}`;
    }
    // Паттерн 2: серверный лимит — «API Error: Server is temporarily limiting requests …»
    else if (/^API\s*Error:\s*Server\s+is\s+temporarily\s+limiting\s+requests/i.test(head)) {
      limitHit = true;
    }
  }

  // Детект открытого AskUserQuestion — последний tool_use с name=AskUserQuestion, не имеющий matching tool_result
  let openQuestionId: string | undefined;
  const askedIds = new Set<string>();
  const answeredIds = new Set<string>();
  for (const r of records) {
    if (r.type === "assistant" && Array.isArray(r.message?.content)) {
      for (const item of r.message.content) {
        if (item?.type === "tool_use" && item?.name === "AskUserQuestion" && typeof item.id === "string") {
          askedIds.add(item.id);
        }
      }
    } else if (r.type === "user" && Array.isArray(r.message?.content)) {
      for (const item of r.message.content) {
        if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
          answeredIds.add(item.tool_use_id);
        }
      }
    }
  }
  for (const id of askedIds) {
    if (!answeredIds.has(id)) openQuestionId = id;  // last unanswered wins
  }

  return { status, lastActivity: ts, sessionId, recordCwd, busySince, inputTokens, limitHit, limitResetAt, openQuestionId };
}

interface PidInfo {
  pid: number;
  cwd: string;
  tty: string | null;
  isDesktop: boolean;
  used: boolean;
  sessionId: string;
  name: string;
}

async function findAllFreshJsonls(): Promise<{ path: string; mtime: number }[]> {
  let subdirs: string[];
  try { subdirs = await readdir(PROJECTS_DIR); } catch { return []; }
  const now = Date.now();
  const out: { path: string; mtime: number }[] = [];
  await Promise.all(subdirs.map(async d => {
    const dirPath = join(PROJECTS_DIR, d);
    let files: string[];
    try { files = await readdir(dirPath); } catch { return; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dirPath, f);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs <= FRESH_MS) out.push({ path: p, mtime: s.mtimeMs });
      } catch {}
    }
  }));
  return out;
}

interface CachedPidInfo {
  cwd: string;
  tty: string | null;
  isDesktop: boolean;
  sessionId: string;
  name: string;
  lastProbedAt: number;
}
const pidInfoCache = new Map<number, CachedPidInfo>();
const PID_CACHE_TTL_MS = 10_000;

async function readPidMetadata(pid: number): Promise<{ sessionId: string; name: string; cwd: string } | null> {
  try {
    const fp = join(homedir(), ".claude", "sessions", `${pid}.json`);
    const data = await Bun.file(fp).json();
    return {
      sessionId: typeof data?.sessionId === "string" ? data.sessionId : "",
      name: typeof data?.name === "string" ? data.name : "",
      cwd: typeof data?.cwd === "string" ? data.cwd : "",
    };
  } catch { return null; }
}

async function gatherPidInfos(): Promise<PidInfo[]> {
  const pids = await findClaudePids();
  const aliveSet = new Set(pids);
  for (const cachedPid of pidInfoCache.keys()) {
    if (!aliveSet.has(cachedPid)) pidInfoCache.delete(cachedPid);
  }
  const now = Date.now();
  const infos: PidInfo[] = [];
  await Promise.all(pids.map(async pid => {
    const cached = pidInfoCache.get(pid);
    if (cached && now - cached.lastProbedAt < PID_CACHE_TTL_MS) {
      infos.push({ pid, cwd: cached.cwd, tty: cached.tty, isDesktop: cached.isDesktop, used: false, sessionId: cached.sessionId, name: cached.name });
      return;
    }
    const info = await pidInfo(pid);
    const meta = await readPidMetadata(pid);
    const cwd = info.cwd || meta?.cwd || "";
    if (!cwd) {
      if (cached) {
        infos.push({ pid, cwd: cached.cwd, tty: cached.tty, isDesktop: cached.isDesktop, used: false, sessionId: cached.sessionId, name: cached.name });
      }
      return;
    }
    const isDesktop = /disclaimer/i.test(info.ppidComm) || info.tty === null;
    const sessionId = meta?.sessionId ?? "";
    const name = meta?.name ?? "";
    pidInfoCache.set(pid, { cwd, tty: info.tty, isDesktop, sessionId, name, lastProbedAt: now });
    infos.push({ pid, cwd, tty: info.tty, isDesktop, used: false, sessionId, name });
  }));
  return infos;
}

function bindPid(jsonlSessionId: string, jsonlCwd: string | null, pidInfos: PidInfo[]): PidInfo | null {
  // 1. exact sessionId match via claude metadata — most authoritative signal
  if (jsonlSessionId) {
    for (const p of pidInfos) {
      if (!p.used && p.sessionId === jsonlSessionId) return p;
    }
  }
  // 2. cwd fallback — но НЕ привязывать к pid'у, у которого известен другой sessionId.
  // Иначе старый jsonl украдёт tty у нового claude, запущенного в той же папке/терминале,
  // и пользовательские сообщения уйдут не в ту сессию.
  if (jsonlCwd) {
    for (const p of pidInfos) {
      if (!p.used && p.cwd === jsonlCwd && (!p.sessionId || p.sessionId === jsonlSessionId)) return p;
    }
  }
  return null;
}

function normalizeTitle(s: string): string {
  return s.replace(/…$/, "").trim().toLowerCase();
}

function bindPidByTitle(
  title: string | null,
  pidInfos: PidInfo[],
  tabTitles: Map<string, string>,
  jsonlSessionId?: string,
): PidInfo | null {
  if (!title) return null;
  const target = normalizeTitle(title);
  if (!target) return null;
  for (const [tty, tabTitle] of tabTitles) {
    const tt = normalizeTitle(tabTitle);
    if (tt === target || tt.startsWith(target) || target.startsWith(tt)) {
      // То же условие: не привязывать к pid'у с известным другим sessionId.
      const pid = pidInfos.find(p => !p.used && p.tty === tty && (!p.sessionId || !jsonlSessionId || p.sessionId === jsonlSessionId));
      if (pid) return pid;
    }
  }
  return null;
}

const sessionStickyCache = new Map<string, { session: Session; lastSeenAt: number }>();
const SESSION_STICKY_MS = 30_000;

// Главная сессия (управляющая дашбордом) — закреплена сверху, не удаляется.
const MAIN_SESSION_FILE = join(homedir(), ".cc-dashboard", "main-session.json");
let mainSessionSid: string | null = null;
try {
  const data = await Bun.file(MAIN_SESSION_FILE).json();
  if (data?.sid) mainSessionSid = String(data.sid);
} catch {}

// «Отстойник» — закрытые сессии, скрытые пользователем. Map<sid, {cwd, title}>.
const HIDDEN_SIDS_FILE = join(homedir(), ".cc-dashboard", "hidden-sids.json");
type HiddenInfo = { cwd?: string; title?: string };
let hiddenSids = new Map<string, HiddenInfo>();
try {
  const data = await Bun.file(HIDDEN_SIDS_FILE).json();
  if (Array.isArray(data)) {
    // legacy format — array of strings
    for (const sid of data) hiddenSids.set(sid, {});
  } else if (data && typeof data === "object") {
    for (const [sid, info] of Object.entries(data)) {
      hiddenSids.set(sid, (info && typeof info === "object") ? info as HiddenInfo : {});
    }
  }
} catch {}
async function saveHiddenSids() {
  const obj: Record<string, HiddenInfo> = {};
  for (const [k, v] of hiddenSids) obj[k] = v;
  await Bun.write(HIDDEN_SIDS_FILE, JSON.stringify(obj, null, 2));
}

// Scan installed Claude Code plugins for custom slash commands.
// Plugin commands are .md files with YAML frontmatter (description: ...).
let cachedPluginCommands: Array<{ name: string; desc: string }> | null = null;
let pluginCommandsCachedAt = 0;
const PLUGIN_COMMANDS_TTL_MS = 60_000;

async function discoverPluginCommands(): Promise<Array<{ name: string; desc: string }>> {
  if (cachedPluginCommands && Date.now() - pluginCommandsCachedAt < PLUGIN_COMMANDS_TTL_MS) {
    return cachedPluginCommands;
  }
  const result: Array<{ name: string; desc: string }> = [];
  const dirs: Array<{ path: string; tag: string }> = [
    { path: join(homedir(), ".claude", "commands"), tag: "user" },
  ];
  // Installed plugins
  try {
    const installed = await Bun.file(join(homedir(), ".claude", "plugins", "installed_plugins.json")).json();
    for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
      for (const inst of installs as any[]) {
        if (inst?.installPath) {
          dirs.push({ path: join(inst.installPath, "commands"), tag: String(key).split("@")[0] });
        }
      }
    }
  } catch {}
  for (const { path: dir, tag } of dirs) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const name = "/" + f.replace(/\.md$/, "");
        let desc = `плагин ${tag}`;
        try {
          const content = await Bun.file(join(dir, f)).text();
          const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fm) {
            const dm = fm[1].match(/^description:\s*(.+)$/m);
            if (dm) desc = dm[1].trim().replace(/^["']|["']$/g, "");
          }
        } catch {}
        if (!result.some(r => r.name === name)) result.push({ name, desc });
      }
    } catch {}
  }
  cachedPluginCommands = result;
  pluginCommandsCachedAt = Date.now();
  return result;
}

// === kid-dash интеграция ===
// Опрашиваем kid-dash сервер на 127.0.0.1:8788/api/state. Кэшируем 5 сек.
// Если kid-dash недоступен (нет процесса) — child_active молча считаем false.
const KID_DASH_STATE_TTL_MS = 5000;
let kidDashStateCache: { at: number; value: any | null } = { at: 0, value: null };
async function fetchKidDashState(): Promise<{ child_active: boolean; current_subject: string | null; expected_end: string | null; last_message_ts: string | null } | null> {
  if (Date.now() - kidDashStateCache.at < KID_DASH_STATE_TTL_MS) return kidDashStateCache.value;
  try {
    const r = await fetch("http://127.0.0.1:8788/api/state", { signal: AbortSignal.timeout(1500) });
    if (!r.ok) { kidDashStateCache = { at: Date.now(), value: null }; return null; }
    const v = await r.json();
    kidDashStateCache = { at: Date.now(), value: v };
    return v;
  } catch {
    kidDashStateCache = { at: Date.now(), value: null };
    return null;
  }
}
const KID_DASH_CWD = join(homedir(), "Documents", "клод", "kid-dash");
const KID_DASH_RUNTIME = join(homedir(), ".kid-dash");
// Override-таймаут: мама подтвердила «точно прервать урок» → разблокировка на 60 сек
const KID_DASH_OVERRIDE_DURATION_MS = 60 * 1000;
let kidDashOverrideUntil: number | null = null;
function isKidChatSession(s: { cwd: string }): boolean {
  // Только по CWD ~/.kid-dash/ — title-match убран чтобы не путать с маминой dev-сессией
  // «Kid Dash (mom)» которая живёт в ~/Documents/клод/kid-dash/
  return !!(s.cwd && (s.cwd === KID_DASH_RUNTIME || s.cwd.startsWith(KID_DASH_RUNTIME + "/")));
}

async function snapshot(): Promise<Session[]> {
  const [freshJsonls, pidInfos, tabTitles, selfId] = await Promise.all([
    findAllFreshJsonls(),
    gatherPidInfos(),
    getTabTitles(),
    getSelfSessionId(),
  ]);
  // Также включаем jsonl каждого ЖИВОГО claude-процесса даже если файл не «свежий» (за пределами 24ч).
  // Иначе долго бездействующая, но запущенная сессия показывается как pid-XXXXX без истории.
  const knownPaths = new Set(freshJsonls.map(j => j.path));
  for (const p of pidInfos) {
    if (!p.sessionId) continue;
    try {
      const dirs = await readdir(PROJECTS_DIR);
      for (const d of dirs) {
        const candidate = join(PROJECTS_DIR, d, p.sessionId + ".jsonl");
        if (knownPaths.has(candidate)) continue;
        try {
          const s = await stat(candidate);
          freshJsonls.push({ path: candidate, mtime: s.mtimeMs });
          knownPaths.add(candidate);
          break;
        } catch {}
      }
    } catch {}
  }
  freshJsonls.sort((a, b) => b.mtime - a.mtime);

  const sessions: Session[] = [];
  const now = Date.now();

  // 1. Show sessions with a recent jsonl (the activity-driven view)
  for (const j of freshJsonls) {
    try {
      if (await isHeadlessOrSidechain(j.path)) continue;
      const fileName = j.path.split("/").pop() ?? "";
      const sessionId = fileName.replace(/\.jsonl$/, "");
      const st = await readStatus(j.path);
      if (!st) continue;
      const jsonlCwd = st.recordCwd;
      const customTitle = await getTitleCached(sessionId, j.path);

      // Bind: by sessionId (from claude metadata) first, then cwd, then tab-title.
      let bound = bindPid(sessionId, jsonlCwd, pidInfos);
      if (!bound) bound = bindPidByTitle(customTitle, pidInfos, tabTitles, sessionId);
      if (bound) bound.used = true;

      // Filter out orphan jsonls (no live pid bound) older than ORPHAN_MAX_AGE_MS —
      // these are historical session files whose process has already exited.
      if (!bound && now - j.mtime > ORPHAN_MAX_AGE_MS) continue;

      const cwd = jsonlCwd ?? bound?.cwd ?? "unknown";
      const tabTitle = bound?.tty ? tabTitles.get(bound.tty) ?? null : null;
      // Title precedence: customTitle (jsonl, /rename) > metadata name (/title) > tab title > nothing
      const title = customTitle ?? (bound?.name || null) ?? tabTitle;
      sessions.push({
        pid: bound?.pid ?? -1,
        sessionId,
        title,
        cwd,
        cwdLabel: cwd.replace(homedir(), "~"),
        tty: bound?.tty ?? null,
        isDesktop: bound ? bound.isDesktop : true,
        isSelf: selfId !== "" && sessionId === selfId,
        status: st.status,
        lastActivity: st.lastActivity,
        lastActivityRel: relTime(st.lastActivity),
        busySince: st.busySince,
        inputTokens: st.inputTokens,
        limitHit: st.limitHit,
        limitResetAt: st.limitResetAt,
        isMain: mainSessionSid !== null && sessionId === mainSessionSid,
        hasOpenQuestion: !!st.openQuestionId,
      });

      sessionMeta.set(sessionId, {
        jsonlPath: j.path,
        tty: bound?.tty ?? null,
        cwd,
        pid: bound?.pid ?? -1,
      });
    } catch (e) {
      console.error(`session ${j.path}:`, e);
    }
  }

  // 2. Stub cards for live terminal processes that didn't bind to any jsonl —
  //    these are running terminal windows that haven't written to a jsonl recently.
  //    Skip desktop/headless processes without tty — they're rarely useful as standalone cards.
  for (const p of pidInfos) {
    if (p.used) continue;
    if (!p.tty) continue;
    const stubId = `pid-${p.pid}`;
    const tabTitle = tabTitles.get(p.tty) ?? null;
    sessions.push({
      pid: p.pid,
      sessionId: stubId,
      title: p.name || tabTitle,
      cwd: p.cwd,
      cwdLabel: p.cwd.replace(homedir(), "~"),
      tty: p.tty,
      isDesktop: p.isDesktop,
      isSelf: false,
      status: "idle",
      lastActivity: new Date(0).toISOString(),
      lastActivityRel: "—",
    });
    sessionMeta.set(stubId, { jsonlPath: "", tty: p.tty, cwd: p.cwd, pid: p.pid });
  }

  // 3. Sticky merge: if a session was in the previous snapshot but is missing now,
  //    keep it for SESSION_STICKY_MS. Eliminates flicker from transient probe failures.
  const freshIds = new Set(sessions.map(s => s.sessionId));
  for (const s of sessions) sessionStickyCache.set(s.sessionId, { session: s, lastSeenAt: now });
  for (const [sid, entry] of sessionStickyCache) {
    if (freshIds.has(sid)) continue;
    if (now - entry.lastSeenAt > SESSION_STICKY_MS) {
      sessionStickyCache.delete(sid);
      continue;
    }
    sessions.push(entry.session);
  }

  // TUI live AskUserQuestion: для каждой сессии с tty читаем visible-contents Terminal-вкладки
  // и парсим открытый модал. Это вылавливает вопросы, которые claude ещё не флашнул в jsonl.
  try {
    const all = await readAllTerminalContents();
    for (const s of sessions) {
      if (!s.tty) continue;
      if (s.hasOpenQuestion) continue;  // уже есть jsonl-based, не перезаписываем
      const text = all.get(s.tty);
      if (!text) continue;
      const q = parseTuiModal(text);
      if (q) {
        s.hasOpenQuestion = true;
        s.openQuestion = q;
      }
    }
  } catch (e) {
    console.error("[tui-scrape]", e);
  }

  // kid-dash интеграция: помечаем Ребёнок-чат-сессию + блокировка по child_active
  try {
    const kdState = await fetchKidDashState();
    const overrideUntil = kidDashOverrideUntil;  // см. ниже — мама может временно разблокировать на минуту
    const overrideActive = overrideUntil && Date.now() < overrideUntil;
    for (const s of sessions) {
      if (isKidChatSession(s)) {
        const blocked = !overrideActive && !!(kdState?.child_active);
        s.kidDash = {
          isChildChat: true,
          isBlocked: blocked,
          currentSubject: kdState?.current_subject ?? null,
          expectedEnd: kdState?.expected_end ?? null,
        };
      }
    }
  } catch (e) {
    console.error("[kid-dash sync]", e);
  }

  // Отфильтровать скрытые пользователем сессии (плюс по пути обновим cwd/title в hiddenSids)
  if (hiddenSids.size > 0) {
    for (const s of sessions) {
      if (hiddenSids.has(s.sessionId)) {
        hiddenSids.set(s.sessionId, { cwd: s.cwd, title: s.title || undefined });
      }
    }
    return sessions.filter(s => !hiddenSids.has(s.sessionId));
  }
  return sessions;
}

interface QuestionOption { label: string; description?: string; isFreeText?: boolean; tuiNum?: number }
interface OpenQuestion {
  toolUseId: string;
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  answered: boolean;
  answeredWith?: string;
  // Multi-tab modal: claude задал несколько вопросов сразу + одна кнопка Submit (header вида
  // «← ☐ Tab1 ☐ Tab2 ✔ Submit →»). Dashboard показывает по одному вопросу за раз с кнопкой Далее.
  isMultiTab?: boolean;
  // Внутри multi-tab — финальный экран подтверждения («Review your answers / Submit answers / Cancel»).
  // Dashboard рендерит кнопку «Отправить ответы».
  isSubmitReview?: boolean;
}
interface Message {
  role: "user" | "assistant" | "tool" | "question";
  text: string;
  ts: string;
  question?: OpenQuestion;
}

function compactToolUse(item: any): string {
  const name = item?.name ?? "?";
  const input = item?.input ?? {};
  const keys = Object.keys(input);
  if (name === "Bash" && typeof input.command === "string") {
    return `🔧 Bash \`${input.command.slice(0, 200)}\``;
  }
  if (name === "Read" && typeof input.file_path === "string") {
    return `📖 Read \`${input.file_path}\``;
  }
  if (name === "Edit" && typeof input.file_path === "string") {
    return `✏️ Edit \`${input.file_path}\``;
  }
  if (name === "Write" && typeof input.file_path === "string") {
    return `📝 Write \`${input.file_path}\``;
  }
  if (name === "WebFetch" && typeof input.url === "string") {
    return `🌐 WebFetch \`${input.url}\``;
  }
  if (name === "Grep" && typeof input.pattern === "string") {
    return `🔍 Grep \`${input.pattern}\``;
  }
  if (name === "Glob" && typeof input.pattern === "string") {
    return `🗂 Glob \`${input.pattern}\``;
  }
  if (name === "TodoWrite") {
    return `☑️ TodoWrite`;
  }
  const preview = keys.slice(0, 2).map(k => `${k}=${JSON.stringify(input[k]).slice(0, 60)}`).join(", ");
  return `🔧 ${name}(${preview})`;
}

function compactToolResult(item: any): string {
  const content = item?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((c: any) => typeof c?.text === "string" ? c.text : "").join("");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 200) text = text.slice(0, 200) + "…";
  return `✓ ${text}`;
}

async function readMessages(jsonlPath: string, limitBytes = 256 * 1024): Promise<Message[]> {
  // Adaptive: стартуем с limitBytes (или с полного размера файла, если он меньше), при недостатке user/assistant
  // расширяем окно до 16МБ. Без этого маленькие jsonl'ы (< 256КБ) пропускали первое чтение из-за условия.
  const file = Bun.file(jsonlPath);
  const totalSize = file.size;
  let win = Math.min(limitBytes, Math.max(totalSize, 4096));
  let messages: Message[] = [];
  let firstPass = true;
  while (firstPass || (messages.length < 5 && win < 16 * 1024 * 1024)) {
    firstPass = false;
    const text = await readTail(jsonlPath, win);
    const lines = text.split("\n").filter(l => l.trim().startsWith("{"));
    messages = [];
    for (const line of lines) {
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      const ts = rec.timestamp ?? "";
      if (rec.type === "user") {
        const content = rec.message?.content;
        if (typeof content === "string") {
          messages.push({ role: "user", text: content, ts });
        } else if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const item of content) {
            if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
            else if (item?.type === "tool_result") messages.push({ role: "tool", text: compactToolResult(item), ts });
          }
          if (texts.length) messages.push({ role: "user", text: texts.join("\n"), ts });
        }
      } else if (rec.type === "assistant") {
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "text" && typeof item.text === "string" && item.text.trim().length) {
              messages.push({ role: "assistant", text: item.text, ts });
            } else if (item?.type === "tool_use" && item?.name === "AskUserQuestion") {
              // Render AskUserQuestion as a structured "question" message — frontend shows clickable options
              const q = item?.input?.questions?.[0];
              if (q && typeof q.question === "string" && Array.isArray(q.options)) {
                messages.push({
                  role: "question",
                  text: q.question,
                  ts,
                  question: {
                    toolUseId: item.id,
                    question: q.question,
                    header: q.header,
                    multiSelect: !!q.multiSelect,
                    options: q.options.map((o: any) => ({ label: String(o.label ?? ""), description: o.description })),
                    answered: false,
                  },
                });
              }
            } else if (item?.type === "tool_use") {
              messages.push({ role: "tool", text: compactToolUse(item), ts });
            }
          }
        }
      }
    }
    // Pass 2: mark questions as answered if a matching tool_result is present in the same window
    // (Re-scan the source lines to find tool_results whose tool_use_id matches a question.)
    const answers = new Map<string, string>(); // toolUseId → answer label
    for (const line of lines) {
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== "user") continue;
      const c = rec.message?.content;
      if (!Array.isArray(c)) continue;
      for (const item of c) {
        if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
          // tool_result content may be string with answer info; also rec.toolUseResult.answers
          let ans = "";
          const txt = typeof item.content === "string" ? item.content
                    : Array.isArray(item.content) ? item.content.map((x: any) => x?.text ?? "").join("") : "";
          const m = txt.match(/"([^"]+)"="([^"]+)"/);
          if (m) ans = m[2];
          if (!ans && rec.toolUseResult?.answers) {
            const vals = Object.values(rec.toolUseResult.answers);
            if (vals.length) ans = String(vals[0]);
          }
          if (ans) answers.set(item.tool_use_id, ans);
          else answers.set(item.tool_use_id, "(answered)");
        }
      }
    }
    for (const m of messages) {
      if (m.role === "question" && m.question) {
        const a = answers.get(m.question.toolUseId);
        if (a) { m.question.answered = true; m.question.answeredWith = a === "(answered)" ? undefined : a; }
      }
    }
    if (win >= totalSize) break;
    win *= 4;
  }
  return messages.slice(-50);
}

const APPLESCRIPT_BODY = `on run argv
  set ttyArg to item 1 of argv
  set actionArg to item 2 of argv
  set msgArg to ""
  if (count of argv) > 2 then set msgArg to item 3 of argv
  set targetTty to "/dev/" & ttyArg

  -- Pre-load clipboard as a manual fallback
  if actionArg is "send" then
    try
      set the clipboard to msgArg
    end try
  end if

  try
    tell application "iTerm"
      if it is running then
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              try
                if (tty of s) is targetTty then
                  if actionArg is "focus" then
                    select t
                    tell w to set frontmost to true
                    activate
                  else if actionArg is "send" then
                    -- write text delivers to the session's stdin without focus jump
                    tell s to write text msgArg
                  end if
                  return "iTerm"
                end if
              end try
            end repeat
          end repeat
        end repeat
      end if
    end tell
  end try

  try
    tell application "Terminal"
      if it is running then
        -- Развернуть свёрнутые окна — AppleScript не видит tabs минимизированных окон.
        repeat with w in windows
          try
            if miniaturized of w then set miniaturized of w to false
          end try
        end repeat
        repeat with w in windows
          try
          repeat with t in tabs of w
            try
              if (tty of t) is targetTty then
                if actionArg is "focus" then
                  set selected of t to true
                  set frontmost of w to true
                  activate
                else if actionArg is "send" then
                  -- Make t the current tab inside Terminal (no activate → no OS focus jump),
                  -- then do script targets it correctly via "in t".
                  set selected of t to true
                  set frontmost of w to true
                  do script msgArg in t
                  -- Multi-line paste leaves claude REPL waiting; an extra empty Enter commits it.
                  delay 0.15
                  do script "" in t
                end if
                return "Terminal"
              end if
            end try
          end repeat
          end try
        end repeat
      end if
    end tell
  end try

  return "none"
end run`;

const RESTORE_SCRIPT = `on run argv
  set cwdArg to item 1 of argv
  set sidArg to item 2 of argv
  set cmd to "cd " & quoted form of cwdArg & " && claude --resume " & sidArg
  -- Без activate — пользователь остаётся в дашборде/браузере, Terminal не вылезает.
  tell application "Terminal"
    do script cmd
  end tell
  -- Скрыть Terminal сразу после запуска, чтобы окно не оставалось перед глазами.
  delay 0.5
  try
    tell application "System Events" to set visible of process "Terminal" to false
  end try
  return "ok"
end run`;

async function restoreSession(sessionId: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["osascript", "-e", RESTORE_SCRIPT, "--", cwd, sessionId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const stderr = err.trim();
  console.log(`[restore sid=${sessionId.slice(0, 8)} cwd=${cwd}] out="${out.trim()}" stderr="${stderr}"`);
  if (stderr) return { ok: false, error: stderr };
  return { ok: true };
}

// Отправка реальных нажатий клавиш в TUI-модал (AskUserQuestion и т.п.) — paste не работает,
// модал ждёт стрелки/Enter. Через System Events key code (layout-independent: 125=down, 36=return).
// === TUI screen-scrape: читать visible-contents Terminal-вкладок для детекта живого AskUserQuestion-модала ===
// Claude Code НЕ пишет AskUserQuestion в jsonl, пока пользователь не ответит. Чтобы показать модал в дашборде
// до ответа, надо парсить visible-text из Terminal.app.
const TUI_SCRAPE_TTL_MS = 4000;
let tuiContentsCache: { at: number; byTty: Map<string, string> } = { at: 0, byTty: new Map() };

async function readAllTerminalContents(): Promise<Map<string, string>> {
  if (Date.now() - tuiContentsCache.at < TUI_SCRAPE_TTL_MS) return tuiContentsCache.byTty;
  const script = `set sepStart to "|||TTYSTART|||"
set sepEnd to "|||TTYEND|||"
set acc to ""
tell application "Terminal"
  if it is running then
    repeat with w in windows
      try
        repeat with i from 1 to (count of tabs of w)
          try
            set t to tab i of w
            set ttyStr to tty of t
            set cont to history of t
            set acc to acc & sepStart & ttyStr & "|||CONTENT|||" & cont & sepEnd
          end try
        end repeat
      end try
    end repeat
  end if
end tell
return acc`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (err.trim()) console.error("[tui-scrape] stderr:", err.trim().slice(0, 200));
  const byTty = new Map<string, string>();
  const blocks = out.split("|||TTYSTART|||").slice(1);
  for (const block of blocks) {
    const endIdx = block.indexOf("|||TTYEND|||");
    if (endIdx < 0) continue;
    const body = block.slice(0, endIdx);
    const sepIdx = body.indexOf("|||CONTENT|||");
    if (sepIdx < 0) continue;
    const ttyPath = body.slice(0, sepIdx).trim();
    const text = body.slice(sepIdx + "|||CONTENT|||".length);
    const ttyShort = ttyPath.replace(/^\/dev\//, "");
    byTty.set(ttyShort, text);
  }
  tuiContentsCache = { at: Date.now(), byTty };
  return byTty;
}

// Парсит из visible-text Claude Code TUI модал AskUserQuestion.
// Шаблон:
//   <header (опц.)>
//   <question text>
//   1. <label1>
//      <desc1?>
//   2. <label2>
//   ...
//   N. Chat about this    ← это всегда последний пункт, escape hatch, в options не включаем
//   Enter to select | ↑/↓ to navigate | Esc to cancel
function parseTuiModal(text: string): OpenQuestion | null {
  if (!text) return null;
  // Допустимые маркеры модала:
  //   - стандартный: «Enter to select · ↑/↓ to navigate · Esc to cancel»
  //   - Submit Review (без нижней нав-строки): «Ready to submit your answers?» + «Submit answers / Cancel»
  const hasStandardMarker = /Enter to select|to navigate|Esc to cancel/i.test(text);
  const hasSubmitReview = /Ready to submit your answers/i.test(text) && /Submit answers/i.test(text);
  if (!hasStandardMarker && !hasSubmitReview) return null;
  const rawLines = text.split(/\r?\n/);
  let markerIdx = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (/Enter to select|to navigate/i.test(rawLines[i])) { markerIdx = i; break; }
  }
  // Submit Review screen — нав-маркера нет, используем последнюю строку с опцией «2. Cancel» как anchor
  if (markerIdx < 0 && hasSubmitReview) {
    for (let i = rawLines.length - 1; i >= 0; i--) {
      if (/^\s*2\.\s+Cancel\s*$/i.test(rawLines[i])) { markerIdx = i + 1; break; }
    }
  }
  if (markerIdx < 0) return null;

  const optionRe = /^[›❯>]?\s*(\d+)\.\s+(.+?)\s*$/;
  const isSeparator = (l: string) => /^[─━═║│┃╮╭╯╰┌┐└┘╲╱]+$/.test(l);

  // Pass 1: найти все строки опций над маркером (в обратном порядке)
  const optionLineIndices: number[] = [];
  let firstOptLine = -1;
  for (let i = markerIdx - 1; i >= 0 && i > markerIdx - 80; i--) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    if (isSeparator(trimmed)) continue;
    if (optionRe.test(trimmed)) {
      optionLineIndices.unshift(i);
      firstOptLine = i;
      continue;
    }
    if (optionLineIndices.length > 0) {
      // Не опция и не разделитель — описание или конец блока
      const rawLine = rawLines[i];
      const leading = rawLine.length - rawLine.replace(/^\s+/, "").length;
      const firstCh = trimmed.charAt(0);
      // ВАЖНО: /[а-я]/i без флага /u в JS НЕ case-folds Кириллицу, поэтому явно перечисляем оба регистра
      const looksDesc = leading >= 4 || /[a-zA-Zа-яА-ЯёЁ]/.test(firstCh);
      if (looksDesc) continue;
      break;
    }
  }
  if (optionLineIndices.length < 1) return null;

  // Pass 2: для каждой опции собрать label + description (отступленные строки до следующей опции)
  const opts: { num: number; label: string; description?: string }[] = [];
  for (let k = 0; k < optionLineIndices.length; k++) {
    const optIdx = optionLineIndices[k];
    const nextOptIdx = (k + 1 < optionLineIndices.length) ? optionLineIndices[k + 1] : markerIdx;
    const labelMatch = optionRe.exec(rawLines[optIdx].trim());
    if (!labelMatch) continue;
    const descLines: string[] = [];
    for (let j = optIdx + 1; j < nextOptIdx; j++) {
      const raw = rawLines[j];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (isSeparator(trimmed)) continue;
      descLines.push(trimmed);
    }
    // Чистим чекбокс-префикс «[ ]» / «[✔]» / «[✓]» и лидирующий ❯ (выбор-маркер)
    const cleanedLabel = labelMatch[2]
      .replace(/^[›❯>]\s*/, "")
      .replace(/^\[[\s✔☑✓☐x✗]\]\s*/u, "")
      .trim();
    opts.push({
      num: parseInt(labelMatch[1], 10),
      label: cleanedLabel,
      description: descLines.join(" ").trim() || undefined,
    });
  }

  // «Chat about this» — TUI escape hatch (выход из модала без ответа), всегда отбрасываем.
  // «Type something» — это free-text option, оставляем но помечаем isFreeText=true, чтобы фронт показал input.
  const filtered = opts
    .filter(o => !/^Chat about this$/i.test(o.label))
    .map(o => /^Type something\.?$/i.test(o.label) ? { ...o, label: "Свой вариант…", isFreeText: true } : o);
  if (filtered.length < 1) return null;

  // Поднимаемся выше firstOptLine — ищем сам вопрос (приоритет строкам, заканчивающимся на ?),
  // потом header. Пропускаем сильно отступленные строки (это описания опций при испорченном дисплее).
  let question = "";
  let questionFallback = "";
  let questionLineIdx = -1;
  for (let i = firstOptLine - 1; i >= 0 && i > firstOptLine - 25; i--) {
    const rawLine = rawLines[i];
    const cleaned = rawLine.replace(/^[\s│┃╮╭]+|[\s│┃╯╰]+$/g, "").trim();
    if (!cleaned) {
      if (question || questionFallback) {
        if (rawLines[i-1] && rawLines[i-1].trim()) continue;  // одна пустая ОК
        break;
      }
      continue;
    }
    if (isSeparator(cleaned)) continue;
    // Пропускаем сильно отступленные строки — это «описание» опций, могло «выехать» в зону вопроса при кривом дисплее
    const leading = rawLine.length - rawLine.replace(/^\s+/, "").length;
    if (leading >= 4) continue;
    if (cleaned.endsWith("?") && !question) {
      question = cleaned;
      questionLineIdx = i;
      break;  // вопрос найден, дальше идём искать header
    }
    if (!questionFallback) {
      questionFallback = cleaned;
      questionLineIdx = i;
    }
  }
  if (!question) question = questionFallback;
  if (!question) return null;
  // Header — выше вопроса, обычно короткая строка с чекбоксом ☐
  let header: string | undefined;
  let isMultiTab = false;
  for (let i = questionLineIdx - 1; i >= 0 && i > questionLineIdx - 10; i--) {
    const cleaned = rawLines[i].replace(/^[\s│┃╮╭]+|[\s│┃╯╰]+$/g, "").trim();
    if (!cleaned) continue;
    if (isSeparator(cleaned)) continue;
    // Multi-tab detection: header вида «← ☐ Tab1 ☐ Tab2 ✔ Submit →»
    // Признаки: ←/→ стрелки навигации ИЛИ ≥2 чекбоксов в одной строке, ИЛИ Submit в строке
    const hasNavArrows = /[←→]/.test(cleaned);
    const checkboxCount = (cleaned.match(/[☐☑✓✗▢▣]/g) || []).length;
    const hasSubmit = /\bSubmit\b/i.test(cleaned);
    if (hasNavArrows || checkboxCount >= 2 || hasSubmit) {
      isMultiTab = true;
      // Берём весь header как есть (для отображения в UI)
      header = cleaned;
    } else {
      const dehead = cleaned.replace(/^[☐☑✓✗▢▣◯◉●○]\s*/, "").trim();
      if (dehead && dehead.length <= 60 && !dehead.endsWith("?")) {
        header = dehead;
      }
    }
    break;
  }
  // Стабильный хэш: нормализуем пробелы + добавляем сигнатуру первых опций (это устойчивее чем чистый question)
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const sig = normalize(question) + "|" + filtered.slice(0, 3).map(o => normalize(o.label)).join("|");
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) - h + sig.charCodeAt(i)) | 0;
  const toolUseId = "tui-" + Math.abs(h).toString(36);
  // Submit-review экран: «Review your answers» с опциями «Submit answers / Cancel»
  const isSubmitReview = isMultiTab && filtered.some(o => /^(Submit answers|Cancel)$/i.test(o.label));
  return {
    toolUseId,
    question,
    header,
    multiSelect: false,
    options: filtered.map(o => ({ label: o.label, description: o.description, isFreeText: (o as any).isFreeText, tuiNum: o.num })),
    answered: false,
    isMultiTab,
    isSubmitReview,
  };
}

async function getTuiQuestion(tty: string | null): Promise<OpenQuestion | null> {
  if (!tty) return null;
  const all = await readAllTerminalContents();
  const text = all.get(tty);
  if (!text) return null;
  return parseTuiModal(text);
}

// === macOS CGEvent: шлём keyboard events напрямую в процесс Terminal через CGEventPostToPid.
// Это позволяет инжектить клавиши БЕЗ переключения system-wide focus — Terminal не вылезает.
// Требует Accessibility-permission для процесса Bun (System Settings > Privacy & Security > Accessibility).
let cgSymbols: any = null;
let cfSymbols: any = null;
let cgLoadAttempted = false;
function loadCG(): boolean {
  if (cgLoadAttempted) return !!cgSymbols;
  cgLoadAttempted = true;
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    cgSymbols = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
      CGEventPostToPid: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
      CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    }).symbols;
    cfSymbols = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    }).symbols;
    return true;
  } catch (e) {
    console.error("[CG] load failed:", e);
    return false;
  }
}

function cgSendKey(pid: number, keyCode: number) {
  const down = cgSymbols.CGEventCreateKeyboardEvent(null, keyCode, true);
  cgSymbols.CGEventPostToPid(pid, down);
  cfSymbols.CFRelease(down);
  const up = cgSymbols.CGEventCreateKeyboardEvent(null, keyCode, false);
  cgSymbols.CGEventPostToPid(pid, up);
  cfSymbols.CFRelease(up);
}

function cgSendText(pid: number, text: string) {
  const { ptr } = require("bun:ffi");
  for (const char of text) {
    const codes: number[] = [];
    for (let i = 0; i < char.length; i++) codes.push(char.charCodeAt(i));
    const utf16 = new Uint16Array(codes);
    const buf = Buffer.from(utf16.buffer, utf16.byteOffset, utf16.byteLength);
    const down = cgSymbols.CGEventCreateKeyboardEvent(null, 0, true);
    cgSymbols.CGEventKeyboardSetUnicodeString(down, codes.length, ptr(buf));
    cgSymbols.CGEventPostToPid(pid, down);
    cfSymbols.CFRelease(down);
    const up = cgSymbols.CGEventCreateKeyboardEvent(null, 0, false);
    cgSymbols.CGEventKeyboardSetUnicodeString(up, codes.length, ptr(buf));
    cgSymbols.CGEventPostToPid(pid, up);
    cfSymbols.CFRelease(up);
  }
}

let terminalPidCache: { pid: number; at: number } | null = null;
async function getTerminalPid(): Promise<number | null> {
  if (terminalPidCache && Date.now() - terminalPidCache.at < 60000) return terminalPidCache.pid;
  const proc = Bun.spawnSync(["pgrep", "-x", "Terminal"]);
  const out = proc.stdout.toString().trim();
  const pid = parseInt(out.split("\n")[0], 10);
  if (Number.isInteger(pid) && pid > 0) {
    terminalPidCache = { pid, at: Date.now() };
    return pid;
  }
  return null;
}

// Отправка произвольного текста в TUI через CGEventKeyboardSetUnicodeString (для multi-tab Type something).
async function sendTextToTui(tty: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!text) return { ok: false, error: "empty text" };
  const termPid = await getTerminalPid();
  if (!termPid) return { ok: false, error: "Terminal not found" };
  const selectScript = `on run argv
    set targetTty to "/dev/" & (item 1 of argv)
    tell application "Terminal"
      repeat with w in windows
        try
          repeat with t in tabs of w
            try
              if (tty of t) is targetTty then
                set selected of t to true
                set frontmost of w to true
                set index of w to 1
                return "ok"
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
    return "tty not found"
  end run`;
  const sel = Bun.spawnSync(["osascript", "-e", selectScript, "--", tty]);
  if (sel.stdout.toString().trim() !== "ok") return { ok: false, error: "tab not found" };
  if (!loadCG()) return { ok: false, error: "CG FFI failed" };
  await new Promise(r => setTimeout(r, 80));
  cgSendText(termPid, text);
  console.log(`[type-text ${tty}] len=${text.length} CG-direct OK pid=${termPid}`);
  return { ok: true };
}

// Универсальная отправка raw-клавиш в TUI-вкладку через CGEventPostToPid.
// Используется для multi-tab навигации (left/right arrows), Submit (enter на нужной вкладке), Esc (отмена модала).
async function sendRawKey(tty: string, key: "left" | "right" | "up" | "down" | "enter" | "escape"): Promise<{ ok: boolean; error?: string }> {
  const keyMap: Record<string, number> = {
    left: 123, right: 124, down: 125, up: 126, enter: 36, escape: 53,
  };
  const keyCode = keyMap[key];
  if (keyCode === undefined) return { ok: false, error: "invalid key" };

  const termPid = await getTerminalPid();
  if (!termPid) return { ok: false, error: "Terminal not found" };

  // Set tab selected + bring its window to TERMINAL'S front (не системный фронт — Safari остаётся фронт),
  // чтобы CGEvent шёл именно в этот таб, а не в чужой.
  const selectScript = `on run argv
    set targetTty to "/dev/" & (item 1 of argv)
    tell application "Terminal"
      repeat with w in windows
        try
          repeat with t in tabs of w
            try
              if (tty of t) is targetTty then
                set selected of t to true
                set frontmost of w to true
                set index of w to 1
                return "ok"
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
    return "tty not found"
  end run`;
  const sel = Bun.spawnSync(["osascript", "-e", selectScript, "--", tty]);
  if (sel.stdout.toString().trim() !== "ok") return { ok: false, error: "tab not found" };

  if (!loadCG()) return { ok: false, error: "CG FFI failed" };
  // Маленькая задержка чтобы Terminal успел переключить front-tab внутри своего стека
  await new Promise(r => setTimeout(r, 80));
  cgSendKey(termPid, keyCode);
  console.log(`[send-raw-key ${tty}] key=${key} (code=${keyCode}) CG-direct OK pid=${termPid}`);
  return { ok: true };
}

async function answerTuiQuestion(tty: string, optionIndex: number, freeText?: string): Promise<{ ok: boolean; error?: string }> {
  if (optionIndex < 1 || optionIndex > 9) return { ok: false, error: "optionIndex out of range 1-9" };
  const downs = optionIndex - 1;
  const termPid = await getTerminalPid();
  if (!termPid) return { ok: false, error: "Terminal process not found" };
  // Шаг 1: AppleScript — БЕЗ `activate` Terminal'а, только выбираем нужную вкладку внутри Terminal.
  // Это не переключает system focus.
  const selectScript = `on run argv
    set targetTty to "/dev/" & (item 1 of argv)
    tell application "Terminal"
      repeat with w in windows
        try
          repeat with t in tabs of w
            try
              if (tty of t) is targetTty then
                set selected of t to true
                set frontmost of w to true
                set index of w to 1
                return "ok"
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
    return "tty not found"
  end run`;
  const sel = Bun.spawnSync(["osascript", "-e", selectScript, "--", tty]);
  const selOut = sel.stdout.toString().trim();
  if (selOut !== "ok") return { ok: false, error: "tab " + tty + " not found in Terminal" };
  // Маленькая задержка чтобы Terminal успел переключить front-tab
  await new Promise(r => setTimeout(r, 80));
  // Шаг 2: грузим CG-FFI
  if (!loadCG()) return { ok: false, error: "CGEvent FFI failed to load" };
  // Шаг 3: посылаем клавиши через CGEventPostToPid → Terminal-процесс (без focus)
  try {
    for (let i = 0; i < downs; i++) {
      cgSendKey(termPid, 125);  // Down arrow
      await new Promise(r => setTimeout(r, 60));
    }
    await new Promise(r => setTimeout(r, 150));
    if (!freeText || freeText.length === 0) {
      cgSendKey(termPid, 36);  // Enter
    } else {
      cgSendText(termPid, freeText);
      await new Promise(r => setTimeout(r, 200));
      cgSendKey(termPid, 36);  // Enter to submit
    }
    console.log(`[answer-question ${tty} idx=${optionIndex} freeText=${freeText ? "yes(" + freeText.length + ")" : "no"}] CG-direct OK pid=${termPid}`);
    return { ok: true };
  } catch (e: any) {
    console.error("[answer-question] CG error:", e?.message || e);
    return { ok: false, error: "CG inject failed: " + (e?.message || String(e)) };
  }
}

async function controlTerminal(tty: string, action: "focus" | "send", msg = ""): Promise<{ result: string; stderr: string }> {
  const proc = Bun.spawn(["osascript", "-e", APPLESCRIPT_BODY, "--", tty, action, msg], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const result = out.trim();
  const stderr = err.trim();
  console.log(`[osascript ${action} ${tty}] result="${result}" stderr="${stderr}"`);
  return { result, stderr };
}

const MANIFEST_JSON = JSON.stringify({
  name: "CC Dashboard",
  short_name: "CC Dashboard",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#0d1117",
  theme_color: "#0d1117",
  icons: [
    { src: "/icon.svg?v=2", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <style>@font-face{font-family:'UC';font-weight:700;src:url(data:font/woff2;base64,d09GMgABAAAAAAO8ABEAAAAACJgAAANkB9sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhQbEBwaBmAANAgECYVmEQgKdIEGATYCJAMICwYABCAFhQwHIAwHG34HSC4KbGPa4EV4sEaPSK++ljHLisJwCDEEUY7lXpIHKhCPJ0BF4IEkqgpHrkL3dTWQQ1Kdqj/aJjOva7uGSWPRPT8icvy494Mz7z7i3CC/G4SEZIXmdFu6oSmCfQt98RPJ7jZKJKRAQklCimL9vqr66PrD/Wz6trZ9HFbgQCqI5qOMujuqtGiC407g4wOhUz9F3eaIaEOKXjyDAG4AQFwMnBMYPxdDV4aZa8x0TI9q+uRaaP2n7jUWyGMNpxK7smml0QACJGQ1YK27RrHrGY2wLn8ZRUq0j40ETYhBN0K0kCbSJgEMSLIi0aH8Q35rFupBzhLsrepKZJdEfEeonDfY0SOtMYLkAOQN5LKMxggqR5AsjBF0DuSzTs2vVnaC9YT1uu71hHzo7+hmk9rUjX6rZ70vDpiOPQBM50YupfBsVg9RcoxgUBjjXe+TIRiEYAZ15iWuGMGSUwKs0ypVleK1ynBtzbXfQYQ89rb2srcyGoliBCutrpmaHwjhBpvPmmWcdpC1xllLTZG+uzmQtSOvuXL0ejIlRwleq1bAlfoFO4d1ap7IWuV4fs2O4cprR/8mCkfKjREcOSU1Ki9XkJC24bx3ERe4MS7Fe1Ay+8nuL0UABKID/mqQEA7+lKaB+MIfAAWA6UzGw8iDDQMvUGHWxZ/us43av7vOt6i/O/0/XKybrRv+Yq3Xnv31koCMifYZp2koKuq2YLOlejGzMOii1+t4xNZadX30G3DpnPrVbUkdR9/HDg+aP0++8+83V/kKAAK2W5y+yHGbd+G/xd0OwOnSHgBPKckJ8Wamzugj2FEACPwCXtv7AmK+j9A0yK1qki8LhlzN4oAifnMLCNEHPIqNfi3EOEAWNJjPFGJqgamwyzZT0157a80ypoW0evpJK2ntpkIoUkvYTJYMIKhIQCIQCYCDA3A+RGXFgqCUS2VUW8Z674supUsUdBqwEwoS7hvEp3N/BWzGXMSVySUstnDgdJwhFyKQGw+67LjzwZ9NZ9J5kLOddLLYUgrbuwNGo4QkNMZFl3lsKl0gJW/lAhoeyVh6wNyjC3AXLZ8HX3+BAOP46UTKXtYAIq5a8vUnV0IeDa1vOpKL6a8O3GnA8gmNi0ZFLBn7iRuLROapBEtYqnPLQXtYwp23yPV/ZJzNDgA=) format('woff2');}</style>
  </defs>
  <rect width="512" height="512" rx="96" fill="#000000"/>
  <rect x="32" y="32" width="448" height="448" rx="72" fill="none" stroke="#ffffff" stroke-width="6" opacity="0.85"/>
  <text x="256" y="256" font-family="UC" font-weight="700" font-size="340" fill="#ffffff" text-anchor="middle" dominant-baseline="central">CC</text>
</svg>`;

const SERVICE_WORKER_JS = `
const CACHE = "cc-dashboard-v27";
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/"])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  // Network-first для главной HTML страницы. Если сервер недоступен — отдаём кэш с offline-баннером.
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname === "/" || url.pathname === "/login") {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        const cache = await caches.open(CACHE);
        cache.put("/", fresh.clone()).catch(() => {});
        return fresh;
      } catch (err) {
        const cached = await caches.match("/");
        if (cached) return cached;
        return new Response("<h1>Нет связи с дашбордом</h1><p>Не удалось загрузить страницу. Проверь интернет.</p>", { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
      }
    })());
  }
});
self.addEventListener('push', e => {
  let data = { title: 'CC Dashboard', body: '', tag: undefined };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    icon: '/icon-192.png?v=2',
    badge: '/icon-192.png?v=2',
    data: { url: '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes(self.registration.scope) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
`;

const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0d1117" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="CC Dashboard" />
<link rel="manifest" href="/manifest.json" />
<link rel="icon" type="image/svg+xml" href="/icon.svg?v=2" />
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=2" />
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png?v=2" />
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png?v=2" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&family=Pirata+One&display=swap" rel="stylesheet">
<title> </title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 -apple-system, "SF Pro Text", system-ui, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 16px; height: 100vh; max-height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  /* Chrome fullscreen on macOS slides a toolbar over the top ~60px when cursor hits the top edge.
     Detection via JS: body.chrome-fs is set when window covers the whole screen.
     В фуллскрине прижимаем body к 100vh с overflow:hidden, чтобы выезжающий тулбар Chrome
     не показывал «дырку» под собой и не было лишнего скроллбара. Скролл живёт внутри .feed. */
  body.chrome-fs { padding-top: 64px; height: 100vh; max-height: 100vh; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  h1 { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: clamp(26px, 4.5vw, 42px); font-weight: 700; margin: 0; flex: 1; min-width: 0; color: #f0f6fc; text-align: center; letter-spacing: 0.04em; line-height: 1.05; text-shadow: 0 0 14px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.5); }
  h1 .logo-text { position: relative; cursor: pointer; user-select: none; display: inline-block; transition: text-shadow 0.15s; }
  h1 .logo-text:hover { text-shadow: 0 0 20px rgba(255,255,255,0.18), 0 2px 6px rgba(0,0,0,0.5); }
  h1 .blood { position: absolute; left: 0; right: 0; top: 0; color: #a30000; pointer-events: none; text-shadow: 0 0 10px rgba(180,0,0,0.55), 0 2px 6px rgba(60,0,0,0.7); clip-path: inset(0 0 100% 0); animation: bloodDrip 90s linear infinite; animation-delay: -80s; will-change: clip-path, opacity; }
  @keyframes bloodDrip {
    0%, 94% { clip-path: inset(0 0 100% 0); opacity: 0.92; }
    97% { clip-path: inset(0 0 50% 0); opacity: 0.92; }
    98.5% { clip-path: inset(0 0 0 0); opacity: 0.92; }
    99.5% { clip-path: inset(0 0 0 0); opacity: 0.8; }
    100% { clip-path: inset(0 0 0 0); opacity: 0; }
  }
  .menu-btn { background: #21262d; border: 0; color: #ffffff; border-radius: 50%; padding: 0; cursor: pointer; align-items: center; justify-content: center; width: 40px; height: 40px; min-width: 40px; display: inline-flex; flex-shrink: 0; transition: background 0.15s; }
  .menu-btn:hover { background: #30363d; }
  .menu-btn svg { width: 18px; height: 18px; display: block; }
  .topbar-spacer { display: block; width: 40px; height: 36px; flex-shrink: 0; }
  .conn-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); z-index: 250; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .conn-modal-inner { background: #0d1117; border: 1.5px solid #f85149; border-radius: 16px; padding: 36px 32px 28px; max-width: 460px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; box-shadow: 0 16px 48px rgba(248,81,73,0.18), 0 0 60px rgba(248,81,73,0.12); }
  .conn-modal.warn .conn-modal-inner { border-color: #d4a500; box-shadow: 0 16px 48px rgba(212,165,0,0.18), 0 0 60px rgba(212,165,0,0.12); }
  .conn-icon { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; color: #f85149; }
  .conn-modal.warn .conn-icon { color: #d4a500; }
  .conn-icon svg { width: 100%; height: 100%; }
  .conn-title { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: clamp(28px, 6vw, 38px); font-weight: 700; margin: 0; color: #f0f6fc; letter-spacing: 0.03em; line-height: 1.1; text-shadow: 0 0 14px rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,0.5); }
  .conn-detail { color: #8b949e; font-size: 14px; line-height: 1.5; margin: 0; }
  .conn-retry { margin-top: 10px; background: #21262d; border: 0; color: #fff; padding: 10px 24px; border-radius: 22px; font-family: inherit; font-size: 14px; cursor: pointer; transition: background 0.15s, transform 0.15s; }
  .conn-retry:hover { background: #30363d; }
  .conn-retry:active { transform: scale(0.97); }
  body.theme-light .conn-modal-inner { background: #ffffff; }
  body.theme-light .conn-title { color: #0d1117; text-shadow: 0 0 8px rgba(0,0,0,0.05); }
  body.theme-light .conn-detail { color: #57606a; }
  body.theme-light .conn-retry { background: #eaeef2; color: #1f2328; }
  body.theme-light .conn-retry:hover { background: #d0d7de; }
  .update-btn { background: #1f6feb !important; position: relative; }
  .update-btn:hover { background: #2c7bef !important; }
  .update-btn::after { content: ""; position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; background: #f0c674; border-radius: 50%; }
  .update-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .update-modal-inner { background: #161b22; border: 1px solid #30363d; border-radius: 14px; padding: 24px; max-width: 480px; width: 100%; max-height: 80vh; overflow-y: auto; }
  .update-modal h2 { font-size: 18px; margin: 0 0 6px; color: #e6edf3; }
  .update-versions { color: #8b949e; font-size: 13px; margin-bottom: 14px; }
  .update-versions span { color: #58a6ff; font-weight: 500; }
  .update-versions .upd-date { color: #6e7681; }
  .update-notes-title { font-size: 13px; color: #8b949e; margin-bottom: 6px; }
  .update-notes { margin: 0 0 18px; padding-left: 20px; color: #c9d1d9; font-size: 14px; line-height: 1.5; }
  .update-notes li { margin-bottom: 4px; }
  .update-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .update-actions button { padding: 9px 16px; border-radius: 8px; border: 0; font-size: 14px; cursor: pointer; }
  .upd-cancel { background: #21262d; color: #c9d1d9; }
  .upd-cancel:hover { background: #30363d; }
  .upd-apply { background: #238636; color: #fff; }
  .upd-apply:hover { background: #2ea043; }
  .upd-apply:disabled { opacity: 0.6; cursor: not-allowed; }
  /* New session modal — стиль логин-формы */
  .ns-modal-inner { background: #161b22; border: 1px solid #30363d; border-radius: 14px; padding: 28px 26px 22px; max-width: 420px; width: 100%; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 16px 48px rgba(0,0,0,0.5); }
  .ns-title { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: clamp(32px, 6vw, 42px); font-weight: 700; margin: 0 0 8px; text-align: center; color: #f0f6fc; letter-spacing: 0.04em; text-shadow: 0 0 12px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.5); }
  .ns-input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 22px; padding: 12px 20px; font-size: 15px; font-family: inherit; width: 100%; box-sizing: border-box; }
  .ns-input:focus { outline: 0; border-color: #58a6ff; }
  .ns-input::placeholder { color: #6e7681; }
  .ns-input-with-action { position: relative; display: flex; align-items: center; }
  .ns-input-with-action .ns-input { padding-right: 48px; }
  .ns-folder-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: #8b949e; cursor: pointer; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  .ns-folder-btn:hover { background: #21262d; color: #c9d1d9; }
  .ns-folder-btn svg { width: 18px; height: 18px; }
  .ns-folder-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: #0d1117; border: 1px solid #30363d; border-radius: 12px; max-height: 220px; overflow-y: auto; z-index: 20; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .ns-folder-item { padding: 10px 16px; cursor: pointer; font-size: 13px; color: #c9d1d9; font-family: ui-monospace, "SF Mono", monospace; border-bottom: 1px solid #21262d; }
  .ns-folder-item:last-child { border-bottom: 0; }
  .ns-folder-item:hover { background: #21262d; }
  .ns-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 4px; cursor: pointer; color: #c9d1d9; font-size: 14px; }
  .ns-toggle-row:hover { color: #fff; }
  .ns-error { color: #f85149; font-size: 13px; min-height: 18px; text-align: center; }
  .ns-resume-hint { color: #58a6ff; font-size: 12px; line-height: 1.45; padding: 8px 12px; background: rgba(88,166,255,0.08); border: 1px solid rgba(88,166,255,0.3); border-radius: 8px; text-align: left; }
  .ns-resume-hint.warn { color: #f0c674; background: rgba(240,198,116,0.08); border-color: rgba(240,198,116,0.3); }
  .ns-input.locked, .toggle.locked { opacity: 0.55; pointer-events: none; }
  .ns-actions { display: flex; gap: 10px; }
  .ns-btn { flex: 1; padding: 12px 16px; border-radius: 22px; border: 0; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; transition: background 0.15s, transform 0.15s; }
  .ns-btn:active { transform: scale(0.98); }
  .ns-btn-secondary { background: #21262d; color: #c9d1d9; }
  .ns-btn-secondary:hover { background: #30363d; }
  .ns-btn-primary { background: #238636; color: #fff; }
  .ns-btn-primary:hover { background: #2ea043; }
  .ns-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  /* Light theme overrides */
  body.theme-light .ns-modal-inner { background: #ffffff; border-color: #d0d7de; }
  body.theme-light .ns-title { color: #0d1117; text-shadow: 0 0 8px rgba(0,0,0,0.05); }
  body.theme-light .ns-input { background: #f6f8fa; border-color: #d0d7de; color: #1f2328; }
  body.theme-light .ns-input::placeholder { color: #6e7681; }
  body.theme-light .ns-folder-list { background: #ffffff; border-color: #d0d7de; }
  body.theme-light .ns-folder-item { color: #1f2328; border-bottom-color: #eaeef2; }
  body.theme-light .ns-folder-item:hover { background: #f6f8fa; }
  body.theme-light .ns-toggle-row { color: #1f2328; }
  body.theme-light .ns-btn-secondary { background: #eaeef2; color: #1f2328; }
  body.theme-light .ns-btn-secondary:hover { background: #d0d7de; }
  body.theme-light .ns-btn-primary { background: #1f883d; }
  body.theme-light .ns-btn-primary:hover { background: #2c9c4d; }
  .refresh-btn.spinning svg { animation: spin 0.6s linear infinite; }
  /* Drawer (sessions list) — slides in from left on all platforms */
  #drawer { position: fixed; top: 0; left: 0; bottom: 0; width: min(85vw, 360px); background: #0d1117; border-right: 1px solid #30363d; transform: translateX(-100%); transition: transform 0.22s ease; z-index: 100; display: flex; flex-direction: column; padding-top: env(safe-area-inset-top, 0); padding-bottom: env(safe-area-inset-bottom, 0); overflow-y: auto; overscroll-behavior: contain; }
  #drawer.open { transform: translateX(0); }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #30363d; position: sticky; top: 0; background: #0d1117; z-index: 1; }
  body.theme-light .drawer-head { background: #ffffff; }
  .drawer-title { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: 28px; font-weight: 700; color: #f0f6fc; letter-spacing: 0.03em; line-height: 1; text-shadow: 0 0 10px rgba(255,255,255,0.08); }
  .drawer-section { border-bottom: 1px solid #21262d; }
  .drawer-section:last-child { border-bottom: 0; }
  .drawer-section-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; cursor: pointer; user-select: none; color: #e6edf3; font-size: 14px; font-weight: 500; }
  .drawer-section-head:hover { background: #161b22; }
  .drawer-section-head .drawer-chevron { width: 16px; height: 16px; transition: transform 0.2s; color: #8b949e; }
  .drawer-section.open > .drawer-section-head .drawer-chevron { transform: rotate(180deg); }
  .drawer-section-body { display: none; overflow: hidden; }
  .drawer-section.open > .drawer-section-body { display: block; }
  .drawer-section .grid { padding: 4px 12px 12px; }
  .new-session-btn { display: flex; align-items: center; justify-content: center; width: calc(100% - 24px); margin: 8px 12px 4px; padding: 12px; background: transparent; border: 1.5px solid #ffffff; color: #ffffff; border-radius: 8px; cursor: pointer; font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: 20px; font-weight: 700; letter-spacing: 0.04em; text-shadow: 0 0 10px rgba(255,255,255,0.15); line-height: 1.2; transition: background 0.15s, transform 0.15s; }
  .new-session-btn:hover { background: rgba(255,255,255,0.05); transform: scale(1.02); }
  body.theme-light .new-session-btn { border-color: #0d1117; color: #0d1117; text-shadow: 0 0 6px rgba(0,0,0,0.06); }
  body.theme-light .new-session-btn:hover { background: rgba(0,0,0,0.04); }
  .drawer-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 10px 28px; cursor: pointer; color: #c9d1d9; font-size: 14px; }
  .drawer-item:hover { background: #161b22; }
  .drawer-item .drawer-item-state { color: #6e7681; font-size: 12px; }
  .drawer-item.active .drawer-item-state { color: #3fb950; }
  .toggle { position: relative; display: inline-block; width: 46px; height: 26px; background: #30363d; border-radius: 13px; transition: background 0.2s; flex-shrink: 0; pointer-events: none; }
  .toggle .toggle-thumb { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; background: #f0f6fc; border-radius: 50%; transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
  .toggle.on { background: #238636; }
  .toggle.on .toggle-thumb { transform: translateX(20px); }
  /* Theme toggle — sun on left (light), moon on right (dark) */
  .theme-toggle .toggle-thumb { display: flex; align-items: center; justify-content: center; }
  .theme-toggle .theme-icon { width: 13px; height: 13px; color: #8b949e; }
  .theme-toggle .theme-icon-moon { display: none; }
  .theme-toggle.on .theme-icon-sun { display: none; }
  .theme-toggle.on .theme-icon-moon { display: block; }
  .theme-toggle.on { background: #1f3a8a; }
  /* Раскрывающийся пункт настроек с под-выбором */
  .drawer-sub-head { display: flex; align-items: center; justify-content: space-between; }
  .drawer-sub-state { display: inline-flex; align-items: center; gap: 6px; color: #8b949e; font-size: 13px; }
  .drawer-chevron-sm { width: 14px; height: 14px; transition: transform 0.2s; }
  .drawer-sub.open .drawer-chevron-sm { transform: rotate(180deg); }
  .drawer-sub-body { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
  .drawer-sub.open .drawer-sub-body { max-height: 80px; }
  /* 2-position segmented switch */
  .theme-switch { position: relative; display: flex; margin: 4px 28px 12px; background: #21262d; border-radius: 999px; padding: 3px; }
  .theme-switch-thumb { position: absolute; top: 3px; left: 3px; width: calc(50% - 3px); height: calc(100% - 6px); background: #ffffff; border-radius: 999px; transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
  .theme-switch[data-active="light"] .theme-switch-thumb { transform: translateX(calc(100% + 0px)); }
  .theme-switch-opt { flex: 1; background: transparent; border: 0; padding: 8px 12px; color: #c9d1d9; font-size: 13px; cursor: pointer; border-radius: 999px; z-index: 1; transition: color 0.2s; font-family: inherit; }
  .theme-switch[data-active="dark"] .theme-switch-opt[data-theme="dark"],
  .theme-switch[data-active="light"] .theme-switch-opt[data-theme="light"] { color: #0d1117; font-weight: 500; }
  .drawer-section-count { color: #6e7681; font-size: 12px; font-weight: 400; margin-left: 4px; }
  .hidden-list { padding: 4px 14px 12px 14px; }
  .hidden-list-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; font-size: 12px; color: #8b949e; border-bottom: 1px solid #21262d; }
  .hidden-list-item:last-child { border-bottom: 0; }
  .hidden-list-item .sid { font-family: ui-monospace, monospace; }
  .hidden-list-item button { background: #21262d; border: 0; color: #58a6ff; font-size: 11px; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
  .hidden-list-item button:hover { background: #30363d; }
  .hidden-list-empty { padding: 12px 0; text-align: center; color: #6e7681; font-size: 12px; }
  .drawer-sub.open > .drawer-sub-body { max-height: 240px; }
  .drawer-dot { display: inline-block; width: 8px; height: 8px; background: #f85149; border-radius: 50%; margin-left: 8px; vertical-align: middle; }
  .green-dot { display: inline-block; width: 8px; height: 8px; background: #3fb950; border-radius: 50%; margin-left: 6px; vertical-align: middle; box-shadow: 0 0 6px rgba(63,185,80,0.5); }
  .menu-btn { position: relative; }
  .menu-dot { position: absolute; top: 5px; right: 5px; width: 8px; height: 8px; background: #f85149; border-radius: 50%; }
  .drawer-close { background: transparent; border: 0; color: #f0f6fc; font-family: 'UnifrakturCook', 'Pirata One', serif; font-weight: 700; font-size: 24px; cursor: pointer; line-height: 1; padding: 0; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; text-shadow: 0 0 8px rgba(255,255,255,0.1); }
  .drawer-close:hover { color: white; }
  .drawer-backdrop { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 99; opacity: 0; pointer-events: none; transition: opacity 0.22s; }
  .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  /* Cards inside drawer: vertical list */
  .grid { display: flex !important; flex-direction: column; gap: 6px; padding: 12px; margin: 0; overflow-y: auto; flex: 1; }
  .meta { display: none; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; flex-shrink: 0; margin-bottom: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-left-width: 3px; border-radius: 8px; padding: 12px; cursor: pointer; transition: background 0.1s; }
  .card:hover { background: #1c2128; }
  .card.open { background: #1f2733; border-color: #58a6ff; }
  .card.thinking { border-left-color: #f0c674; }
  .card.tool { border-left-color: #58a6ff; }
  .card.waiting { border-left-color: #3fb950; }
  .card.idle { border-left-color: #6e7681; opacity: 0.65; }
  .card.unknown { border-left-color: #f85149; }
  .title { font-size: 13px; font-weight: 500; color: #e6edf3; line-height: 1.35; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cwd { font-size: 11px; color: #8b949e; word-break: break-all; margin-bottom: 8px; }
  .cwd.big { font-size: 13px; color: #c9d1d9; }
  .row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #8b949e; }
  .status { font-weight: 500; }
  .status.thinking { color: #f0c674; }
  .status.tool { color: #58a6ff; }
  .status.waiting { color: #3fb950; }
  .status.idle { color: #6e7681; }
  .status.unknown { color: #f85149; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #30363d; color: #8b949e; margin-left: 6px; vertical-align: middle; }
  .empty { color: #6e7681; padding: 40px; text-align: center; grid-column: 1 / -1; }
  .card.self { border-left-color: #a371f7; background: #1a1228; }
  .card.self::after { content: 'это твой чат'; display: block; font-size: 10px; color: #a371f7; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card.dead { opacity: 0.55; }
  .resume-btn { display: inline-block; margin-top: 6px; background: #1f6feb; border: 0; color: white; padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer; font-weight: 500; }
  .card { position: relative; }
  .hide-btn { position: absolute; top: 4px; right: 6px; background: transparent; border: 0; color: #8b949e; padding: 0; width: 22px; height: 22px; line-height: 1; cursor: pointer; font-family: 'UnifrakturCook', 'Pirata One', serif; font-weight: 700; font-size: 20px; display: inline-flex; align-items: center; justify-content: center; transition: color 0.15s, transform 0.15s; }
  .main-pin { position: absolute; top: 6px; right: 8px; color: #58a6ff; pointer-events: none; display: inline-flex; }
  .main-pin svg { width: 16px; height: 16px; display: block; }
  .hide-btn:hover { color: #f85149; transform: scale(1.15); }
  body.theme-light .hide-btn { color: #57606a; }
  body.theme-light .hide-btn:hover { color: #cf222e; }
  .resume-btn:hover { background: #388bfd; }
  .resume-btn:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }

  /* Panels (multi-session workspace) */
  #panels { display: flex; gap: 12px; overflow-x: auto; flex: 1; min-height: 0; padding-bottom: 12px; }
  #panels:empty::before { content: ''; }
  .welcome { display: none; flex: 1; flex-direction: column; padding: 32px 24px; overflow-y: auto; }
  .welcome.show { display: flex; }
  .welcome-inner { width: 100%; max-width: 1200px; margin: 0 auto; }
  .welcome-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(240px, 25vw, 320px), 1fr)); gap: 14px; align-items: start; }
  .welcome-grid .card { padding: 16px; }
  .new-session-card { display: flex; align-items: center; justify-content: center; background: transparent !important; border: 1.5px solid #ffffff !important; transition: background 0.15s, transform 0.15s; }
  .new-session-card span { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: 0.04em; text-shadow: 0 0 10px rgba(255,255,255,0.15); line-height: 1.2; }
  .new-session-card:hover { background: rgba(255,255,255,0.05) !important; transform: scale(1.02); }
  body.theme-light .new-session-card { border-color: #0d1117 !important; }
  body.theme-light .new-session-card span { color: #0d1117; text-shadow: 0 0 6px rgba(0,0,0,0.06); }
  body.theme-light .new-session-card:hover { background: rgba(0,0,0,0.04) !important; }
  .welcome-empty { color: #6e7681; text-align: center; padding: 60px 20px; font-size: 16px; }
  .panel { background: #0d1117; border: 1px solid #30363d; border-radius: 10px; min-width: 460px; flex: 1 1 0; display: flex; flex-direction: column; max-height: calc(100vh - 60px); }
  .panel-header { padding: 12px 16px; display: flex; align-items: center; gap: 8px; cursor: grab; }
  .panel-header:active { cursor: grabbing; }
  .panel-header button, .panel-header .title-block { cursor: pointer; }
  .panel.dragging { opacity: 0.5; }
  .panel.drag-over-left { box-shadow: -3px 0 0 0 #58a6ff inset, -3px 0 0 0 #58a6ff; }
  .panel.drag-over-right { box-shadow: 3px 0 0 0 #58a6ff inset, 3px 0 0 0 #58a6ff; }
  .panel-header .title-block { flex: 1; min-width: 0; cursor: pointer; user-select: none; }
  .panel-header .title-main { font-size: 14px; font-weight: 500; color: #e6edf3; margin-bottom: 2px; word-break: break-word; }
  .panel-header .cwd-line { font-size: 11px; color: #8b949e; word-break: break-all; }
  .panel-header button { background: #21262d; border: 0; color: #c9d1d9; padding: 0; border-radius: 50%; width: 36px; height: 36px; min-width: 36px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .panel-header button:hover { background: #30363d; color: white; }
  /* Status-line в стиле claude code: эмблема ✻ + текст «думает…», между feed и composer */
  .status-line { display: flex; align-items: center; gap: 8px; padding: 6px 16px 8px; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; color: #c9d1d9; }
  .status-line .claude-mark { color: #f0c674; font-size: 14px; line-height: 1; animation: claude-pulse 1.4s ease-in-out infinite; }
  .status-line.tool .claude-mark { color: #58a6ff; }
  .status-line.waiting .claude-mark { color: #3fb950; animation: none; }
  .status-line.limit .claude-mark { color: #f85149; animation: none; font-size: 16px; }
  .status-line .wake-btn { margin-left: auto; background: #1f6feb; border: 0; color: #fff; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .status-line .wake-btn:hover { background: #388bfd; }
  .status-line .wake-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .status-line .status-text { color: #8b949e; }
  @keyframes claude-pulse { 0%,100% { opacity: 1; transform: rotate(0deg); } 50% { opacity: 0.4; transform: rotate(180deg); } }
  body.theme-light .status-line { color: #1f2328; }
  body.theme-light .status-line .status-text { color: #57606a; }
  .panel-header button svg { width: 16px; height: 16px; display: block; }
  .panel-header .interrupt-btn { width: auto; min-width: auto; padding: 0 14px; font-size: 13px; font-weight: 500; color: white; background: #d73a49; border-radius: 18px; height: 36px; letter-spacing: 0.02em; }
  .panel-header .interrupt-btn:hover { background: #cb2431; }
  .panel-header .close-btn:hover { background: #d73a49; color: white; }
  .warn { background: #321c1c; color: #f0c674; padding: 8px 14px; font-size: 12px; border-bottom: 1px solid #30363d; }
  .warn.self { background: #1f1633; color: #a371f7; }
  .warn.kid-locked { background: rgba(210,153,34,0.12); color: #d29922; border-bottom-color: rgba(210,153,34,0.35); }
  .warn.kid-locked .kid-override-btn { margin-left: 12px; padding: 4px 12px; background: rgba(248,81,73,0.15); border: 1px solid rgba(248,81,73,0.4); color: #f85149; border-radius: 4px; font: inherit; cursor: pointer; font-size: 12px; }
  .warn.kid-locked .kid-override-btn:hover { background: rgba(248,81,73,0.25); }
  .warn.kid-locked .kid-override-btn:disabled { opacity: 0.6; cursor: default; }
  .feed { flex: 1; overflow-y: auto; padding: 14px 16px; }
  .feed > * { max-width: 900px; margin-left: auto; margin-right: auto; }
  .msg { margin-bottom: 12px; }
  .msg .who { font-size: 11px; color: #6e7681; margin-bottom: 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  .msg.user .who { color: #58a6ff; }
  .msg.assistant .who { color: #c9d1d9; }
  .msg.tool .who { color: #8b949e; }
  .msg .body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
  .msg.tool .body { color: #8b949e; font-size: 12px; }
  .msg.question .who { color: #d29922; }
  .q-card { background: rgba(187,128,9,0.08); border: 1px solid rgba(210,153,34,0.45); border-radius: 8px; padding: 12px 14px; }
  .msg.question.answered .q-card { background: rgba(63,185,80,0.05); border-color: rgba(63,185,80,0.35); }
  .q-header { font-size: 11px; color: #d29922; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; font-weight: 600; }
  .msg.question.answered .q-header { color: #3fb950; }
  .q-question { font-size: 14px; color: #e6edf3; font-weight: 500; margin-bottom: 10px; }
  .q-opts { display: flex; flex-direction: column; gap: 6px; }
  .q-opt { display: block; width: 100%; text-align: left; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #c9d1d9; font: inherit; cursor: default; transition: all 0.15s; position: relative; }
  button.q-opt.active { cursor: pointer; }
  button.q-opt.active:hover { background: #1f2937; border-color: #d29922; transform: translateY(-1px); }
  .q-num { display: inline-block; min-width: 18px; height: 18px; line-height: 18px; text-align: center; background: #30363d; border-radius: 50%; color: #d29922; font-size: 11px; font-weight: 700; margin-right: 8px; vertical-align: middle; }
  button.q-opt.active:hover .q-num { background: #d29922; color: #0d1117; }
  .q-label { font-weight: 500; }
  .q-desc { font-size: 12px; color: #8b949e; margin-top: 4px; padding-left: 26px; line-height: 1.4; }
  .q-status { margin-top: 10px; font-size: 12px; color: #d29922; }
  .msg.question.answered .q-status { color: #3fb950; }
  .q-status.multitab { background: rgba(210,153,34,0.08); border: 1px solid rgba(210,153,34,0.35); border-radius: 6px; padding: 8px 12px; color: #d29922; }
  .q-rawkey { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px; }
  .q-rawkey:hover { background: #2d333b; border-color: #58a6ff; }
  .q-rawkey.q-esc { color: #f85149; border-color: rgba(248,81,73,0.4); margin-left: auto; }
  .q-rawkey.q-esc:hover { background: rgba(248,81,73,0.15); border-color: #f85149; }
  .q-next-tab, .q-final-submit { background: #238636; border: 0; color: #fff; padding: 8px 18px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; font-size: 13px; }
  .q-next-tab:hover, .q-final-submit:hover { background: #2ea043; }
  .q-next-tab:disabled { opacity: 0.5; cursor: not-allowed; }
  .q-opt.picked { background: rgba(63,185,80,0.08); border-color: rgba(63,185,80,0.45); }
  .q-check { display: inline-block; width: 16px; color: #3fb950; margin-right: 6px; font-weight: 700; }
  /* двушаговая логика: подсветка выбранной опции + кнопки подтвердить/отмена */
  button.q-opt.selected { background: rgba(63,185,80,0.15); border-color: #3fb950; box-shadow: 0 0 0 1px rgba(63,185,80,0.35); }
  button.q-opt.selected .q-num { background: #3fb950; color: #0d1117; }
  /* Кнопки всегда видимы и всегда полностью отрисованы.
     Если нет выбора — клик игнорируется на JS-уровне; чтобы не было визуальной игры
     с opacity при ре-рендерах, не применяем никаких dim-стилей. */
  .q-actions { display: flex; gap: 8px; margin-top: 12px; }
  .q-confirm { background: #238636; border: 0; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }
  .q-confirm:hover { background: #2ea043; }
  .q-confirm:disabled { opacity: 0.6; cursor: not-allowed; }
  .q-cancel { background: transparent; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; cursor: pointer; font: inherit; }
  .q-cancel:hover { border-color: #f85149; color: #f85149; }
  /* free-text-answered: пользовательский текст в плашке, без input */
  .q-opt.free-text-answered .q-label { white-space: pre-wrap; word-break: break-word; font-style: normal; color: #c9d1d9; }
  /* Все плашки опций имеют одинаковую минимальную высоту — даже если текст ответа короткий,
     плашка не должна быть тоньше остальных. Если текста больше — плашка вырастет. */
  .q-opt { min-height: 56px; box-sizing: border-box; }
  /* free-text option (открытый): внутри кнопки текстовый input */
  button.q-opt.free-text { padding-bottom: 8px; }
  button.q-opt.free-text .q-label { font-style: italic; color: #8b949e; }
  button.q-opt.free-text.selected .q-label { color: #c9d1d9; }
  .q-free-input { display: block; width: calc(100% - 26px); margin: 8px 0 0 26px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 6px 10px; color: #c9d1d9; font: inherit; font-style: normal; box-sizing: border-box; }
  .q-free-input:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88,166,255,0.2); }
  button.q-opt.free-text.selected .q-free-input { border-color: #3fb950; }
  button.q-opt.free-text.selected .q-free-input:focus { border-color: #58a6ff; }
  /* Бейдж «?» на карточке сессии */
  .card.has-question { box-shadow: 0 0 0 2px rgba(210,153,34,0.55); border-left-color: #d29922 !important; }
  .card .q-badge { display: none; }
  .card.has-question .q-badge { display: inline-block; margin-left: 6px; color: #d29922; font-weight: 700; animation: q-pulse 1.6s ease-in-out infinite; font-size: 14px; }
  @keyframes q-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .msg .body pre.code-block { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; overflow-x: auto; font: 12px/1.45 ui-monospace, "SF Mono", monospace; color: #c9d1d9; margin: 6px 0; white-space: pre; }
  .msg .body code.inline-code { background: rgba(110,118,129,0.15); border-radius: 3px; padding: 1px 5px; font: 12px ui-monospace, monospace; color: #79c0ff; cursor: pointer; transition: background 0.15s; }
  .msg .body code.inline-code:hover { background: rgba(110,118,129,0.35); }
  .msg .body code.inline-code.copied { background: rgba(63,185,80,0.25); color: #3fb950; }
  .code-wrap { position: relative; }
  .code-wrap .copy-btn { position: absolute; top: 6px; right: 6px; background: rgba(33,38,45,0.85); border: 1px solid #30363d; color: #8b949e; border-radius: 4px; padding: 3px 6px; cursor: pointer; opacity: 0; transition: opacity 0.15s; display: inline-flex; align-items: center; justify-content: center; }
  .code-wrap:hover .copy-btn { opacity: 0.9; }
  .code-wrap .copy-btn:hover { background: #30363d; color: white; opacity: 1; }
  .code-wrap .copy-btn.copied { opacity: 1; color: #3fb950; }
  .code-wrap .copy-btn svg { width: 12px; height: 12px; display: block; }
  .msg.tool .body code.inline-code { color: #d2a8ff; }
  .msg .body b { font-weight: 600; color: #e6edf3; }
  .msg .body i { font-style: italic; }
  .msg .body a { color: #58a6ff; text-decoration: none; word-break: break-all; }
  .msg .body a:hover { text-decoration: underline; }
  .msg .body .link-copy { background: #21262d; border: 1px solid #444c56; color: #c9d1d9; border-radius: 4px; padding: 2px 6px; cursor: pointer; margin-left: 5px; vertical-align: middle; transition: background 0.15s; display: inline-flex; align-items: center; }
  .msg .body .link-copy:hover { background: #2ea043; color: white; border-color: #2ea043; }
  .msg .body .link-copy.copied { background: #238636; border-color: #238636; color: white; }
  .msg .body .link-copy svg { width: 14px; height: 14px; display: block; }
  .msg .body h1, .msg .body h2, .msg .body h3 { font-size: 14px; font-weight: 600; color: #e6edf3; margin: 8px 0 4px; }
  .msg .body ul, .msg .body ol { margin: 4px 0 4px 20px; padding: 0; }
  .msg .body li { margin: 2px 0; }
  .composer-wrap { display: flex; flex-direction: column; gap: 4px; position: relative; }
  .cmd-menu { position: absolute; bottom: calc(100% + 6px); left: 8px; right: 8px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-height: 260px; overflow-y: auto; z-index: 10; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .cmd-menu.show { display: block; }
  .cmd-item { padding: 10px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .cmd-item:hover, .cmd-item.active { background: #21262d; }
  .cmd-name { font-family: ui-monospace, "SF Mono", monospace; color: #58a6ff; font-size: 13px; font-weight: 500; }
  .cmd-desc { color: #8b949e; font-size: 11px; }
  .send-error { color: #f85149; font-size: 11px; padding: 4px 14px 0; }
  .send-hint { color: #3fb950; font-size: 12px; padding: 4px 14px 0; }
  .attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 12px 0; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: #21262d; border: 1px solid #30363d; border-radius: 12px; padding: 2px 4px 2px 8px; font-size: 11px; color: #c9d1d9; }
  .chip-remove { background: transparent; border: 0; color: #8b949e; cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; }
  .chip-remove:hover { color: #f85149; }
  .panel.drag-over { outline: 2px dashed #58a6ff; outline-offset: -4px; }
  .composer { padding: 8px 10px; display: flex; gap: 8px; align-items: flex-end; }
  .attach-btn, .mic-btn { background: #21262d; border: 0; color: #c9d1d9; padding: 0; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; min-width: 40px; flex-shrink: 0; }
  .attach-btn:hover, .mic-btn:hover { background: #30363d; color: white; }
  .attach-btn svg, .mic-btn svg { width: 18px; height: 18px; display: block; }
  .mic-btn { transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s; transform-origin: center right; }
  .mic-btn.recording { background: #d73a49; transform: scale(1.8); box-shadow: 0 0 22px rgba(215,58,73,0.65), 0 0 44px rgba(215,58,73,0.35); animation: mic-glow 1.4s ease-in-out infinite; z-index: 5; }
  .mic-btn .rec-arrow { display: none; width: 18px; height: 18px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3)); }
  .mic-btn.recording .mic-icon { display: none; }
  .mic-btn.recording .rec-arrow { display: block; }
  .mic-btn.transcribing { background: #1f6feb; }
  @keyframes mic-glow {
    0%, 100% { box-shadow: 0 0 22px rgba(215,58,73,0.65), 0 0 44px rgba(215,58,73,0.35); }
    50% { box-shadow: 0 0 32px rgba(215,58,73,0.95), 0 0 64px rgba(215,58,73,0.55); }
  }
  @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  .mic-btn.transcribing svg { animation: spin 1s linear infinite; }
  .composer textarea { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 22px; padding: 10px 16px; font: 13px/1.4 -apple-system, sans-serif; resize: none; height: 40px; min-height: 40px; max-height: 50vh; overflow-y: auto; box-sizing: border-box; }
  .composer textarea:focus { outline: none; border-color: #58a6ff; }
  .composer .send-btn { background: #58a6ff; border: 0; color: white; padding: 0; border-radius: 50%; cursor: pointer; width: 40px; height: 40px; min-width: 40px; display: inline-flex; align-items: center; justify-content: center; }
  .composer .send-btn:hover { background: #79b8ff; }
  .composer .send-btn:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }
  .composer .send-btn svg { width: 16px; height: 16px; display: block; transform: translateX(-1px); }

  /* === Mobile (≤768px): tweaks for narrow screens === */
  @media (max-width: 768px) {
    body { padding: 0; }
    .topbar { padding: max(10px, env(safe-area-inset-top, 10px)) 12px 8px; }
    .welcome { padding: 16px 12px; }
    .welcome-grid { grid-template-columns: 1fr; gap: 10px; }
    .welcome-grid .card { padding: 14px; }
    .meta { padding: 0 12px 8px; font-size: 11px; margin: 0; }
    .card { padding: 10px 12px; }
    .title { font-size: 13px; -webkit-line-clamp: 2; }
    .cwd { font-size: 10px; margin-bottom: 6px; }
    .cwd.big { font-size: 12px; }
    .row { font-size: 11px; }
    .badge { font-size: 9px; }

    /* Active panel takes full viewport on mobile */
    body { min-height: 100dvh; height: auto; max-height: none; overflow: visible; }
    #panels { flex-direction: column; gap: 0; min-height: auto; padding: 0; overflow: visible; flex: 1; }
    #panels:empty { padding: 20px; }
    #panels:empty::before { font-size: 12px; padding: 0; text-align: center; }
    .panel { width: 100%; min-width: 0; max-height: none; height: calc(100dvh - 56px - env(safe-area-inset-top, 0)); flex: 0 0 auto; border-radius: 0; border: 0; }
    .panel-header { padding: 10px 12px; gap: 6px; }
    .panel-header .title-main { font-size: 13px; }
    .panel-header .cwd-line { font-size: 10px; }
    .panel-header button { width: 40px; height: 40px; min-width: 40px; }
    .panel-header button svg { width: 17px; height: 17px; }
    .panel-header .focus-btn { display: none; }  /* Mac-only feature, hide on iPhone */
    .feed { padding: 12px; }
    .msg { margin-bottom: 10px; }
    .msg .body { font-size: 13px; }
    .composer-wrap { padding-bottom: env(safe-area-inset-bottom, 0); background: #0d1117; }
    .composer { padding: 6px 8px; gap: 6px; align-items: flex-end; }
    .composer textarea { font-size: 16px; padding: 10px 18px; border-radius: 22px; height: 44px; min-height: 44px; line-height: 1.3; }  /* 16px prevents iOS zoom */
    .composer .send-btn, .attach-btn, .mic-btn { width: 44px; height: 44px; min-width: 44px; min-height: 44px; flex-shrink: 0; }
    .attach-btn svg, .mic-btn svg { width: 20px; height: 20px; }
    .composer .send-btn svg { width: 18px; height: 18px; }
    .composer-wrap { padding-bottom: env(safe-area-inset-bottom, 0); }
  }

  /* === Tablet (769-1100px): one panel at a time, but with desktop typography === */
  @media (min-width: 769px) and (max-width: 1100px) {
    #panels { flex-direction: column; overflow-x: hidden; overflow-y: auto; min-height: auto; }
    .panel { min-width: 0; width: 100%; max-height: calc(100vh - 80px); flex: 0 0 auto; }
  }

  /* === Light theme === */
  body.theme-light { color-scheme: light; background: #f6f8fa; color: #1f2328; }
  body.theme-light h1, body.theme-light .drawer-title, body.theme-light .welcome-btn { color: #0d1117; text-shadow: 0 0 8px rgba(0,0,0,0.05); }
  body.theme-light h1 .blood { color: #b30000; text-shadow: 0 0 10px rgba(180,0,0,0.4), 0 2px 4px rgba(60,0,0,0.3); }
  body.theme-light .menu-btn { background: #eaeef2; color: #1f2328; }
  body.theme-light .menu-btn:hover { background: #d0d7de; }
  body.theme-light .meta { color: #57606a; }
  body.theme-light #drawer { background: #ffffff; border-right-color: #d0d7de; }
  body.theme-light .drawer-head { border-bottom-color: #d0d7de; }
  body.theme-light .drawer-section { border-bottom-color: #eaeef2; }
  body.theme-light .drawer-section-head { color: #1f2328; }
  body.theme-light .drawer-section-head:hover { background: #f6f8fa; }
  body.theme-light .drawer-section-head .drawer-chevron { color: #57606a; }
  body.theme-light .drawer-item { color: #1f2328; }
  body.theme-light .drawer-item:hover { background: #f6f8fa; }
  body.theme-light .drawer-close { color: #1f2328; }
  body.theme-light .card { background: #ffffff; border-color: #d0d7de; color: #1f2328; }
  body.theme-light .card:hover { background: #f6f8fa; }
  body.theme-light .card.open { background: #ddf4ff; border-color: #0969da; }
  body.theme-light .card .title { color: #0d1117; }
  body.theme-light .card .cwd { color: #57606a; }
  body.theme-light .badge { background: #eaeef2; color: #57606a; }
  body.theme-light .panel { background: #ffffff; border-color: #d0d7de; }
  body.theme-light .panel-header .title-main { color: #0d1117; }
  body.theme-light .panel-header .cwd-line { color: #57606a; }
  body.theme-light .panel-header button { background: #eaeef2; color: #57606a; }
  body.theme-light .panel-header button:hover { background: #d0d7de; color: #1f2328; }
  body.theme-light .msg .who { color: #57606a; }
  body.theme-light .msg.user .who { color: #0550ae; }
  body.theme-light .msg.tool .who { color: #57606a; }
  body.theme-light .msg .body { color: #1f2328; }
  body.theme-light .msg .body b { color: #0d1117; }
  body.theme-light .msg.tool .body { color: #57606a; }
  body.theme-light .msg.tool .body code.inline-code { color: #6639ba; }
  body.theme-light .msg .body code.inline-code { background: rgba(175,184,193,0.2); color: #0550ae; }
  body.theme-light .msg .body pre.code-block { background: #f6f8fa; border-color: #d0d7de; color: #1f2328; }
  body.theme-light .msg .body a { color: #0969da; }
  body.theme-light .composer-wrap { background: #ffffff; }
  body.theme-light .composer textarea { background: #f6f8fa; border-color: #d0d7de; color: #1f2328; }
  body.theme-light .composer textarea:focus { border-color: #0969da; }
  body.theme-light .attach-btn, body.theme-light .mic-btn { background: #eaeef2; color: #57606a; }
  body.theme-light .attach-btn:hover, body.theme-light .mic-btn:hover { background: #d0d7de; }
  body.theme-light .send-btn { background: #0969da; }
  body.theme-light input { background: #ffffff; border-color: #d0d7de; color: #1f2328; }
  body.theme-light input::placeholder { color: #6e7681; }
  body.theme-light .login-box button { background: #eaeef2; color: #1f2328; }
  body.theme-light .login-box button:hover { background: #d0d7de; }
  body.theme-light .cmd-menu { background: #ffffff; border-color: #d0d7de; }
  body.theme-light .cmd-item:hover, body.theme-light .cmd-item.active { background: #f6f8fa; }
  body.theme-light .cmd-name { color: #0969da; }
  body.theme-light .cmd-desc { color: #57606a; }
  body.theme-light .toggle { background: #d0d7de; }
  body.theme-light .toggle.on { background: #1f883d; }
  body.theme-light .update-modal-inner { background: #ffffff; border-color: #d0d7de; }
  body.theme-light .update-modal h2 { color: #0d1117; }
  body.theme-light .update-versions, body.theme-light .update-notes-title { color: #57606a; }
  body.theme-light .update-notes { color: #1f2328; }
  body.theme-light .upd-cancel { background: #eaeef2; color: #1f2328; }
  body.theme-light .empty { color: #57606a; }
  body.theme-light .welcome-empty { color: #57606a; }
</style>
</head>
<body>
<div id="conn-modal" class="conn-modal" style="display:none">
  <div class="conn-modal-inner">
    <div class="conn-icon" id="conn-icon"></div>
    <h2 class="conn-title" id="conn-title">Нет связи</h2>
    <p class="conn-detail" id="conn-detail"></p>
    <button class="conn-retry" id="conn-retry">Повторить</button>
  </div>
</div>
<div class="topbar">
  <button id="menu-btn" class="menu-btn" title="Меню">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    <span class="menu-dot" id="menu-dot" style="display:none"></span>
  </button>
  <h1><span id="logo-home" class="logo-text" title="На главный экран">CC Dashboard<span class="blood" aria-hidden="true">CC Dashboard</span></span></h1>
  <div class="topbar-spacer"></div>
  <button id="push-btn" style="display:none"></button>
  <button id="update-btn" style="display:none"></button>
</div>
<div id="rename-modal" class="update-modal" style="display:none">
  <div class="ns-modal-inner">
    <h2 class="ns-title">Переименовать</h2>
    <input id="rn-name" type="text" class="ns-input" placeholder="Новое название сессии" autocomplete="off" autocapitalize="off" autocorrect="off" />
    <div id="rn-error" class="ns-error"></div>
    <div class="ns-actions">
      <button class="ns-btn ns-btn-secondary" id="rn-cancel">Отмена</button>
      <button class="ns-btn ns-btn-primary" id="rn-apply">Переименовать</button>
    </div>
  </div>
</div>
<div id="close-session-modal" class="update-modal" style="display:none">
  <div class="ns-modal-inner">
    <h2 class="ns-title">Закрыть сессию?</h2>
    <p id="cs-text" style="color:#8b949e; font-size:13px; text-align:center; margin:0;">Что сделать с этой сессией?</p>
    <div id="cs-error" class="ns-error"></div>
    <div class="ns-actions" style="flex-direction:column; gap:8px;">
      <button class="ns-btn ns-btn-secondary" id="cs-hide">Перенести в закрытые</button>
      <button class="ns-btn" id="cs-delete" style="background:#d73a49;color:#fff">Удалить совсем</button>
      <button class="ns-btn ns-btn-secondary" id="cs-cancel">Отмена</button>
    </div>
  </div>
</div>
<div id="new-session-modal" class="update-modal" style="display:none">
  <div class="ns-modal-inner">
    <h2 class="ns-title">New Session</h2>
    <div class="ns-input-with-action">
      <input id="ns-cwd" type="text" class="ns-input" placeholder="Рабочая папка (по умолчанию ~/)" autocomplete="off" autocapitalize="off" autocorrect="off" />
      <button id="ns-folder-btn" class="ns-folder-btn" title="Выбрать из недавних">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </button>
      <div id="ns-folder-list" class="ns-folder-list" style="display:none"></div>
    </div>
    <div id="ns-resume-hint" class="ns-resume-hint" style="display:none"></div>
    <input id="ns-name" type="text" class="ns-input" placeholder="Название сессии" autocomplete="off" autocapitalize="off" autocorrect="off" />
    <div class="ns-toggle-row" id="ns-rc-row">
      <span>Remote Control</span>
      <span class="toggle" id="ns-rc-toggle"><span class="toggle-thumb"></span></span>
    </div>
    <div id="ns-error" class="ns-error"></div>
    <div class="ns-actions">
      <button class="ns-btn ns-btn-secondary" id="ns-cancel">Отмена</button>
      <button class="ns-btn ns-btn-primary" id="ns-apply">Создать</button>
    </div>
  </div>
</div>
<div id="update-modal" class="update-modal" style="display:none">
  <div class="update-modal-inner">
    <h2>Доступно обновление</h2>
    <div class="update-versions">текущая <span id="upd-local">…</span> → новая <span id="upd-remote">…</span> <span id="upd-date" class="upd-date"></span></div>
    <div class="update-notes-title">Что нового:</div>
    <ul id="upd-notes" class="update-notes"></ul>
    <div class="update-actions">
      <button id="upd-cancel" class="upd-cancel">Позже</button>
      <button id="upd-apply" class="upd-apply">Обновить сейчас</button>
    </div>
  </div>
</div>
<div class="meta" id="meta">подключение…</div>
<div id="drawer">
  <div class="drawer-head">
    <div class="drawer-title">Menu</div>
    <button id="drawer-close" class="drawer-close">X</button>
  </div>
  <div class="drawer-section" data-section="sessions">
    <div class="drawer-section-head">
      <span>Активные сессии</span>
      <svg class="drawer-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="drawer-section-body">
      <button class="new-session-btn" id="new-session-btn">New Session</button>
      <div class="grid" id="grid"></div>
    </div>
  </div>
  <div class="drawer-section" data-section="hidden">
    <div class="drawer-section-head">
      <span>Закрытые сессии</span>
      <svg class="drawer-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="drawer-section-body">
      <div id="hidden-list" class="hidden-list"></div>
    </div>
  </div>
  <div class="drawer-section" data-section="settings">
    <div class="drawer-section-head">
      <span>Настройки<span class="drawer-dot" id="settings-dot" style="display:none"></span></span>
      <svg class="drawer-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="drawer-section-body">
      <div class="drawer-item" id="settings-notifications">
        <span>Уведомления</span>
        <span class="toggle" id="notif-toggle"><span class="toggle-thumb"></span></span>
      </div>
      <div class="drawer-item" id="settings-theme">
        <span>Тема</span>
        <span class="toggle theme-toggle" id="theme-toggle">
          <span class="toggle-thumb">
            <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.6" y2="6.6"/><line x1="17.4" y1="17.4" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.6" y2="17.4"/><line x1="17.4" y1="6.6" x2="19.5" y2="4.5"/></svg>
            <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
          </span>
        </span>
      </div>
      <div class="drawer-item" id="settings-updates">
        <span>Обновления<span class="drawer-dot" id="updates-dot" style="display:none"></span></span>
        <span class="drawer-item-state" id="updates-state">…</span>
      </div>
    </div>
  </div>
</div>
<div id="drawer-backdrop" class="drawer-backdrop"></div>
<div id="welcome" class="welcome">
  <div class="welcome-inner">
    <div id="welcome-grid" class="welcome-grid"></div>
    <div id="welcome-empty" class="welcome-empty" style="display:none">Нет запущенных claude-процессов</div>
  </div>
</div>
<div id="panels"></div>

<script>
const STATUS_LABELS = {
  thinking: "думает",
  tool: "запускает инструмент",
  waiting: "ждёт ответа",
  idle: "на паузе",
  unknown: "?",
};
// Список slash-команд Claude Code для автодополнения в композере.
// Появляется когда пользователь начинает сообщение с "/" и пока не ввёл пробел.
let SLASH_COMMANDS = [
  { name: "/help", desc: "Справка по командам" },
  { name: "/agents", desc: "Управление subagent'ами" },
  { name: "/bash", desc: "Выполнить bash-команду" },
  { name: "/chrome", desc: "Интеграция с Chrome" },
  { name: "/clear", desc: "Очистить контекст" },
  { name: "/compact", desc: "Сжать историю разговора" },
  { name: "/config", desc: "Настройки сессии" },
  { name: "/cost", desc: "Показать стоимость сессии" },
  { name: "/effort", desc: "Уровень усилий (low/medium/high/xhigh/max)" },
  { name: "/exit", desc: "Выйти" },
  { name: "/fast", desc: "Fast-режим (Opus 4.6 ускоренный)" },
  { name: "/feedback", desc: "Отправить фидбек" },
  { name: "/hooks", desc: "Управление хуками" },
  { name: "/init", desc: "Создать CLAUDE.md в проекте" },
  { name: "/login", desc: "Войти в Claude Code" },
  { name: "/loop", desc: "Loop-режим (повторение задачи)" },
  { name: "/mcp", desc: "Управление MCP-серверами" },
  { name: "/memory", desc: "Редактировать память" },
  { name: "/model", desc: "Сменить модель Claude" },
  { name: "/permissions", desc: "Настройка разрешений" },
  { name: "/quit", desc: "Выйти" },
  { name: "/remote-control", desc: "Удалённое управление сессией" },
  { name: "/resume", desc: "Восстановить сессию" },
  { name: "/rewind", desc: "Откатить разговор назад" },
  { name: "/skills", desc: "Список доступных скиллов" },
  { name: "/status", desc: "Статус сессии и окружения" },
  { name: "/ultrareview", desc: "Многоагентный ревью текущей ветки" },
];
// Load custom commands from installed plugins and merge into SLASH_COMMANDS.
fetch("/api/commands")
  .then(r => r.ok ? r.json() : [])
  .then(custom => {
    if (Array.isArray(custom) && custom.length) {
      const existing = new Set(SLASH_COMMANDS.map(c => c.name));
      for (const c of custom) if (!existing.has(c.name)) SLASH_COMMANDS.push(c);
    }
  })
  .catch(() => {});
let sessionsCache = [];
const panels = new Map(); // sid → { el, pollInterval }
const questionSelections = new Map(); // sid → { toolUseId, idx } — выбор пользователем варианта ДО подтверждения
const questionFreeTexts = new Map(); // sid → { toolUseId, value } — введённый текст в free-text input, переживает re-render

function applyQuestionSelection(p, sid) {
  const sel = questionSelections.get(sid);
  const freeTxt = questionFreeTexts.get(sid);
  const cards = p.el.querySelectorAll(".q-card[data-tool-use-id]");
  // Запомним был ли фокус на free-text input ДО возможного перерендера (чтобы вернуть после)
  const activeIsFreeInput = document.activeElement?.classList?.contains("q-free-input");
  for (const card of cards) {
    const buttons = card.querySelectorAll("button.q-opt");
    buttons.forEach(b => b.classList.remove("selected"));
    let selectedBtn = null;
    if (sel && card.dataset.toolUseId === sel.toolUseId) {
      selectedBtn = card.querySelector('button.q-opt[data-idx="' + sel.idx + '"]');
      if (selectedBtn) selectedBtn.classList.add("selected");
    }
    if (freeTxt && card.dataset.toolUseId === freeTxt.toolUseId) {
      const input = card.querySelector("button.q-opt.free-text .q-free-input");
      if (input && input.value !== freeTxt.value) {
        input.value = freeTxt.value;
      }
    }
    if (selectedBtn && activeIsFreeInput) {
      const input = selectedBtn.querySelector(".q-free-input");
      if (input && document.activeElement !== input) {
        input.focus();
        try {
          const len = input.value.length;
          input.setSelectionRange(len, len);
        } catch {}
      }
    }
    // Multi-tab: активируем «Далее» когда есть выбор в этой карточке
    const nextBtn = card.querySelector(".q-next-tab");
    if (nextBtn) {
      const cardHasSelection = sel && card.dataset.toolUseId === sel.toolUseId;
      nextBtn.disabled = !cardHasSelection;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Minimal markdown rendering: code blocks (\`\`\`...\`\`\`), inline code, bold, italic, links (markdown + auto), headings, lists.
function renderMd(text) {
  // 1. Extract fenced code blocks first (so their content isn't touched by other rules)
  const codeBlocks = [];
  text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    codeBlocks.push(code);
    return "\\x00CB" + (codeBlocks.length - 1) + "\\x00";
  });
  // 2. Escape HTML
  text = escapeHtml(text);
  // 3. Extract inline code as placeholders so URL auto-link doesn't touch URLs inside backticks
  const inlineCodes = [];
  text = text.replace(/\`([^\`\\n]+)\`/g, (_, code) => {
    inlineCodes.push(code);
    return "\\x00IC" + (inlineCodes.length - 1) + "\\x00";
  });
  // 4. Extract markdown links [text](url) as placeholders too (so bare-URL pass doesn't double-process them)
  const linkCopyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const mdLinks = [];
  text = text.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_, label, url) => {
    mdLinks.push({ label, url });
    return "\\x00ML" + (mdLinks.length - 1) + "\\x00";
  });
  // 5. Bold, italic FIRST (so URL inside **...** gets unwrapped to <b>URL</b> before auto-link)
  text = text.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>');
  text = text.replace(/(^|[\\s(])\\*([^*\\n]+)\\*(?=[\\s.,!?)]|$)/g, '$1<i>$2</i>');
  // 6. Auto-link bare URLs (http/https). After bold, URLs inside <b> are preceded by '>' which we match.
  text = text.replace(/(^|[\\s>(])(https?:\\/\\/[^\\s<>"')]+)/g, (_, prefix, url) => {
    return prefix + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a><button class="link-copy" data-copy="' + encodeURIComponent(url) + '" title="Скопировать ссылку">' + linkCopyIcon + '</button>';
  });
  // 6a. Auto-link uploaded files. Без target (открывается в том же окне PWA — cookie передаётся
  // и iOS сам предложит preview/share через Quick Look).
  text = text.replace(/@?(\\/tmp\\/cc-dashboard\\/[A-Za-z0-9._-]+)/g, (_, fullPath) => {
    const fname = fullPath.split("/").pop();
    return '<a href="/api/file/' + encodeURIComponent(fname) + '" class="file-link">📎 ' + fname + '</a>';
  });
  // 7. Restore inline code placeholders
  text = text.replace(/\\x00IC(\\d+)\\x00/g, (_, i) => '<code class="inline-code">' + escapeHtml(inlineCodes[+i]) + '</code>');
  // 8. Restore markdown link placeholders
  text = text.replace(/\\x00ML(\\d+)\\x00/g, (_, i) => {
    const ml = mdLinks[+i];
    return '<a href="' + ml.url + '" target="_blank" rel="noopener">' + ml.label + '</a><button class="link-copy" data-copy="' + encodeURIComponent(ml.url) + '" title="Скопировать ссылку">' + linkCopyIcon + '</button>';
  });
  // 4. Headings
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 5. Lists (basic — wrap consecutive li lines)
  text = text.replace(/(?:^- (.+)$\\n?)+/gm, m => {
    const items = m.trim().split(/\\n/).map(l => l.replace(/^- /, '')).map(s => '<li>' + s + '</li>').join('');
    return '<ul>' + items + '</ul>';
  });
  text = text.replace(/(?:^\\d+\\. (.+)$\\n?)+/gm, m => {
    const items = m.trim().split(/\\n/).map(l => l.replace(/^\\d+\\. /, '')).map(s => '<li>' + s + '</li>').join('');
    return '<ol>' + items + '</ol>';
  });
  // 6. Restore code blocks (with copy button)
  text = text.replace(/\\x00CB(\\d+)\\x00/g, (_, i) => {
    const code = codeBlocks[+i];
    const escaped = escapeHtml(code);
    const enc = encodeURIComponent(code);
    const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    return '<div class="code-wrap"><button class="copy-btn" data-copy="' + enc + '" title="Скопировать">' + copyIcon + '</button><pre class="code-block"><code>' + escaped + '</code></pre></div>';
  });
  return text;
}

function findSession(sid) { return sessionsCache.find(s => s.sessionId === sid); }

function buildCardsHTML(sessions) {
  return sessions.map(s => {
    const isDead = s.pid < 0 && !s.sessionId.startsWith('pid-') && !s.isSelf;
    const badge = isDead ? '<span class="badge">закрыто</span>' : (s.isDesktop ? '<span class="badge">desktop</span>' : '');
    const pidLabel = '';
    const head = s.title
      ? \`<div class="title">\${escapeHtml(s.title)}\${s.hasOpenQuestion ? '<span class="q-badge" title="Ждёт твой выбор">?</span>' : ''}</div>\${badge ? \`<div class="cwd">\${badge}</div>\` : ''}\`
      : \`<div class="cwd big">\${escapeHtml(s.cwdLabel)}\${s.hasOpenQuestion ? '<span class="q-badge" title="Ждёт твой выбор">?</span>' : ''}\${badge}</div>\`;
    const classes = [s.status, s.isSelf ? 'self' : '', panels.has(s.sessionId) ? 'open' : '', isDead ? 'dead' : '', s.hasOpenQuestion ? 'has-question' : ''].filter(Boolean).join(' ');
    const qBadge = s.hasOpenQuestion ? '<span class="q-badge" title="Ждёт твой выбор">?</span>' : '';
    const resumeBtn = isDead && !s.isMain ? \`<button class="resume-btn" data-sid="\${s.sessionId}" data-cwd="\${escapeHtml(s.cwd)}">▶ Resume</button>\` : '';
    const hideBtn = s.isMain ? \`<span class="main-pin" title="Главная сессия дашборда — нельзя удалить"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg></span>\` : \`<button class="hide-btn" data-sid="\${s.sessionId}" data-cwd="\${escapeHtml(s.cwd)}" data-dead="\${isDead ? '1' : '0'}" title="Закрыть/удалить">X</button>\`;
    return \`
      <div class="card \${classes}" data-sid="\${s.sessionId}">
        \${head}
        <div class="row">
          <span class="status \${s.status}">\${STATUS_LABELS[s.status] ?? s.status}</span>
          <span>\${s.lastActivityRel === '—' ? '' : s.lastActivityRel + ' назад'}\${pidLabel ? ' · ' + pidLabel : ''}</span>
        </div>
        \${resumeBtn}\${hideBtn}
      </div>
    \`;
  }).join("");
}

function wireCards(container) {
  for (const el of container.querySelectorAll(".card")) {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("resume-btn")) return;
      if (e.target.classList.contains("hide-btn")) return;
      onCardClick(el.dataset.sid);
    });
  }
  for (const btn of container.querySelectorAll(".hide-btn")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      openCloseSessionModal(btn.dataset.sid, btn.dataset.cwd, btn.dataset.dead === "1");
    });
  }
  for (const btn of container.querySelectorAll(".resume-btn")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "▶ Открываю…";
      try {
        const res = await fetch("/api/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: btn.dataset.sid, cwd: btn.dataset.cwd }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          btn.textContent = "▶ Ошибка";
          alert("Не удалось восстановить: " + (data.error || "?"));
        } else {
          btn.textContent = "✓ Запущено";
        }
      } catch (e2) {
        btn.textContent = "▶ Ошибка";
        alert("Сетевая ошибка: " + e2);
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = "▶ Resume"; }, 5000);
      }
    });
  }
}

function render(sessions) {
  sessionsCache = sessions;
  document.getElementById("meta").textContent =
    sessions.length + " сессий • обновлено " + new Date().toLocaleTimeString();
  const statusOrder = { thinking: 0, tool: 1, waiting: 2, idle: 3, unknown: 4 };
  sessions.sort((a, b) => {
    // Main session всегда первая
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    const aDead = a.pid < 0 && !a.sessionId.startsWith('pid-') && !a.isSelf;
    const bDead = b.pid < 0 && !b.sessionId.startsWith('pid-') && !b.isSelf;
    if (aDead && !bDead) return 1;
    if (!aDead && bDead) return -1;
    const sa = statusOrder[a.status] ?? 5;
    const sb = statusOrder[b.status] ?? 5;
    if (sa !== sb) return sa - sb;
    // В пределах одного статуса — по времени последней активности (свежие выше)
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    if (ta !== tb) return tb - ta;
    return a.sessionId.localeCompare(b.sessionId);
  });
  const grid = document.getElementById("grid");
  const welcomeGrid = document.getElementById("welcome-grid");
  const welcomeEmpty = document.getElementById("welcome-empty");
  const newCardHTML = '<div class="card new-session-card" id="welcome-new-session"><span>New Session</span></div>';
  if (sessions.length === 0) {
    grid.innerHTML = '<div class="empty">Нет запущенных claude-процессов</div>';
    welcomeGrid.innerHTML = newCardHTML;
    welcomeEmpty.style.display = 'none';
  } else {
    const html = buildCardsHTML(sessions);
    grid.innerHTML = html;
    welcomeGrid.innerHTML = newCardHTML + html;
    welcomeEmpty.style.display = 'none';
    wireCards(grid);
    wireCards(welcomeGrid);
  }
  const wnsCard = document.getElementById("welcome-new-session");
  if (wnsCard) wnsCard.addEventListener("click", () => document.getElementById("new-session-btn").click());
  // Refresh open panel headers (status may have changed)
  for (const sid of panels.keys()) updatePanelHeader(sid);
}

const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

function openDrawer() {
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer-backdrop").classList.add("open");
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer-backdrop").classList.remove("open");
  // Сворачиваем все секции drawer'а, чтобы при следующем открытии всё было собрано.
  document.querySelectorAll(".drawer-section.open").forEach(s => s.classList.remove("open"));
  document.querySelectorAll(".drawer-sub.open").forEach(s => s.classList.remove("open"));
}
function updateWelcome() {
  const welcome = document.getElementById("welcome");
  if (panels.size === 0) welcome.classList.add("show");
  else welcome.classList.remove("show");
}

function onCardClick(sid) {
  if (isMobile()) closeDrawer();
  if (panels.has(sid)) {
    panels.get(sid).el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    return;
  }
  // On mobile: keep only one panel open at a time
  if (isMobile()) {
    for (const otherSid of Array.from(panels.keys())) {
      if (otherSid !== sid) closePanel(otherSid);
    }
  }
  openPanel(sid);
}

// Клик по логотипу — закрыть всё и полностью перезагрузить страницу (заодно сброс состояния).
document.getElementById("logo-home").addEventListener("click", () => {
  location.href = "/";
});

document.getElementById("menu-btn").addEventListener("click", openDrawer);
document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

// Accordion: тап по заголовку секции → toggle открытия
document.querySelectorAll(".drawer-section-head").forEach(head => {
  head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
});

// Пункты «Настройки» → проксируем на старые обработчики push-btn / update-btn
document.getElementById("settings-notifications").addEventListener("click", () => {
  document.getElementById("push-btn").click();
});
document.getElementById("settings-updates").addEventListener("click", () => {
  document.getElementById("update-btn").click();
});

// Скрытые сессии
async function refreshHiddenList() {
  try {
    const res = await fetch("/api/hidden-sessions");
    const list = await res.json();
    const cnt = document.getElementById("hidden-count");
    if (cnt) cnt.textContent = list.length;
    const container = document.getElementById("hidden-list");
    if (list.length === 0) {
      container.innerHTML = '<div class="hidden-list-empty">Пусто</div>';
    } else {
      container.innerHTML = list.map(item => {
        const label = item.title ? escapeHtml(item.title) : (item.cwd ? escapeHtml(item.cwd.split("/").pop()) : item.sid.slice(0,12) + '…');
        return '<div class="hidden-list-item">' +
          '<span class="sid">' + label + '</span>' +
          '<button data-sid="' + item.sid + '" data-cwd="' + escapeHtml(item.cwd || "") + '">Восстановить</button>' +
          '</div>';
      }).join("");
      container.querySelectorAll("button").forEach(b => {
        b.addEventListener("click", async () => {
          b.disabled = true; b.textContent = "Запускаю…";
          try {
            const res = await fetch("/api/session/" + b.dataset.sid + "/unhide", {
              method: "POST", headers: {"content-type":"application/json"},
              body: JSON.stringify({ restore: !!b.dataset.cwd }),
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              alert("Ошибка: " + (d.error || res.status));
              b.disabled = false; b.textContent = "Восстановить";
              return;
            }
            refreshHiddenList();
          } catch (e) { alert("Сеть: " + e.message); b.disabled = false; b.textContent = "Восстановить"; }
        });
      });
    }
  } catch {}
}
// Загружаем список при каждом раскрытии секции «Закрытые сессии»
document.querySelector('.drawer-section[data-section="hidden"] .drawer-section-head').addEventListener("click", refreshHiddenList);
// Также периодически обновляем счётчик
setInterval(refreshHiddenList, 30000);
refreshHiddenList();

// Тема: тумблер с иконкой солнца (слева, светлая) / луны (справа, тёмная).
// localStorage("theme") = "light" | "dark" (по умолчанию dark).
function applyTheme(theme) {
  document.body.classList.toggle("theme-light", theme === "light");
  const tg = document.getElementById("theme-toggle");
  if (tg) tg.classList.toggle("on", theme === "dark");
}
const savedTheme = localStorage.getItem("theme") || "dark";
applyTheme(savedTheme);
document.getElementById("settings-theme").addEventListener("click", () => {
  const cur = localStorage.getItem("theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
});
// === Rename session modal (клик по названию чата) ===
const rnModal = document.getElementById("rename-modal");
const rnName = document.getElementById("rn-name");
const rnError = document.getElementById("rn-error");
const rnApply = document.getElementById("rn-apply");
let rnCurrentSid = "";
function openRenameModal(sid) {
  const s = findSession(sid);
  if (!s) return;
  rnCurrentSid = sid;
  rnName.value = s.title || "";
  rnError.textContent = "";
  rnApply.disabled = false;
  rnApply.textContent = "Переименовать";
  rnModal.style.display = "flex";
  setTimeout(() => { rnName.focus(); rnName.select(); }, 50);
}
document.getElementById("rn-cancel").addEventListener("click", () => rnModal.style.display = "none");
rnModal.addEventListener("click", (e) => { if (e.target === rnModal) rnModal.style.display = "none"; });
rnName.addEventListener("keydown", (e) => { if (e.key === "Enter") rnApply.click(); });
rnApply.addEventListener("click", async () => {
  const newName = rnName.value.trim();
  if (!newName) { rnError.textContent = "Введите название"; return; }
  rnApply.disabled = true;
  rnApply.textContent = "Применяю…";
  rnError.textContent = "";
  try {
    const res = await fetch("/api/session/" + rnCurrentSid + "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "/rename " + newName }),
    });
    const data = await res.json();
    if (!res.ok || data.terminal === "none") {
      rnError.textContent = data.error || "Не удалось отправить";
      rnApply.disabled = false;
      rnApply.textContent = "Переименовать";
    } else {
      rnApply.textContent = "✓ Готово";
      setTimeout(() => { rnModal.style.display = "none"; }, 500);
    }
  } catch (e) {
    rnError.textContent = "Сеть: " + e.message;
    rnApply.disabled = false;
    rnApply.textContent = "Переименовать";
  }
});

// === Close session modal (× на карточке) ===
const csModal = document.getElementById("close-session-modal");
const csText = document.getElementById("cs-text");
const csHide = document.getElementById("cs-hide");
const csDelete = document.getElementById("cs-delete");
const csError = document.getElementById("cs-error");
let csCurrent = { sid: "", cwd: "", isDead: false };
function openCloseSessionModal(sid, cwd, isDead) {
  csCurrent = { sid, cwd, isDead };
  csError.textContent = "";
  csHide.disabled = false; csDelete.disabled = false;
  csHide.textContent = "Перенести в закрытые";
  csDelete.textContent = "Удалить совсем";
  if (isDead) {
    csText.textContent = "Сессия уже закрыта. Удалить её совсем или просто скрыть из списка?";
    csHide.textContent = "Скрыть из списка";
  } else {
    csText.textContent = "Терминал закроется. «В закрытые» — можно будет восстановить. «Удалить» — необратимо (jsonl удалится).";
  }
  csModal.style.display = "flex";
}
csHide.addEventListener("click", async () => {
  csHide.disabled = true; csDelete.disabled = true;
  csHide.textContent = "Закрываю…";
  try {
    const res = await fetch("/api/session/" + csCurrent.sid + "/close", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ mode: "hide" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ошибка");
    csModal.style.display = "none";
  } catch (e) { csError.textContent = e.message; csHide.disabled = false; csDelete.disabled = false; csHide.textContent = "Перенести в закрытые"; }
});
csDelete.addEventListener("click", async () => {
  if (!confirm("Точно удалить безвозвратно? jsonl с историей будет удалён.")) return;
  csHide.disabled = true; csDelete.disabled = true;
  csDelete.textContent = "Удаляю…";
  try {
    const res = await fetch("/api/session/" + csCurrent.sid + "/close", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ mode: "delete" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ошибка");
    csModal.style.display = "none";
  } catch (e) { csError.textContent = e.message; csHide.disabled = false; csDelete.disabled = false; csDelete.textContent = "Удалить совсем"; }
});
document.getElementById("cs-cancel").addEventListener("click", () => csModal.style.display = "none");
csModal.addEventListener("click", (e) => { if (e.target === csModal) csModal.style.display = "none"; });

// === New session modal ===
const newSessionBtn = document.getElementById("new-session-btn");
const nsModal = document.getElementById("new-session-modal");
const nsName = document.getElementById("ns-name");
const nsCwd = document.getElementById("ns-cwd");
const nsRcToggle = document.getElementById("ns-rc-toggle");
const nsError = document.getElementById("ns-error");
const nsApply = document.getElementById("ns-apply");
const nsResumeHint = document.getElementById("ns-resume-hint");
const nsRcRow = document.getElementById("ns-rc-row");
let nsResumeState = null; // null = новая | {sid, title, hasLivePid}
function nsReset() {
  nsName.value = "";
  nsCwd.value = "";
  nsRcToggle.classList.remove("on");
  nsError.textContent = "";
  nsApply.disabled = false;
  nsApply.textContent = "Создать";
  nsResumeHint.style.display = "none";
  nsName.classList.remove("locked");
  nsName.readOnly = false;
  nsRcToggle.classList.remove("locked");
  nsRcRow.style.pointerEvents = "";
  nsResumeState = null;
}
async function nsCheckExisting() {
  const cwd = nsCwd.value.trim();
  if (!cwd) {
    nsResumeHint.style.display = "none";
    nsName.classList.remove("locked"); nsName.readOnly = false;
    nsRcToggle.classList.remove("locked"); nsRcRow.style.pointerEvents = "";
    nsApply.textContent = "Создать";
    nsResumeState = null;
    return;
  }
  try {
    const res = await fetch("/api/check-existing?cwd=" + encodeURIComponent(cwd));
    const info = await res.json();
    if (!info.exists) {
      nsResumeHint.style.display = "none";
      nsName.classList.remove("locked"); nsName.readOnly = false;
      nsRcToggle.classList.remove("locked"); nsRcRow.style.pointerEvents = "";
      nsApply.textContent = "Создать";
      nsResumeState = null;
      return;
    }
    nsResumeState = info;
    if (info.hasLivePid) {
      // Уже открыта в Terminal
      nsResumeHint.className = "ns-resume-hint warn";
      nsResumeHint.textContent = "⚠ В этой папке уже запущена терминальная сессия (sid " + info.sid.slice(0,8) + "). Открой её карточку — дублировать нельзя.";
      nsResumeHint.style.display = "block";
      nsApply.disabled = true;
      nsApply.textContent = "Создать";
    } else {
      nsResumeHint.className = "ns-resume-hint";
      const titleText = info.title || ("сессия " + info.sid.slice(0, 8));
      nsResumeHint.textContent = "↩ Будет восстановлена существующая сессия «" + titleText + "». Имя сохранится, Remote Control включится автоматически.";
      nsResumeHint.style.display = "block";
      nsName.value = titleText;
      nsName.classList.add("locked"); nsName.readOnly = true;
      nsRcToggle.classList.add("on");
      nsRcToggle.classList.add("locked"); nsRcRow.style.pointerEvents = "none";
      nsApply.textContent = "Восстановить";
      nsApply.disabled = false;
    }
  } catch {}
}
let nsCheckTimer = null;
nsCwd.addEventListener("input", () => {
  clearTimeout(nsCheckTimer);
  nsCheckTimer = setTimeout(nsCheckExisting, 400);
});
newSessionBtn.addEventListener("click", () => {
  nsReset();
  nsModal.style.display = "flex";
  // Сначала фокус на папку — она определяет дальнейший флоу
  setTimeout(() => nsCwd.focus(), 50);
});
document.getElementById("ns-cancel").addEventListener("click", () => nsModal.style.display = "none");
nsModal.addEventListener("click", (e) => { if (e.target === nsModal) nsModal.style.display = "none"; });
document.getElementById("ns-rc-row").addEventListener("click", () => nsRcToggle.classList.toggle("on"));

// Folder picker: при клике показываем выпадающий список из cwd живых сессий + стандартные.
const nsFolderList = document.getElementById("ns-folder-list");
function buildFolderList() {
  const fromSessions = (sessionsCache || []).map(s => s.cwd).filter(Boolean);
  const std = ["~/", "~/Documents", "~/Documents/клод", "~/Documents/2ATM"];
  const all = [...new Set([...std, ...fromSessions])];
  nsFolderList.innerHTML = all.map(p => '<div class="ns-folder-item" data-path="' + escapeHtml(p) + '">' + escapeHtml(p) + '</div>').join("");
  nsFolderList.querySelectorAll(".ns-folder-item").forEach(el => {
    el.addEventListener("click", () => {
      nsCwd.value = el.dataset.path;
      nsFolderList.style.display = "none";
    });
  });
}
document.getElementById("ns-folder-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (nsFolderList.style.display === "none") {
    buildFolderList();
    nsFolderList.style.display = "block";
  } else {
    nsFolderList.style.display = "none";
  }
});
document.addEventListener("click", (e) => {
  if (!nsFolderList.contains(e.target) && e.target.id !== "ns-folder-btn") {
    nsFolderList.style.display = "none";
  }
});
nsApply.addEventListener("click", async () => {
  const name = nsName.value.trim();
  if (!name) { nsError.textContent = "Введите название"; return; }
  nsApply.disabled = true;
  nsApply.textContent = "Создаю…";
  nsError.textContent = "";
  try {
    const res = await fetch("/api/session/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        cwd: nsCwd.value.trim(),
        remoteControl: nsRcToggle.classList.contains("on"),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      nsError.textContent = data.error || "Ошибка";
      nsApply.disabled = false;
      nsApply.textContent = "Создать";
    } else {
      nsApply.textContent = "✓ Готово";
      setTimeout(() => { nsModal.style.display = "none"; }, 600);
      // Ждём пока новая сессия появится в snapshot (по совпадению title), затем открываем её панель
      let tries = 0;
      const findInterval = setInterval(() => {
        tries++;
        if (tries > 25) { clearInterval(findInterval); return; }
        const found = (sessionsCache || []).find(s => s.title === name);
        if (found) {
          clearInterval(findInterval);
          onCardClick(found.sessionId);
        }
      }, 800);
    }
  } catch (e) {
    nsError.textContent = "Сетевая ошибка: " + e.message;
    nsApply.disabled = false;
    nsApply.textContent = "Создать";
  }
});


// Chrome F11/Cmd+Ctrl+F fullscreen detection: when toolbar auto-slides over the page,
// add body.chrome-fs class so CSS bumps top padding and our topbar stays visible underneath.
// Mobile (iPhone PWA / Safari) is always "fullscreen" by these metrics — skip there.
function updateChromeFsClass() {
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const isFs = !isMobile && window.outerHeight >= screen.height - 2;
  document.body.classList.toggle("chrome-fs", isFs);
}
window.addEventListener("resize", updateChromeFsClass);
updateChromeFsClass();



// Idle-timeout: 30 мин без активности → logout. При полном закрытии браузера/PWA cookie стирается сама
// (session cookie без Max-Age) → ре-логин при следующем открытии.
const IDLE_MS = 30 * 60 * 1000;
let idleTimer = null;
async function doLogout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch {}
  location.href = "/login";
}
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(doLogout, IDLE_MS);
}
["mousedown","mousemove","keydown","touchstart","scroll","click","focus"].forEach(ev =>
  document.addEventListener(ev, resetIdle, { passive: true, capture: true })
);
resetIdle();

// Глобальный перехватчик 401 — если сервер сказал unauthorized, гоним на /login.
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401) { location.href = "/login"; }
  return res;
};
updateWelcome();  // show on initial load

function updatePanelHeader(sid) {
  const p = panels.get(sid);
  if (!p) return;
  const s = findSession(sid);
  if (!s) return;
  const titleEl = p.el.querySelector(".title-main");
  const cwdEl = p.el.querySelector(".cwd-line");
  const meta = s.pid > 0 ? "  ·  pid " + s.pid : "";
  if (s.title) {
    titleEl.textContent = s.title;
    titleEl.style.display = "";
    cwdEl.textContent = s.cwdLabel + meta;
    cwdEl.style.display = "none";  // hide path when title is set; tap title to reveal
  } else {
    titleEl.style.display = "none";
    cwdEl.textContent = s.cwdLabel + meta;
    cwdEl.style.display = "";
  }
  const warnEl = p.el.querySelector(".warn");
  if (s.isSelf) {
    warnEl.textContent = "Это твоя текущая сессия (через /remote-control). Отправка отсюда зациклит канал — поле заблокировано.";
    warnEl.classList.add("self");
    warnEl.style.display = "";
  } else if (s.isDesktop) {
    warnEl.textContent = "Это Claude Desktop сессия — отправка из дашборда недоступна (нет tty). Открой окно вручную.";
    warnEl.classList.remove("self");
    warnEl.style.display = "";
  } else if (s.kidDash && s.kidDash.isBlocked) {
    // Ребёнок-чат сессия + child_active = блокируем композер с баннером + Override-кнопка
    warnEl.classList.remove("self");
    warnEl.classList.add("kid-locked");
    const subj = s.kidDash.currentSubject ? \` (\${s.kidDash.currentSubject})\` : "";
    const until = s.kidDash.expectedEnd ? new Date(s.kidDash.expectedEnd).toLocaleTimeString().slice(0,5) : "";
    const untilTxt = until ? \`, до \${until}\` : "";
    warnEl.innerHTML = \`🔒 Ребёнок сейчас на уроке\${subj}\${untilTxt} — композер заблокирован. <button class="kid-override-btn">Override</button>\`;
    warnEl.style.display = "";
    const overrideBtn = warnEl.querySelector(".kid-override-btn");
    if (overrideBtn) {
      overrideBtn.addEventListener("click", async () => {
        if (!confirm("Точно прервать урок ребёнка? Композер разблокируется на 60 секунд.")) return;
        try {
          const r = await fetch("/api/kid-dash/override", { method: "POST" });
          if (r.ok) {
            overrideBtn.textContent = "✓ разблокировано";
            overrideBtn.disabled = true;
          } else {
            alert("Не удалось разблокировать: " + r.status);
          }
        } catch (e) { alert("Сеть: " + e); }
      });
    }
  } else {
    warnEl.classList.remove("kid-locked");
    warnEl.style.display = "none";
  }
  const blocked = s.isDesktop || s.isSelf || (s.kidDash && s.kidDash.isBlocked);
  p.el.querySelector("textarea").disabled = blocked;
  p.el.querySelector(".send-btn").disabled = blocked;
  // Status-line между feed и composer (стиль claude code: ✻ Думает… (1m 26s · ↑ 3.7k tokens))
  const statusLine = p.el.querySelector(".status-line");
  if (statusLine) {
    const labels = { thinking: "Думает…", tool: "Запускает инструмент…", waiting: "Готов к ответу" };
    if (s.limitHit && s.tty) {
      // Лимит исчерпан — особый статус + кнопка разбудить
      statusLine.className = "status-line limit";
      statusLine.innerHTML = '<span class="claude-mark">⚠</span><span class="status-text">Лимит исчерпан' + (s.limitResetAt ? \` (сброс \${s.limitResetAt})\` : "") + '</span><button class="wake-btn" data-sid="' + sid + '">Разбудить</button>';
      statusLine.querySelector(".wake-btn").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = "…";
        try {
          const r = await fetch("/api/session/" + sid + "/wake", { method: "POST" });
          if (!r.ok) { const d = await r.json().catch(()=>({})); alert("Ошибка: " + (d.error || r.status)); }
          else btn.textContent = "✓";
        } catch (e2) { alert("Сеть: " + e2.message); }
        setTimeout(() => { btn.disabled = false; btn.textContent = "Разбудить"; }, 3000);
      });
      statusLine.style.display = "flex";
    } else if (!s.tty || s.status === "idle" || s.status === "unknown") {
      statusLine.style.display = "none";
    } else {
      statusLine.className = "status-line " + s.status;
      let extras = [];
      if (s.busySince && (s.status === "thinking" || s.status === "tool")) {
        const ageSec = Math.floor((Date.now() - new Date(s.busySince).getTime()) / 1000);
        if (ageSec > 0) {
          const m = Math.floor(ageSec / 60);
          const sec = ageSec % 60;
          extras.push(m > 0 ? \`\${m}m \${sec}s\` : \`\${sec}s\`);
        }
      }
      if (s.inputTokens && s.inputTokens > 0) {
        const t = s.inputTokens >= 1000 ? (s.inputTokens / 1000).toFixed(1) + "k" : s.inputTokens.toString();
        extras.push(\`~\${t} ctx\`);
      }
      const suffix = extras.length ? \` (\${extras.join(" · ")})\` : "";
      statusLine.innerHTML = '<span class="claude-mark">✻</span><span class="status-text">' + escapeHtml((labels[s.status] || s.status) + suffix) + '</span>';
      statusLine.style.display = "flex";
    }
  }
}

async function refreshFeedPanel(sid) {
  const p = panels.get(sid);
  if (!p) return;
  try {
    const res = await fetch("/api/session/" + sid + "/messages", { cache: "no-store" });
    if (!res.ok) return;
    const msgs = await res.json();
    const feed = p.el.querySelector(".feed");
    // Не ломать выделение, если пользователь сейчас выделяет текст внутри этой панели
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0 && p.el.contains(sel.anchorNode)) return;
    // Skip если контент не изменился (избегаем лишних перерисовок)
    const html = msgs.map(m => {
      if (m.role === "question" && m.question) {
        const q = m.question;
        // Если ответ — свободный текст (не совпадает ни с одним label-варианта), то это и есть free-text-ответ.
        // В таком случае подсветим free-text-опцию и покажем В НЕЙ сам текст пользователя как label.
        const isFreeTextAnswer = q.answered && q.answeredWith && !q.options.some(opt => opt.label === q.answeredWith);
        const optsHtml = q.options.map((o, i) => {
          const label = (o.label || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const desc = (o.description || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          if (q.answered) {
            // Для free-text-ответа — особый рендер у isFreeText-опции
            if (isFreeTextAnswer && o.isFreeText) {
              const userText = (q.answeredWith || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
              const tuiNum = o.tuiNum || (i + 1);
              return \`<div class="q-opt picked free-text-answered"><span class=q-check>●</span><span class=q-num>\${tuiNum}</span><span class=q-label>\${userText}</span></div>\`;
            }
            const isPicked = q.answeredWith && q.answeredWith === o.label;
            const tuiNum = o.tuiNum || (i + 1);
            return \`<div class="q-opt \${isPicked?"picked":""}"><span class=q-check>\${isPicked?"●":""}</span><span class=q-num>\${tuiNum}</span><span class=q-label>\${label}</span>\${desc?\`<div class=q-desc>\${desc}</div>\`:""}</div>\`;
          }
          const isFree = !!o.isFreeText;
          const labelHtml = isFree ? "Свой вариант" : label;
          const freeInputHtml = isFree
            ? \`<input type="text" class="q-free-input" placeholder="Введите свой ответ…" \${q.answered?"disabled":""} />\`
            : "";
          const tuiNum = o.tuiNum || (i + 1);
          // Опции кликабельные и в single-tab, и в multi-tab — выбор применяется к текущей вкладке.
          return \`<button class="q-opt active \${isFree?"free-text":""}" data-idx="\${tuiNum}" \${isFree?"data-free-text=\\"1\\"":""}><span class=q-num>\${tuiNum}</span><span class=q-label>\${labelHtml}</span>\${desc?\`<div class=q-desc>\${desc}</div>\`:""}\${freeInputHtml}</button>\`;
        }).join("");
        const headerHtml = q.header ? \`<div class=q-header>\${q.header.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>\` : "";
        // Если ответ — free-text, но в options нет isFreeText-опции (старые jsonl-вопросы без TUI-обогащения),
        // дорисуем синтетическую «Свой вариант» в конец, с пользовательским текстом
        const hasFreeTextOpt = q.options.some(o => o.isFreeText);
        const extraFreeTextHtml = (q.answered && isFreeTextAnswer && !hasFreeTextOpt)
          ? \`<div class="q-opt picked free-text-answered"><span class=q-check>●</span><span class=q-num>5</span><span class=q-label>\${(q.answeredWith||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</span></div>\`
          : "";
        const isMultiTab = !!q.isMultiTab;
        const isSubmitReview = !!q.isSubmitReview;
        const statusHtml = q.answered
          ? \`<div class=q-status>✓ отвечено</div>\`
          : isMultiTab
            ? (isSubmitReview
                ? \`<div class="q-status multitab">Финальный шаг — отправить все ответы или отменить.</div>\`
                : \`<div class="q-status multitab">Выбери ответ, потом нажми «Далее». В этом опросе несколько вопросов — после Далее покажется следующий.</div>\`)
            : \`<div class=q-status>⚠ ждёт твой выбор</div>\`;
        // Single-tab — Отправить/Отмена. Multi-tab — Далее (или Отправить ответы на финальном экране).
        const actionsHtml = q.answered
          ? ""
          : isMultiTab
            ? (isSubmitReview
                ? \`<div class="q-actions"><button class="q-final-submit" type="button">✓ Отправить ответы</button><button class="q-rawkey q-esc" data-key="escape" type="button">Отмена</button></div>\`
                : \`<div class="q-actions"><button class="q-next-tab" type="button" disabled>Далее</button><button class="q-rawkey q-esc" data-key="escape" type="button">Esc</button></div>\`)
            : \`<div class="q-actions"><button class="q-confirm" type="button">Отправить</button><button class="q-cancel" type="button">Отмена</button></div>\`;
        return \`<div class="msg question \${q.answered?"answered":"open"}" data-tool-use-id="\${q.toolUseId}"><div class="who">вопрос</div><div class="q-card" data-tool-use-id="\${q.toolUseId}">\${headerHtml}<div class=q-question>\${renderMd(q.question)}</div><div class=q-opts>\${optsHtml}\${extraFreeTextHtml}</div>\${actionsHtml}\${statusHtml}</div></div>\`;
      }
      return \`
      <div class="msg \${m.role}">
        <div class="who">\${m.role}</div>
        <div class="body">\${renderMd(m.text)}</div>
      </div>
    \`;
    }).join("");
    if (p.lastFeedHtml === html) return;
    p.lastFeedHtml = html;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    feed.innerHTML = html;
    applyQuestionSelection(p, sid);
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  } catch {}
}

// Полл TUI-зеркала для multi-tab control карточек: каждую секунду обновляет содержимое <pre.q-tui-mirror>
async function refreshTuiMirror(sid) {
  const p = panels.get(sid);
  if (!p) return;
  const mirrorEl = p.el.querySelector(".q-tui-mirror");
  if (!mirrorEl) return;  // Нет multi-tab контрола в этой панели — пропускаем
  try {
    const r = await fetch("/api/session/" + sid + "/tui-mirror", { cache: "no-store" });
    if (!r.ok) return;
    const { content } = await r.json();
    if (mirrorEl.textContent !== content) mirrorEl.textContent = content;
  } catch {}
}

function openPanel(sid) {
  const s = findSession(sid);
  if (!s) return;
  const el = document.createElement("div");
  el.className = "panel";
  el.dataset.sid = sid;
  el.innerHTML = \`
    <div class="panel-header">
      <div class="title-block">
        <div class="title-main"></div>
        <div class="cwd-line"></div>
      </div>
      <button class="focus-btn" title="Поднять окно терминала">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button class="interrupt-btn" title="Прервать текущий процесс claude (Esc)">Stop</button>
      <button class="close-btn" title="Закрыть панель">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
      </button>
    </div>
    <div class="warn" style="display:none"></div>
    <div class="feed"><div class="msg"><div class="who">…</div><div class="body">загружаю</div></div></div>
    <div class="status-line" style="display:none"><span class="claude-mark">✻</span><span class="status-text"></span></div>
    <div class="composer-wrap">
      <div class="send-error"></div>
      <div class="send-hint" style="display:none"></div>
      <div class="attachments" style="display:none"></div>
      <div class="composer">
        <input type="file" class="file-input" style="display:none" multiple>
        <button class="attach-btn" title="Прикрепить файл (или drag-drop в панель)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea placeholder="Сообщение" rows="1"></textarea>
        <button class="mic-btn" title="Записать голос → whisper расшифрует в текст">
          <svg class="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          <svg class="rec-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="4"/><polyline points="5 11 12 4 19 11"/></svg>
        </button>
        <button class="send-btn" style="display:none" title="Отправить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  \`;
  document.getElementById("panels").appendChild(el);

  // Click-to-copy for code blocks, inline code, and link-copy buttons
  // Сохраняем введённый текст free-text input + автоматически выбираем этот вариант (если ещё не выбран)
  el.querySelector(".feed").addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("q-free-input")) {
      const card = e.target.closest(".q-card");
      const btn = e.target.closest("button.q-opt");
      const toolUseId = card?.dataset.toolUseId;
      const idx = btn ? parseInt(btn.dataset.idx, 10) : 0;
      if (toolUseId) {
        questionFreeTexts.set(sid, { toolUseId, value: e.target.value });
        // Auto-select: если пользователь печатает в этом инпуте — он явно хочет именно эту опцию
        if (idx) {
          const cur = questionSelections.get(sid);
          if (!cur || cur.toolUseId !== toolUseId || cur.idx !== idx) {
            questionSelections.set(sid, { toolUseId, idx });
            const p = panels.get(sid);
            if (p) applyQuestionSelection(p, sid);
          }
        }
      }
    }
  });
  // То же при focusin (на iPad/Mac tap → focus, иногда без click event)
  el.querySelector(".feed").addEventListener("focusin", (e) => {
    if (e.target.classList && e.target.classList.contains("q-free-input")) {
      const card = e.target.closest(".q-card");
      const btn = e.target.closest("button.q-opt");
      const toolUseId = card?.dataset.toolUseId;
      const idx = btn ? parseInt(btn.dataset.idx, 10) : 0;
      if (idx && toolUseId) {
        questionSelections.set(sid, { toolUseId, idx });
        const p = panels.get(sid);
        if (p) applyQuestionSelection(p, sid);
      }
    }
  });
  // Enter в input → submit как клик по «Отправить»
  el.querySelector(".feed").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("q-free-input")) {
      e.preventDefault();
      const confirmBtn = e.target.closest(".q-card")?.querySelector("button.q-confirm");
      if (confirmBtn) confirmBtn.click();
    }
  });
  el.querySelector(".feed").addEventListener("click", async (e) => {
    const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    // Клик по полю ввода свободного варианта — тут же выставляем выбор на этот вариант,
    // чтобы при клике Отправить ответ ушёл (раньше user мог печатать без выбора → confirm no-op)
    if (e.target.classList && e.target.classList.contains("q-free-input")) {
      const btn = e.target.closest("button.q-opt");
      const card = e.target.closest(".q-card");
      if (btn && card) {
        const idx = parseInt(btn.dataset.idx, 10);
        const toolUseId = card.dataset.toolUseId;
        if (idx && toolUseId) {
          questionSelections.set(sid, { toolUseId, idx });
          const p = panels.get(sid);
          if (p) applyQuestionSelection(p, sid);
        }
      }
      return;  // не делаем preventDefault — фокус нормально встанет в input
    }
    const qOpt = e.target.closest("button.q-opt.active");
    if (qOpt) {
      e.preventDefault();
      const idx = parseInt(qOpt.dataset.idx, 10);
      const card = qOpt.closest(".q-card");
      const toolUseId = card?.dataset.toolUseId;
      if (!idx || !toolUseId) return;
      const cur = questionSelections.get(sid);
      if (cur && cur.toolUseId === toolUseId && cur.idx === idx) {
        questionSelections.delete(sid);
      } else {
        questionSelections.set(sid, { toolUseId, idx });
      }
      const p = panels.get(sid);
      if (p) {
        applyQuestionSelection(p, sid);
        // Если выбрали free-text — фокус в input
        if (qOpt.dataset.freeText) {
          const input = qOpt.querySelector(".q-free-input");
          if (input) setTimeout(() => input.focus(), 0);
        }
        // Multi-tab — активируем кнопку «Далее»
        const nextBtn = card?.querySelector(".q-next-tab");
        if (nextBtn) nextBtn.disabled = !questionSelections.get(sid);
      }
      return;
    }
    // Multi-tab «Далее» — отправляет выбранный ответ в текущую вкладку + переключается на следующую
    const qNextTab = e.target.closest("button.q-next-tab");
    if (qNextTab) {
      e.preventDefault();
      const sel = questionSelections.get(sid);
      if (!sel) return;
      qNextTab.disabled = true;
      qNextTab.textContent = "Передаю ответ…";
      const card = qNextTab.closest(".q-card");
      let freeText;
      if (card) {
        const selectedBtn = card.querySelector('button.q-opt[data-idx="' + sel.idx + '"]');
        if (selectedBtn && selectedBtn.dataset.freeText) {
          const input = selectedBtn.querySelector(".q-free-input");
          const val = (input && input.value || "").trim();
          if (!val) { alert("Введи текст в Свой вариант перед переходом"); qNextTab.disabled = false; qNextTab.textContent = "Далее"; return; }
          freeText = val;
        }
      }
      try {
        // 1) Зафиксировать ответ в текущей вкладке
        const body = { optionIndex: sel.idx };
        if (freeText) body.freeText = freeText;
        const r1 = await fetch("/api/session/" + sid + "/answer-question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r1.ok) {
          const err = await r1.json().catch(() => ({}));
          alert("Ответ не зафиксирован: " + (err.error || r1.status));
          qNextTab.disabled = false; qNextTab.textContent = "Далее";
          return;
        }
        // 2) Логика advance:
        //    - Type something (Свой вариант): TUI сам переключается после Enter+текст+Enter → НЕ слать Right
        //    - Обычная опция (1-4): Enter только переключает галку, надо досылать Right
        if (!freeText) {
          await new Promise(r => setTimeout(r, 400));
          await fetch("/api/session/" + sid + "/send-raw-key", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: "right" }),
          });
        }
        // 3) Сбрасываем локальный selection
        questionSelections.delete(sid);
        questionFreeTexts.delete(sid);
        // 4) Следующий feed-refresh подтянет новую вкладку
      } catch (err) {
        alert("Сеть: " + err);
        qNextTab.disabled = false; qNextTab.textContent = "Далее";
      }
      return;
    }
    // Multi-tab «Отправить ответы» (на Submit Review экране) — Enter подтверждает Submit answers
    const qFinalSubmit = e.target.closest("button.q-final-submit");
    if (qFinalSubmit) {
      e.preventDefault();
      qFinalSubmit.disabled = true;
      qFinalSubmit.textContent = "Отправляю…";
      try {
        // Submit Review экран — option 1 = «Submit answers». Шлём idx=1
        const r = await fetch("/api/session/" + sid + "/answer-question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionIndex: 1 }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert("Не удалось отправить: " + (err.error || r.status));
          qFinalSubmit.disabled = false; qFinalSubmit.textContent = "✓ Отправить ответы";
        }
      } catch (err) {
        alert("Сеть: " + err);
        qFinalSubmit.disabled = false; qFinalSubmit.textContent = "✓ Отправить ответы";
      }
      return;
    }
    const qConfirm = e.target.closest("button.q-confirm");
    if (qConfirm) {
      e.preventDefault();
      const sel = questionSelections.get(sid);
      if (!sel) return;
      // Если выбран free-text вариант — забираем значение из input
      const p = panels.get(sid);
      let freeText;
      if (p) {
        const card = p.el.querySelector('.q-card[data-tool-use-id="' + sel.toolUseId + '"]');
        const selectedBtn = card?.querySelector('button.q-opt[data-idx="' + sel.idx + '"]');
        if (selectedBtn && selectedBtn.dataset.freeText) {
          const input = selectedBtn.querySelector(".q-free-input");
          const val = (input && input.value || "").trim();
          if (!val) {
            alert("Введи свой вариант в поле перед отправкой");
            return;
          }
          freeText = val;
        }
      }
      qConfirm.disabled = true;
      qConfirm.textContent = "…";
      try {
        const body = { optionIndex: sel.idx };
        if (freeText) body.freeText = freeText;
        const res = await fetch("/api/session/" + sid + "/answer-question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert("Не удалось ответить: " + (err.error || res.status));
          qConfirm.disabled = false;
          qConfirm.textContent = "Отправить";
        } else {
          questionSelections.delete(sid);
          questionFreeTexts.delete(sid);
        }
      } catch (err) {
        alert("Сеть: " + err);
        qConfirm.disabled = false;
        qConfirm.textContent = "Отправить";
      }
      return;
    }
    const qCancel = e.target.closest("button.q-cancel");
    if (qCancel) {
      e.preventDefault();
      questionSelections.delete(sid);
      questionFreeTexts.delete(sid);
      const p = panels.get(sid);
      if (p) applyQuestionSelection(p, sid);
      return;
    }
    // Multi-tab: raw-key buttons (стрелки/Enter/Esc)
    const qRawKey = e.target.closest("button.q-rawkey");
    if (qRawKey) {
      e.preventDefault();
      const key = qRawKey.dataset.key;
      if (!key) return;
      qRawKey.disabled = true;
      try {
        const r = await fetch("/api/session/" + sid + "/send-raw-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert("Не удалось: " + (err.error || r.status));
        }
      } catch (err) {
        alert("Сеть: " + err);
      }
      setTimeout(() => { qRawKey.disabled = false; }, 250);
      return;
    }
    // Multi-tab: «Печать» — отправить текст из input в TUI
    const qTextSend = e.target.closest("button.q-text-send");
    if (qTextSend) {
      e.preventDefault();
      const card = qTextSend.closest(".q-card");
      const input = card?.querySelector(".q-text-input");
      const text = (input && input.value || "").trim();
      if (!text) { input?.focus(); return; }
      qTextSend.disabled = true;
      try {
        const r = await fetch("/api/session/" + sid + "/type-text", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert("Не удалось: " + (err.error || r.status));
        } else {
          input.value = "";
        }
      } catch (err) {
        alert("Сеть: " + err);
      }
      setTimeout(() => { qTextSend.disabled = false; }, 250);
      return;
    }
    const copyBtn = e.target.closest(".copy-btn, .link-copy");
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(decodeURIComponent(copyBtn.dataset.copy));
        const origHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = checkIcon;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = origHTML;
          copyBtn.classList.remove("copied");
        }, 1300);
      } catch (err) { console.error("copy failed:", err); }
      return;
    }
    const fileLink = e.target.closest("a.file-link");
    if (fileLink) {
      e.preventDefault();
      const url = fileLink.getAttribute("href");
      const fname = decodeURIComponent(url.split("/").pop());
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) { alert("Не удалось загрузить файл (" + res.status + ")"); return; }
        const blob = await res.blob();
        const file = new File([blob], fname, { type: blob.type });
        // iOS: prefer native share sheet (opens Files / Pages / etc)
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === "AbortError") return; }
        }
        // Fallback: classic blob download
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fname;
        a.target = "_self";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 2000);
      } catch (err) { alert("Ошибка: " + err.message); }
      return;
    }
    const inlineCode = e.target.closest("code.inline-code");
    if (inlineCode) {
      try {
        await navigator.clipboard.writeText(inlineCode.textContent);
        inlineCode.classList.add("copied");
        setTimeout(() => inlineCode.classList.remove("copied"), 1300);
      } catch (err) { console.error("copy failed:", err); }
    }
  });

  // Swap mic ↔ send button based on textarea content (Telegram-style)
  const micBtnEl = el.querySelector(".mic-btn");
  const sendBtnEl = el.querySelector(".send-btn");
  const updateSendMic = () => {
    const hasText = el.querySelector("textarea").value.trim().length > 0;
    const p2 = panels.get(sid);
    const hasAtts = p2 && p2.attachments && p2.attachments.length > 0;
    const showSend = hasText || hasAtts;
    micBtnEl.style.display = showSend ? "none" : "";
    sendBtnEl.style.display = showSend ? "" : "none";
  };
  el.querySelector("textarea").addEventListener("input", updateSendMic);

  el.querySelector(".close-btn").addEventListener("click", () => closePanel(sid));
  el.querySelector(".focus-btn").addEventListener("click", () => focusWindow(sid));
  el.querySelector(".title-block").addEventListener("click", () => {
    openRenameModal(sid);
  });
  el.querySelector(".interrupt-btn").addEventListener("click", async () => {
    const btn = el.querySelector(".interrupt-btn");
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = "…";
    try {
      const res = await fetch("/api/session/" + sid + "/interrupt", { method: "POST" });
      const data = await res.json();
      if (data.error) alert("Ошибка прерывания: " + data.error);
    } catch (e2) { alert("Ошибка: " + e2); }
    setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1500);
  });
  el.querySelector(".send-btn").addEventListener("click", () => sendInPanel(sid));
  // Slash-command автодополнение — меню всплывает над textarea при вводе "/" в начале.
  const composerWrap = el.querySelector(".composer-wrap");
  const cmdMenu = document.createElement("div");
  cmdMenu.className = "cmd-menu";
  composerWrap.appendChild(cmdMenu);
  let cmdState = { visible: false, items: [], active: 0 };
  function cmdFilter() {
    const v = el.querySelector("textarea").value;
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\\n")) return null;
    return v.slice(1).toLowerCase();
  }
  function cmdRender() {
    if (!cmdState.visible) { cmdMenu.classList.remove("show"); return; }
    cmdMenu.innerHTML = cmdState.items.map((c, i) =>
      \`<div class="cmd-item \${i === cmdState.active ? 'active' : ''}" data-cmd="\${c.name}">
        <div class="cmd-name">\${c.name}</div>
        <div class="cmd-desc">\${escapeHtml(c.desc)}</div>
      </div>\`
    ).join("");
    cmdMenu.classList.add("show");
    cmdMenu.querySelectorAll(".cmd-item").forEach(itemEl => {
      itemEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cmdSelect(itemEl.dataset.cmd);
      });
    });
    const activeEl = cmdMenu.querySelector(".cmd-item.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }
  function cmdSelect(name) {
    const ta = el.querySelector("textarea");
    ta.value = name + " ";
    cmdState.visible = false;
    cmdRender();
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }
  function cmdUpdate() {
    const f = cmdFilter();
    if (f === null) { cmdState.visible = false; cmdRender(); return; }
    const matches = SLASH_COMMANDS.filter(c => c.name.slice(1).toLowerCase().startsWith(f));
    if (matches.length === 0) { cmdState.visible = false; cmdRender(); return; }
    cmdState.items = matches;
    if (cmdState.active >= matches.length) cmdState.active = 0;
    cmdState.visible = true;
    cmdRender();
  }
  el.querySelector("textarea").addEventListener("input", () => { cmdState.active = 0; cmdUpdate(); });
  el.querySelector("textarea").addEventListener("blur", () => {
    setTimeout(() => { cmdState.visible = false; cmdRender(); }, 150);
  });
  el.querySelector("textarea").addEventListener("keydown", (e) => {
    if (!cmdState.visible) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cmdState.active = (cmdState.active + 1) % cmdState.items.length;
      cmdRender();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cmdState.active = (cmdState.active - 1 + cmdState.items.length) % cmdState.items.length;
      cmdRender();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      cmdSelect(cmdState.items[cmdState.active].name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cmdState.visible = false;
      cmdRender();
    }
  });

  el.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendInPanel(sid);
    }
  });
  // Auto-grow textarea up to max-height as content fills (Telegram-style)
  const taEl = el.querySelector("textarea");
  const baseHeight = 40;
  const autoResize = () => {
    taEl.style.height = baseHeight + "px";
    const sh = taEl.scrollHeight;
    if (sh > baseHeight) {
      taEl.style.height = Math.min(sh, window.innerHeight * 0.5) + "px";
    }
  };
  taEl.addEventListener("input", autoResize);

  // Attachment handling: drag-drop on panel, file picker via 📎, paste images
  const attachments = []; // [{ path, name }]
  const attachBar = el.querySelector(".attachments");
  const fileInput = el.querySelector(".file-input");
  const attachBtn = el.querySelector(".attach-btn");
  const textarea = el.querySelector("textarea");

  function renderAttachments() {
    if (attachments.length === 0) {
      attachBar.style.display = "none";
      attachBar.innerHTML = "";
      updateSendMic();
      return;
    }
    attachBar.style.display = "";
    attachBar.innerHTML = attachments.map((a, i) =>
      \`<span class="chip" data-i="\${i}">📎 \${escapeHtml(a.name)}<button class="chip-remove" data-i="\${i}">×</button></span>\`
    ).join("");
    for (const btn of attachBar.querySelectorAll(".chip-remove")) {
      btn.addEventListener("click", () => {
        attachments.splice(+btn.dataset.i, 1);
        renderAttachments();
      });
    }
    updateSendMic();
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (data.path) {
          attachments.push({ path: data.path, name: data.name || file.name });
        }
      } catch (e) { console.error(e); }
    }
    renderAttachments();
  }

  // Voice recording → whisper transcription
  const micBtn = el.querySelector(".mic-btn");
  const MIC_SVG_IDLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
  const MIC_SVG_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const MIC_SVG_SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3a9 9 0 1 1-9 9" /></svg>';
  let mediaRecorder = null;
  let recordedChunks = [];
  let audioContext = null;
  let levelRaf = 0;
  let peakLevel = 0;
  function pickMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }
  async function startRecording() {
    try {
      // Try to pick MacBook built-in mic explicitly (bypass "default" device routing)
      let macMicId = "";
      try {
        // First request a basic stream to unlock device labels
        const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        probeStream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mac = devices.find(d => d.kind === "audioinput" && /macbook|built[-\\s]?in/i.test(d.label));
        if (mac) macMicId = mac.deviceId;
      } catch {}
      const constraints = macMicId
        ? { audio: { deviceId: { exact: macMicId } } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      recordedChunks = [];
      peakLevel = 0;
      const tracks = stream.getAudioTracks();
      const trackInfo = tracks.map(t => t.label + " (muted=" + t.muted + ", enabled=" + t.enabled + ")").join("; ");
      console.log("[mic] active tracks:", trackInfo);
      micBtn.title = "Захвачено: " + trackInfo;
      const mimeType = pickMimeType();
      const blobType = mimeType.split(";")[0] || "audio/webm";
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioContext) { try { audioContext.close(); } catch {} audioContext = null; }
        if (levelRaf) { cancelAnimationFrame(levelRaf); levelRaf = 0; }
        micBtn.style.boxShadow = "";
        const blob = new Blob(recordedChunks, { type: blobType });
        if (blob.size < 500 || peakLevel < 8) {
          micBtn.classList.remove("recording");
          micBtn.innerHTML = MIC_SVG_IDLE;
          alert("Запись пустая (peak " + peakLevel.toFixed(0) + "/255).\\nЗахваченное устройство: " + trackInfo + "\\n\\nЕсли тут не «Микрофон MacBook Air» — Chrome зацепился не туда. Проверь chrome://settings/content/microphone.");
          return;
        }
        micBtn.classList.remove("recording");
        micBtn.classList.add("transcribing");
        micBtn.innerHTML = MIC_SVG_SPIN;
        const fd = new FormData();
        fd.append("audio", blob, "voice." + (mimeType.includes("mp4") ? "mp4" : "webm"));
        try {
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (data.text) {
            const cur = textarea.value;
            textarea.value = cur ? cur + (cur.endsWith(" ") || cur.endsWith("\\n") ? "" : " ") + data.text : data.text;
            autoResize();
            updateSendMic();
            textarea.focus();
          } else {
            alert("Не удалось расшифровать: " + (data.error || "?"));
          }
        } catch (e2) {
          alert("Ошибка транскрипции: " + e2);
        } finally {
          micBtn.classList.remove("transcribing");
          micBtn.innerHTML = MIC_SVG_IDLE;
        }
      };
      // Note: AudioContext + analyser on the same MediaStream can interfere with MediaRecorder
      // in Safari (and sometimes Chrome). Disabled for now — diagnose mic via server-side check.
      peakLevel = 999; // skip "empty recording" guard below; let whisper decide
      mediaRecorder.start(250); // emit chunks every 250ms to guarantee data flow
      micBtn.classList.add("recording");
      micBtn.innerHTML = MIC_SVG_STOP;
    } catch (e) {
      alert("Не получилось включить микрофон: " + e);
    }
  }
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }
  micBtn.addEventListener("click", () => {
    if (micBtn.classList.contains("recording")) stopRecording();
    else if (!micBtn.classList.contains("transcribing")) startRecording();
  });

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) uploadFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });

  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", (e) => {
    if (e.target === el) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      uploadFiles(Array.from(e.dataTransfer.files));
    }
  });
  textarea.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  const interval = setInterval(() => refreshFeedPanel(sid), 1500);
  const mirrorInterval = setInterval(() => refreshTuiMirror(sid), 1000);
  panels.set(sid, { el, pollInterval: interval, mirrorInterval, attachments });
  updateWelcome();
  updatePanelHeader(sid);
  setupPanelDrag(el, sid);
  refreshFeedPanel(sid).then(() => {
    const feed = el.querySelector(".feed");
    feed.scrollTop = feed.scrollHeight;
    el.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
    el.querySelector("textarea").focus();
  });
  // mark card as open
  const card = document.querySelector('.card[data-sid="' + sid + '"]');
  if (card) card.classList.add("open");
}

// Drag-and-drop reordering панелей (только на десктопе — на мобильном панель одна за раз).
function setupPanelDrag(panelEl, sid) {
  if (window.matchMedia("(max-width: 768px)").matches) return;
  const header = panelEl.querySelector(".panel-header");
  header.setAttribute("draggable", "true");
  header.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-panel-sid", sid);
    panelEl.classList.add("dragging");
  });
  header.addEventListener("dragend", () => {
    panelEl.classList.remove("dragging");
    document.querySelectorAll(".panel.drag-over-left, .panel.drag-over-right").forEach(p =>
      p.classList.remove("drag-over-left", "drag-over-right"));
  });
  panelEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/x-panel-sid")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = panelEl.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    panelEl.classList.toggle("drag-over-left", e.clientX < mid);
    panelEl.classList.toggle("drag-over-right", e.clientX >= mid);
  });
  panelEl.addEventListener("dragleave", () => {
    panelEl.classList.remove("drag-over-left", "drag-over-right");
  });
  panelEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const draggedSid = e.dataTransfer.getData("text/x-panel-sid");
    panelEl.classList.remove("drag-over-left", "drag-over-right");
    if (!draggedSid || draggedSid === sid) return;
    const draggedEl = panels.get(draggedSid)?.el;
    if (!draggedEl) return;
    const rect = panelEl.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    const container = document.getElementById("panels");
    if (e.clientX < mid) container.insertBefore(draggedEl, panelEl);
    else container.insertBefore(draggedEl, panelEl.nextSibling);
  });
}

function closePanel(sid) {
  const p = panels.get(sid);
  if (!p) return;
  clearInterval(p.pollInterval);
  if (p.mirrorInterval) clearInterval(p.mirrorInterval);
  p.el.remove();
  panels.delete(sid);
  const card = document.querySelector('.card[data-sid="' + sid + '"]');
  if (card) card.classList.remove("open");
  updateWelcome();
}

async function focusWindow(sid) {
  const p = panels.get(sid);
  const res = await fetch("/api/session/" + sid + "/focus", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  const err = p.el.querySelector(".send-error");
  if (data.terminal === "none") {
    err.textContent = "Окно не найдено (закрыто?)";
  } else {
    err.textContent = "";
  }
}

async function sendInPanel(sid) {
  const p = panels.get(sid);
  if (!p) return;
  const input = p.el.querySelector("textarea");
  const userText = input.value.trim();
  const atts = p.attachments || [];
  if (!userText && atts.length === 0) return;
  // Compose final text: prepend @<path> references for each attachment
  const attRefs = atts.map(a => "@" + a.path).join(" ");
  const text = attRefs && userText ? attRefs + " " + userText : (attRefs || userText);
  const btn = p.el.querySelector(".send-btn");
  const errEl = p.el.querySelector(".send-error");
  const hintEl = p.el.querySelector(".send-hint");
  btn.disabled = true;
  errEl.textContent = "";
  hintEl.style.display = "none";
  try {
    const res = await fetch("/api/session/" + sid + "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok || data.terminal === "none") {
      errEl.textContent = data.error || "Не удалось отправить";
    } else {
      // Без всплывающей подсказки об отправке — статус виден через индикатор в шапке.
      hintEl.style.display = "none";
      input.value = "";
      input.style.height = "";  // reset to base height
      const panel = panels.get(sid);
      if (panel) {
        const m = panel.el.querySelector(".mic-btn");
        const s = panel.el.querySelector(".send-btn");
        if (m) m.style.display = "";
        if (s) s.style.display = "none";
      }
      atts.length = 0;
      const attBar = p.el.querySelector(".attachments");
      attBar.style.display = "none";
      attBar.innerHTML = "";
      setTimeout(() => refreshFeedPanel(sid), 500);
    }
  } catch (e) {
    errEl.textContent = String(e);
  } finally {
    btn.disabled = false;
  }
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    document.getElementById("meta").textContent = "соединение разорвано — переподключаюсь…";
    es.close();
    // Probe via fetch — if cookie протухла, патченный window.fetch перенаправит на /login.
    fetch("/api/sessions").then(r => { if (r.ok) setTimeout(connect, 2000); }).catch(() => setTimeout(connect, 2000));
  };
}
connect();

// === Connection health monitor ===
// Каждые 10 сек дёргает /api/health (без авторизации, дешёвый ping). По коду ответа определяет
// конкретную причину и показывает баннер. Без этого, при разрыве Mac-VPS туннеля, дашборд просто молчит.
const connModal = document.getElementById("conn-modal");
const connIcon = document.getElementById("conn-icon");
const connTitle = document.getElementById("conn-title");
const connDetail = document.getElementById("conn-detail");
const connRetry = document.getElementById("conn-retry");
const ICON_OFFLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
const ICON_TUNNEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/><path d="M12 10v4"/></svg>';
const ICON_SERVER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';
let lastConnError = null;
function showConn(level, title, detail, iconKey) {
  const key = title + "|" + detail;
  if (lastConnError === key) return;
  lastConnError = key;
  connModal.className = "conn-modal" + (level === "warn" ? " warn" : "");
  connTitle.textContent = title;
  connDetail.textContent = detail;
  connIcon.innerHTML = iconKey === "tunnel" ? ICON_TUNNEL : iconKey === "server" ? ICON_SERVER : ICON_OFFLINE;
  connModal.style.display = "flex";
}
function hideConn() {
  if (lastConnError === null) return;
  lastConnError = null;
  connModal.style.display = "none";
}
connRetry.addEventListener("click", () => {
  connRetry.disabled = true;
  connRetry.textContent = "Проверяю…";
  checkHealth().finally(() => {
    setTimeout(() => { connRetry.disabled = false; connRetry.textContent = "Повторить"; }, 800);
  });
});
async function hasExternalNet() {
  // Пробуем достучаться до Cloudflare 1.1.1.1 — если сеть на устройстве вообще есть, fetch ляжет в opaque success.
  try {
    await fetch("https://1.1.1.1/cdn-cgi/trace", { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}
async function checkHealth() {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (res.ok) { hideConn(); return; }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      showConn("err",
        "Туннель Mac→VPS упал",
        "VPS на связи, но дашборд-сервер на твоём Mac не отвечает. Watchdog пытается восстановить, обычно 1-3 минуты.",
        "tunnel");
    } else if (res.status >= 500) {
      showConn("err", "Серверная ошибка дашборда", "Status " + res.status + ". Сервер перезапускается.", "server");
    } else {
      hideConn();
    }
  } catch (e) {
    const netOk = await hasExternalNet();
    if (netOk) {
      showConn("err",
        "Сервер дашборда недоступен",
        "Интернет на устройстве работает, но VPS дашборда не отвечает. Скорее всего проблема у хостинг-провайдера VPS — подожди пару минут.",
        "server");
    } else {
      showConn("err",
        "Нет интернета на устройстве",
        "Не достучаться ни до VPS, ни до Cloudflare. Проверь Wi-Fi/VPN.",
        "offline");
    }
  }
}
setInterval(checkHealth, 10000);
checkHealth();

// === Update check ===
const updateBtn = document.getElementById("update-btn");
const updateModal = document.getElementById("update-modal");
async function checkUpdate() {
  try {
    const res = await fetch("/api/update-info", { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    updateBtn.dataset.info = JSON.stringify(info);
    const updState = document.getElementById("updates-state");
    if (updState) {
      const ver = info.local || "?";
      updState.innerHTML = info.available
        ? "v" + ver + ' <span class="green-dot" title="доступно обновление до v' + info.remote + '"></span>'
        : "v" + ver;
    }
    const dots = ["menu-dot", "settings-dot", "updates-dot"];
    dots.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = info.available ? "inline-block" : "none";
    });
  } catch {}
}
setInterval(checkUpdate, 5 * 60 * 1000); // каждые 5 мин
checkUpdate();
updateBtn.addEventListener("click", () => {
  const info = JSON.parse(updateBtn.dataset.info || "{}");
  document.getElementById("upd-local").textContent = info.local || "?";
  document.getElementById("upd-remote").textContent = info.remote || "?";
  document.getElementById("upd-date").textContent = info.date ? "(" + info.date + ")" : "";
  const ul = document.getElementById("upd-notes");
  const applyBtn = document.getElementById("upd-apply");
  const cancelBtn = document.getElementById("upd-cancel");
  if (info.available) {
    document.querySelector("#update-modal h2").textContent = "Доступно обновление";
    document.querySelector("#update-modal .update-notes-title").textContent = "Что нового:";
    document.querySelector("#update-modal .update-versions").style.display = "";
    ul.innerHTML = (info.notes && info.notes.length ? info.notes : ["Без описания"]).map(n => "<li>" + escapeHtml(n) + "</li>").join("");
    applyBtn.style.display = "";
    applyBtn.disabled = !info.canApply;
    applyBtn.textContent = info.canApply ? "Обновить сейчас" : "Авто-обновление недоступно";
    cancelBtn.textContent = "Позже";
  } else {
    document.querySelector("#update-modal h2").textContent = "Актуальная версия";
    document.querySelector("#update-modal .update-notes-title").textContent = "У вас стоит последняя версия v" + (info.local || "?") + ". Обновляться не нужно.";
    document.querySelector("#update-modal .update-versions").style.display = "none";
    ul.innerHTML = "";
    applyBtn.style.display = "none";
    cancelBtn.textContent = "OK";
  }
  updateModal.style.display = "flex";
});
document.getElementById("upd-cancel").addEventListener("click", () => updateModal.style.display = "none");
updateModal.addEventListener("click", (e) => { if (e.target === updateModal) updateModal.style.display = "none"; });
document.getElementById("upd-apply").addEventListener("click", async () => {
  const btn = document.getElementById("upd-apply");
  btn.disabled = true;
  btn.textContent = "Обновляю…";
  try {
    const res = await fetch("/api/update-apply", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      btn.textContent = "Готово, перезагружаю…";
      // Подождём пока сервер перезапустится и перезагрузим страницу
      setTimeout(() => location.reload(), 8000);
    } else {
      alert("Ошибка: " + (data.error || res.status));
      btn.disabled = false;
      btn.textContent = "Обновить сейчас";
    }
  } catch (e) {
    alert("Ошибка сети: " + e.message);
    btn.disabled = false;
    btn.textContent = "Обновить сейчас";
  }
});
// Register service worker for PWA installability + push notifications.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// === Push notifications subscribe flow ===
const pushBtn = document.getElementById("push-btn");
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function updatePushBtnState() {
  const toggle = document.getElementById("notif-toggle");
  const notifItem = document.getElementById("settings-notifications");
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (notifItem) notifItem.style.display = "none";
    return;
  }
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) { if (notifItem) notifItem.style.display = "none"; return; }
  const sub = await reg.pushManager.getSubscription();
  const granted = Notification.permission === "granted" && !!sub;
  if (toggle) toggle.classList.toggle("on", granted);
}
pushBtn.addEventListener("click", async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await fetch("/api/push/unsubscribe", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ endpoint: existing.endpoint }) });
      await existing.unsubscribe();
      await updatePushBtnState();
      return;
    }
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { alert("Разрешение не выдано"); return; }
    }
    const res = await fetch("/api/push/vapid-public-key");
    const { key } = await res.json();
    if (!key) { alert("VAPID-ключ не сконфигурирован на сервере"); return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await fetch("/api/push/subscribe", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(sub.toJSON()) });
    await updatePushBtnState();
    alert("Уведомления включены");
  } catch (e) {
    alert("Не получилось: " + e.message);
  }
});
updatePushBtnState();
</script>
</body>
</html>`;

// === Web Push notifications ===
// Уведомления когда сессия Claude переходит в waiting (claude ждёт ответ пользователя).
// Подписки хранятся в ~/.cc-dashboard/push-subs.json, VAPID keys в ~/.cc-dashboard/vapid.json.
import webpush from "web-push";
const VAPID_FILE = join(homedir(), ".cc-dashboard", "vapid.json");
const PUSH_SUBS_FILE = join(homedir(), ".cc-dashboard", "push-subs.json");
let vapidKeys: { publicKey: string; privateKey: string; subject: string } | null = null;
try { vapidKeys = await Bun.file(VAPID_FILE).json(); webpush.setVapidDetails(vapidKeys.subject, vapidKeys.publicKey, vapidKeys.privateKey); }
catch { console.warn(`[push] ${VAPID_FILE} not found — push notifications disabled`); }

type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
let pushSubscriptions: PushSubscriptionJSON[] = [];
try { pushSubscriptions = await Bun.file(PUSH_SUBS_FILE).json(); } catch {}
async function savePushSubs() {
  await Bun.write(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2));
}

// Track previous status per session — to detect transitions (e.g. thinking → waiting).
const prevStatusBySid = new Map<string, string>();

async function sendPushToAll(payload: { title: string; body: string; tag?: string }) {
  if (!vapidKeys || pushSubscriptions.length === 0) return;
  const data = JSON.stringify(payload);
  const dead: number[] = [];
  await Promise.all(pushSubscriptions.map(async (sub, i) => {
    try {
      await webpush.sendNotification(sub as any, data);
    } catch (e: any) {
      // Очищаем подписку при ошибках, которые означают что она невалидна:
      //   410 Gone — отписалась/устройство удалило
      //   404 Not Found — endpoint больше не существует
      //   403 BadJwtToken (Apple) — VAPID отвергнут конкретно для этой подписки (часто = просрочка)
      //   403 + body содержит "BadJwtToken"
      const body = String(e?.body || "");
      const isBadJwt = e?.statusCode === 403 && /BadJwtToken|Forbidden/i.test(body);
      if (e?.statusCode === 410 || e?.statusCode === 404 || isBadJwt) {
        dead.push(i);
      }
      console.error("[push] send failed:", e?.statusCode, body.slice(0, 200));
    }
  }));
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !dead.includes(i));
    await savePushSubs();
    console.log(`[push] cleaned up ${dead.length} dead subscription(s), remaining: ${pushSubscriptions.length}`);
  }
}

// Periodic poller: detect transition into "waiting" status, send push.
const prevOpenQuestionBySid = new Map<string, boolean>();
setInterval(async () => {
  try {
    const sessions = await snapshot();
    for (const s of sessions) {
      if (!s.tty || s.isSelf) continue;
      const prev = prevStatusBySid.get(s.sessionId);
      if (prev && prev !== "waiting" && s.status === "waiting") {
        const title = s.title || s.cwdLabel || "Claude";
        sendPushToAll({ title: `${title}: ждёт ответа`, body: "Claude закончил и ждёт от тебя ввода", tag: s.sessionId }).catch(() => {});
      }
      prevStatusBySid.set(s.sessionId, s.status);
      // Push на появление НОВОГО открытого вопроса (AskUserQuestion)
      const prevQ = prevOpenQuestionBySid.get(s.sessionId) ?? false;
      if (!prevQ && s.hasOpenQuestion) {
        const title = s.title || s.cwdLabel || "Claude";
        sendPushToAll({ title: `❓ ${title} спрашивает`, body: "Открой панель — нужен твой выбор", tag: "q-" + s.sessionId }).catch(() => {});
      }
      prevOpenQuestionBySid.set(s.sessionId, !!s.hasOpenQuestion);
    }
  } catch (e) { console.error("[push poller]", e); }
}, 3000);

// === Update mechanism ===
// Локальный RELEASE.json (копируется через setup-local.ts) vs remote на GitHub.
// /api/update-info — клиент опрашивает, видит ли он апдейт. /api/update-apply — запустить.
type Release = { version: string; date?: string; notes?: string[] };
let localRelease: Release | null = null;
let remoteRelease: Release | null = null;
const RELEASE_FILE = join(homedir(), ".cc-dashboard", "RELEASE.json");
const REPO_PATH_FILE = join(homedir(), ".cc-dashboard", "repo-path.txt");
try { localRelease = await Bun.file(RELEASE_FILE).json(); }
catch { localRelease = { version: "0.0.0" }; }

async function deriveRawReleaseUrl(): Promise<string | null> {
  // Извлекает origin из git-репо и формирует raw.githubusercontent URL для RELEASE.json
  try {
    const repoPath = (await Bun.file(REPO_PATH_FILE).text()).trim();
    const proc = Bun.spawnSync(["git", "-C", repoPath, "remote", "get-url", "origin"]);
    const remote = proc.stdout.toString().trim();
    // https://github.com/owner/repo.git → https://raw.githubusercontent.com/owner/repo/main/RELEASE.json
    const m = remote.match(/github\.com[:\/]([^/]+)\/([^/.]+)/);
    if (!m) return null;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/RELEASE.json`;
  } catch { return null; }
}

let rawReleaseUrl: string | null = await deriveRawReleaseUrl();
if (rawReleaseUrl) console.log(`[update] poll URL: ${rawReleaseUrl}`);

async function pollRemoteRelease() {
  if (!rawReleaseUrl) return;
  try {
    const res = await fetch(rawReleaseUrl, { cache: "no-store" });
    if (!res.ok) return;
    remoteRelease = await res.json();
  } catch {}
}
pollRemoteRelease();
setInterval(pollRemoteRelease, 10 * 60 * 1000);  // every 10 min

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// === Auth ===
const AUTH_FILE = join(homedir(), ".cc-dashboard", "auth.json");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24h server-side token validity. Cookie itself is session-only (см. cookieHeader).
type AuthConfig = { users: { login: string; hash: string }[]; secret: string };
let authConfig: AuthConfig | null = null;
try { authConfig = await Bun.file(AUTH_FILE).json(); } catch {}
if (!authConfig) console.warn(`[auth] ${AUTH_FILE} not found — server will refuse all traffic. Run: bun run ~/.cc-dashboard/setup-auth.ts`);

function makeToken(login: string, secret: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${login}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyToken(token: string, secret: string): string | null {
  // Login может содержать точки (например, email) — используем lastIndexOf, не split.
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 0) return null;
  const sig = token.slice(lastDot + 1);
  const payload = token.slice(0, lastDot);
  const expDot = payload.lastIndexOf(".");
  if (expDot < 0) return null;
  const expStr = payload.slice(expDot + 1);
  const login = payload.slice(0, expDot);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? login : null;
}
function getSessionLogin(req: Request): string | null {
  if (!authConfig) return null;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!m) return null;
  return verifyToken(decodeURIComponent(m[1]), authConfig.secret);
}
function cookieHeader(token: string | null): string {
  if (!token) return `cc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  // НЕТ Max-Age/Expires — это session cookie. Полное закрытие браузера/PWA → cookie исчезает → форс ре-логин.
  return `cc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
}
function isPublicAsset(pathname: string): boolean {
  return pathname === "/manifest.json"
    || pathname === "/sw.js"
    || pathname === "/icon.svg"
    || pathname === "/api/health"
    || /^\/icon-\d+\.png$/.test(pathname);
}

const LOGIN_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0d1117" />
<link rel="manifest" href="/manifest.json" />
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png?v=2" />
<link rel="icon" type="image/svg+xml" href="/icon.svg?v=2" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&display=swap" rel="stylesheet">
<title> </title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 -apple-system, "SF Pro Text", system-ui, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .login-box { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 22px; }
  h1 { font-family: 'UnifrakturCook', serif; font-size: clamp(34px, 8vw, 52px); font-weight: 700; margin: 0 0 8px; text-align: center; color: #f0f6fc; letter-spacing: 0.04em; text-shadow: 0 0 14px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.5); position: relative; }
  h1 .blood { position: absolute; left: 0; right: 0; top: 0; color: #a30000; pointer-events: none; text-shadow: 0 0 10px rgba(180,0,0,0.55), 0 2px 6px rgba(60,0,0,0.7); clip-path: inset(0 0 100% 0); animation: bloodDrip 90s linear infinite; animation-delay: -80s; will-change: clip-path, opacity; }
  @keyframes bloodDrip {
    0%, 94% { clip-path: inset(0 0 100% 0); opacity: 0.92; }
    97% { clip-path: inset(0 0 50% 0); opacity: 0.92; }
    98.5% { clip-path: inset(0 0 0 0); opacity: 0.92; }
    99.5% { clip-path: inset(0 0 0 0); opacity: 0.8; }
    100% { clip-path: inset(0 0 0 0); opacity: 0; }
  }
  form { display: flex; flex-direction: column; gap: 12px; }
  input { background: #161b22; border: 1px solid #30363d; color: #e6edf3; border-radius: 24px; padding: 14px 22px; font-size: 16px; font-family: inherit; width: 100%; box-sizing: border-box; }
  input::placeholder { color: #6e7681; }
  input:focus { outline: 0; border-color: #58a6ff; }
  button { background: #21262d; border: 0; color: #ffffff; border-radius: 24px; padding: 14px 22px; font-size: 16px; font-weight: 500; cursor: pointer; font-family: inherit; transition: background 0.15s, transform 0.15s; margin-top: 4px; }
  button:hover { background: #30363d; }
  button:active { transform: scale(0.98); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .err { color: #f85149; font-size: 13px; min-height: 18px; text-align: center; }
</style>
</head><body>
<div class="login-box">
  <h1>CC Dashboard<span class="blood" aria-hidden="true">CC Dashboard</span></h1>
  <form id="f" autocomplete="on">
    <input id="login" name="login" type="text" placeholder="Логин" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required />
    <input id="password" name="password" type="password" placeholder="Пароль" autocomplete="current-password" required />
    <button type="submit" id="submit">Войти</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
const f = document.getElementById("f");
const err = document.getElementById("err");
const btn = document.getElementById("submit");
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        login: document.getElementById("login").value,
        password: document.getElementById("password").value,
      }),
    });
    if (res.ok) {
      location.href = "/";
    } else {
      const data = await res.json().catch(() => ({}));
      err.textContent = data.error || "Ошибка входа";
    }
  } catch (e2) {
    err.textContent = "Сетевая ошибка: " + e2;
  } finally {
    btn.disabled = false;
  }
});
</script>
</body></html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // === AUTH GATE ===
    if (!authConfig) {
      return new Response("Auth не настроен. Запусти: bun run ~/.cc-dashboard/setup-auth.ts", { status: 503 });
    }
    if (url.pathname === "/login") {
      return new Response(LOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { login?: string; password?: string } | null;
      if (!body || typeof body.login !== "string" || typeof body.password !== "string") {
        return Response.json({ error: "Неверный запрос" }, { status: 400 });
      }
      const user = authConfig.users.find(u => u.login === body.login);
      const ok = user ? await Bun.password.verify(body.password, user.hash).catch(() => false) : false;
      if (!ok) {
        console.log(`[/api/login] FAIL login="${body.login}" user_found=${!!user}`);
        return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
      }
      console.log(`[/api/login] OK login="${body.login}"`);
      const token = makeToken(user!.login, authConfig.secret);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": cookieHeader(token) },
      });
    }
    if (url.pathname === "/api/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": cookieHeader(null) },
      });
    }

    // Public assets bypass auth (PWA needs manifest/icons before login)
    const isPublic = isPublicAsset(url.pathname);
    let authedLogin: string | null = null;
    if (!isPublic) {
      authedLogin = getSessionLogin(req);
      if (!authedLogin) {
        if (url.pathname === "/") {
          return new Response(null, { status: 302, headers: { location: "/login" } });
        }
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    // === ROUTING ===
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/manifest.json") {
      return new Response(MANIFEST_JSON, { headers: { "content-type": "application/manifest+json" } });
    }
    if (url.pathname === "/sw.js") {
      return new Response(SERVICE_WORKER_JS, { headers: { "content-type": "application/javascript" } });
    }
    if (url.pathname === "/icon.svg") {
      return new Response(ICON_SVG, { headers: { "content-type": "image/svg+xml" } });
    }
    const pngMatch = url.pathname.match(/^\/icon-(180|192|512)\.png$/);
    if (pngMatch) {
      const path = `${homedir()}/.cc-dashboard/icons/icon-${pngMatch[1]}.png`;
      try {
        const file = Bun.file(path);
        return new Response(file, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      } catch { return new Response("not found", { status: 404 }); }
    }
    if (url.pathname === "/api/health") {
      // Без авторизации — клиент дёргает каждые 10с, чтобы проверить связность.
      return Response.json({ ok: true, ts: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/commands") {
      return Response.json(await discoverPluginCommands());
    }
    if (url.pathname === "/api/update-info") {
      const local = localRelease?.version ?? "0.0.0";
      const remote = remoteRelease?.version ?? local;
      const available = compareVersions(local, remote) < 0;
      return Response.json({
        local, remote, available,
        notes: available ? (remoteRelease?.notes ?? []) : [],
        date: remoteRelease?.date,
        canApply: !!rawReleaseUrl,  // если репо-путь известен — можно нажать кнопку
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/update-apply" && req.method === "POST") {
      try {
        const repoPath = (await Bun.file(REPO_PATH_FILE).text()).trim();
        // Detached: сервер сам перезагрузится через launchctl, ответ клиенту вернётся ДО рестарта.
        const cmd = `cd ${JSON.stringify(repoPath)} && git pull --ff-only && bun run setup-local.ts > /tmp/cc-dash-update.log 2>&1`;
        Bun.spawn(["bash", "-c", `(${cmd}) &`], { stdout: "ignore", stderr: "ignore" });
        return Response.json({ ok: true, message: "Обновление запущено. Дашборд перезагрузится через несколько секунд." });
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    if (url.pathname === "/api/push/vapid-public-key") {
      return Response.json({ key: vapidKeys?.publicKey ?? null });
    }
    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      const body = await req.json().catch(() => null) as PushSubscriptionJSON | null;
      if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
        return Response.json({ error: "bad subscription" }, { status: 400 });
      }
      // dedupe by endpoint
      pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== body.endpoint);
      pushSubscriptions.push(body);
      await savePushSubs();
      console.log(`[push] subscribed, total=${pushSubscriptions.length}`);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { endpoint?: string } | null;
      if (!body?.endpoint) return Response.json({ error: "bad request" }, { status: 400 });
      pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== body.endpoint);
      await savePushSubs();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/push/test" && req.method === "POST") {
      await sendPushToAll({ title: "CC Dashboard", body: "Тестовое уведомление работает" });
      return Response.json({ ok: true, subs: pushSubscriptions.length });
    }
    if (url.pathname === "/api/sessions") {
      return Response.json(await snapshot());
    }
    // kid-dash override: мама подтвердила «точно прервать урок» → разблокировка на 60 сек
    if (url.pathname === "/api/kid-dash/override" && req.method === "POST") {
      kidDashOverrideUntil = Date.now() + KID_DASH_OVERRIDE_DURATION_MS;
      // Сбросить кэш состояния чтобы изменения применились сразу
      kidDashStateCache = { at: 0, value: null };
      return Response.json({ ok: true, overrideUntil: kidDashOverrideUntil });
    }
    if (url.pathname === "/api/kid-dash/override" && req.method === "DELETE") {
      kidDashOverrideUntil = null;
      kidDashStateCache = { at: 0, value: null };
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/stream") {
      const stream = new ReadableStream({
        async start(controller) {
          let closed = false;
          const send = async () => {
            if (closed) return;
            try {
              const data = await snapshot();
              if (closed) return;
              controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e: any) {
              if (e?.code !== "ERR_INVALID_STATE") console.error("snapshot:", e);
              closed = true;
            }
          };
          await send();
          const interval = setInterval(send, 2000);
          req.signal.addEventListener("abort", () => {
            closed = true;
            clearInterval(interval);
            try { controller.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    }

    const interruptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === "POST") {
      const sid = interruptMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      const script = `tell application "System Events"
        set prevApp to name of first process whose frontmost is true
      end tell
      tell application "Terminal"
        repeat with w in windows
          try
          repeat with t in tabs of w
            try
              if (tty of t) is "/dev/${meta.tty}" then
                set selected of t to true
                set frontmost of w to true
                activate
                delay 0.12
                tell application "System Events" to key code 53
                return "ok"
              end if
            end try
          end repeat
          end try
        end repeat
      end tell
      return "not found"`;
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      console.log(`[interrupt ${meta.tty}] out="${out.trim()}" err="${err.trim()}"`);
      if (err.trim()) return Response.json({ error: err.trim() }, { status: 500 });
      return Response.json({ ok: true });
    }

    const hideMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/hide$/);
    if (hideMatch && req.method === "POST") {
      hiddenSids.set(hideMatch[1], {});
      await saveHiddenSids();
      return Response.json({ ok: true, total: hiddenSids.size });
    }
    const closeMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/close$/);
    if (closeMatch && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { mode?: string };
      const mode = body.mode === "delete" ? "delete" : "hide";
      const sid = closeMatch[1];
      if (sid === mainSessionSid) {
        return Response.json({ error: "Главную сессию дашборда нельзя закрыть" }, { status: 403 });
      }
      const meta = sessionMeta.get(sid);
      const pid = meta?.pid;
      const tty = meta?.tty;
      const jsonlPath = meta?.jsonlPath;
      // 1. Сначала убить claude pid — иначе Terminal покажет диалог «закрыть вкладку с запущенным процессом?» и tab останется
      if (pid && pid > 0) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        await new Promise(r => setTimeout(r, 300));
        // Если не отвалился — SIGKILL
        try { process.kill(pid, 0); /* check alive */ try { process.kill(pid, "SIGKILL"); } catch {} } catch {}
      }
      // 2. Закрыть Terminal-вкладку: сначала отправляем exit для shell, потом close (без диалога «процесс запущен»)
      if (tty) {
        const script = `tell application "Terminal"
  repeat with w in windows
    try
      repeat with t in tabs of w
        try
          if (tty of t) is "/dev/${tty}" then
            do script "exit" in t
            delay 0.4
            close t saving no
            return "ok"
          end if
        end try
      end repeat
    end try
  end repeat
end tell`;
        Bun.spawnSync(["osascript", "-e", script]);
      }
      const info = { cwd: meta?.cwd, title: meta?.title };
      if (mode === "delete") {
        if (jsonlPath) { try { await unlink(jsonlPath); } catch {} }
        hiddenSids.set(sid, info);
      } else {
        hiddenSids.set(sid, info);
      }
      await saveHiddenSids();
      return Response.json({ ok: true, mode });
    }
    const unhideMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/unhide$/);
    if (unhideMatch && req.method === "POST") {
      const sid = unhideMatch[1];
      const body = await req.json().catch(() => ({})) as { restore?: boolean };
      const info = hiddenSids.get(sid);
      hiddenSids.delete(sid);
      await saveHiddenSids();
      // Если попросили restore — поднять терминальную сессию через claude --resume
      if (body.restore && info?.cwd) {
        const r = await restoreSession(sid, info.cwd);
        if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 500 });
      }
      return Response.json({ ok: true, total: hiddenSids.size });
    }
    if (url.pathname === "/api/hidden-sessions") {
      return Response.json([...hiddenSids].map(([sid, info]) => ({ sid, ...info })));
    }
    if (url.pathname === "/api/check-existing" && req.method === "GET") {
      const cwdRaw = (url.searchParams.get("cwd") || "").trim();
      if (!cwdRaw) return Response.json({ exists: false });
      const cwd = cwdRaw.startsWith("~") ? cwdRaw.replace(/^~/, homedir()) : cwdRaw;
      try {
        const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
        const projectDir = join(PROJECTS_DIR, encoded);
        const files = await readdir(projectDir).catch(() => [] as string[]);
        const livePidSids = new Set((await gatherPidInfos()).map(p => p.sessionId).filter(Boolean));
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        let best: { sid: string; mtime: number; hasLivePid: boolean } | null = null;
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const sid = f.replace(/\.jsonl$/, "");
          try {
            const filePath = join(projectDir, f);
            const st = await stat(filePath);
            if (st.mtimeMs < cutoff) continue;
            const head = await readHead(filePath, 16 * 1024);
            const lines = head.split("\n").filter(l => l.trim().startsWith("{"));
            let hasRealUserMsg = false;
            for (const line of lines) {
              try {
                const r = JSON.parse(line);
                if (r.type !== "user") continue;
                const c = r.message?.content;
                const text = typeof c === "string" ? c : (Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("") : "");
                if (text.trim() && !text.startsWith("<command-") && !text.startsWith("<system-reminder")) { hasRealUserMsg = true; break; }
              } catch {}
            }
            if (!hasRealUserMsg) continue;
            const hasLivePid = livePidSids.has(sid);
            if (!best || st.mtimeMs > best.mtime) best = { sid, mtime: st.mtimeMs, hasLivePid };
          } catch {}
        }
        if (!best) return Response.json({ exists: false });
        // Достанем title (если есть)
        let title: string | null = null;
        try {
          const jsonlPath = join(projectDir, best.sid + ".jsonl");
          title = await getTitleCached(best.sid, jsonlPath);
        } catch {}
        return Response.json({ exists: true, sid: best.sid, title, hasLivePid: best.hasLivePid });
      } catch { return Response.json({ exists: false }); }
    }
    if (url.pathname === "/api/session/new" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { name?: string; cwd?: string; remoteControl?: boolean };
      const name = String(body.name ?? "").trim();
      const cwdRaw = String(body.cwd ?? "").trim() || "~";
      let rc = !!body.remoteControl;
      if (!name) return Response.json({ error: "Название обязательно" }, { status: 400 });
      if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) return Response.json({ error: "Название содержит недопустимые символы" }, { status: 400 });
      const cwd = cwdRaw.startsWith("~") ? cwdRaw.replace(/^~/, homedir()) : cwdRaw;
      // Ищем существующий jsonl в этой папке БЕЗ живого Terminal-pid — берём для resume.
      // Так подхватываем desktop-сессии (или прошлые терминальные, которые закрыли).
      let resumeSid: string | null = null;
      try {
        const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
        const projectDir = join(PROJECTS_DIR, encoded);
        const files = await readdir(projectDir).catch(() => [] as string[]);
        const livePidSids = new Set((await gatherPidInfos()).map(p => p.sessionId).filter(Boolean));
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;  // не старее 30 дней
        let best: { sid: string; mtime: number } | null = null;
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const sid = f.replace(/\.jsonl$/, "");
          if (livePidSids.has(sid)) continue;
          try {
            const filePath = join(projectDir, f);
            const st = await stat(filePath);
            if (st.mtimeMs < cutoff) continue;
            // Проверка содержимого: пропускаем jsonl без реальных user-сообщений
            const head = await readHead(filePath, 16 * 1024);
            const lines = head.split("\n").filter(l => l.trim().startsWith("{"));
            let hasRealUserMsg = false;
            for (const line of lines) {
              try {
                const r = JSON.parse(line);
                if (r.type !== "user") continue;
                const c = r.message?.content;
                const text = typeof c === "string" ? c : (Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("") : "");
                if (text.trim() && !text.startsWith("<command-") && !text.startsWith("<system-reminder")) {
                  hasRealUserMsg = true;
                  break;
                }
              } catch {}
            }
            if (!hasRealUserMsg) continue;
            if (!best || st.mtimeMs > best.mtime) best = { sid, mtime: st.mtimeMs };
          } catch {}
        }
        if (best) resumeSid = best.sid;
      } catch {}
      // Если resume — автоматически включаем /remote-control, чтобы terminal + Claude.app + dashboard
      // могли работать в тандеме на одной сессии (как ты просил).
      if (resumeSid) rc = true;
      // Защита: если для resumeSid уже есть живой терминальный pid — отказ (нельзя дублировать)
      if (resumeSid) {
        const livePids = await gatherPidInfos();
        if (livePids.some(p => p.sessionId === resumeSid)) {
          return Response.json({ error: "Эта сессия уже открыта в Terminal — нельзя дублировать. Открой её карточку в дашборде." }, { status: 409 });
        }
      }
      console.log(`[new-session] cwd=${cwd} resume=${resumeSid || "(new)"} rc=${rc}`);
      // AppleScript: открыть Terminal, запустить claude (или claude --resume), /rename, /remote-control, скрыть.
      const nameEsc = name.replace(/"/g, '\\"');
      const cwdEsc = cwd.replace(/"/g, '\\"');
      const claudeCmd = resumeSid ? `claude --resume ${resumeSid}` : "claude";
      const rcBlock = rc
        ? `do script "/remote-control" in newTab\n  delay 0.2\n  do script "" in newTab\n  delay 4`
        : "";
      const script = `tell application "System Events"
  set prevApp to name of first process whose frontmost is true
end tell
-- Без activate — Terminal не вылезает в фронт. do script откроет новое окно/вкладку, но мы сразу его спрячем.
tell application "Terminal"
  set newTab to do script "cd \\"${cwdEsc}\\" && ${claudeCmd}"
  delay 8
  ${resumeSid ? "" : `do script "/rename ${nameEsc}" in newTab
  delay 0.2
  do script "" in newTab
  delay 3`}
  ${rcBlock}
  delay 0.5
end tell
-- Спрятать Terminal (Cmd+H) и вернуть фронт тому приложению, в котором пользователь был (браузер).
tell application "System Events"
  try
    set visible of process "Terminal" to false
  end try
end tell
return "ok"`;
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      console.log(`[new-session] name="${name}" rc=${rc} out="${out.trim()}" err="${err.trim()}"`);
      if (err.trim() && proc.exitCode !== 0) return Response.json({ error: err.trim() }, { status: 500 });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/restore" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { sessionId?: string; cwd?: string };
      const sid = String(body.sessionId ?? "").trim();
      const cwd = String(body.cwd ?? "").trim();
      if (!sid || !cwd) return Response.json({ error: "missing sessionId or cwd" }, { status: 400 });
      if (!/^[0-9a-f-]+$/i.test(sid)) return Response.json({ error: "bad sessionId" }, { status: 400 });
      const r = await restoreSession(sid, cwd);
      if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const file = formData.get("audio");
        if (!(file instanceof File)) {
          return Response.json({ error: "no audio" }, { status: 400 });
        }
        const tag = randomBytes(4).toString("hex");
        const ext = file.name.includes(".") ? file.name.split(".").pop()!.slice(0, 5) : "webm";
        const audioPath = join(UPLOAD_DIR, `voice-${tag}.${ext}`);
        await Bun.write(audioPath, file);
        const audioStat = await stat(audioPath);
        console.log(`[/transcribe] received ${audioPath} (${audioStat.size} bytes, type=${file.type})`);

        // Convert webm/opus → wav 16kHz mono PCM via ffmpeg (whisper handles raw audio more reliably)
        const wavPath = join(UPLOAD_DIR, `voice-${tag}.wav`);
        const ffmpegProc = Bun.spawn(
          ["ffmpeg", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
          { stdout: "pipe", stderr: "pipe" }
        );
        const ffmpegErr = await new Response(ffmpegProc.stderr).text();
        await ffmpegProc.exited;
        let wavStat;
        try { wavStat = await stat(wavPath); } catch {
          console.log(`[/transcribe] ffmpeg failed:\n${ffmpegErr.slice(-800)}`);
          return Response.json({ error: "ffmpeg не сконвертировал", stderr: ffmpegErr.slice(-500) }, { status: 500 });
        }
        console.log(`[/transcribe] wav ${wavStat.size} bytes`);

        const outDir = join(UPLOAD_DIR, `whisper-${tag}`);
        await mkdir(outDir, { recursive: true });
        const modelPath = join(homedir(), ".cc-dashboard", "whisper-models", "ggml-base.bin");
        const outPrefix = join(outDir, "out");
        const t0 = Date.now();
        const proc = Bun.spawn(
          ["whisper-cli", "-m", modelPath, "-l", "ru", "-otxt", "-nt", "-of", outPrefix, wavPath],
          { stdout: "pipe", stderr: "pipe" }
        );
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        const txtPath = `${outPrefix}.txt`;
        let text = "";
        try { text = (await Bun.file(txtPath).text()).trim(); } catch {}
        const dur = Date.now() - t0;
        if (!text) {
          console.log(`[/transcribe FAIL ${dur}ms] size=${audioStat.size} type=${file.type}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
          // Keep audioPath for debugging
          return Response.json({
            error: "whisper не выдал текст",
            audio_size: audioStat.size,
            audio_type: file.type,
            kept_at: audioPath,
            stderr: stderr.slice(0, 1500),
          }, { status: 500 });
        }
        console.log(`[/transcribe OK ${dur}ms size=${audioStat.size}] "${text.slice(0,80)}"`);
        try { await unlink(audioPath); } catch {}
        try { await unlink(wavPath); } catch {}
        try {
          for (const f of await readdir(outDir)) await unlink(join(outDir, f));
        } catch {}
        return Response.json({ text });
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // Serve files uploaded to UPLOAD_DIR (for clickable @-references in chat).
    // Only filenames — no path traversal. Files are in /tmp/cc-dashboard/ with random-tag names.
    const fileMatch = url.pathname.match(/^\/api\/file\/(.+)$/);
    if (fileMatch) {
      const name = decodeURIComponent(fileMatch[1]);
      if (name.includes("/") || name.includes("..") || name.startsWith(".")) {
        return new Response("forbidden", { status: 403 });
      }
      const filePath = join(UPLOAD_DIR, name);
      try {
        const file = Bun.file(filePath);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const headers: Record<string, string> = { "content-disposition": `inline; filename="${name.replace(/"/g, "")}"` };
        if (file.type) headers["content-type"] = file.type;
        return new Response(file, { headers });
      } catch { return new Response("not found", { status: 404 }); }
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return Response.json({ error: "no file" }, { status: 400 });
        }
        const safeName = (file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
        const tag = randomBytes(4).toString("hex");
        const path = join(UPLOAD_DIR, `${tag}-${safeName}`);
        await Bun.write(path, file);
        console.log(`[/upload] ${path} (${file.size} bytes)`);
        return Response.json({ path, name: file.name, size: file.size });
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // DEBUG: показать сырой TUI-content + результат парсинга для одной tty
    const debugTuiMatch = url.pathname.match(/^\/api\/debug\/tui\/([^/]+)$/);
    if (debugTuiMatch) {
      const tty = debugTuiMatch[1];
      tuiContentsCache = { at: 0, byTty: new Map() };  // bust cache
      // Запустим AppleScript заново и покажем сырой stdout+stderr
      const debugScript = `set sepStart to "|||TTYSTART|||"
set sepEnd to "|||TTYEND|||"
set acc to ""
set winCount to 0
set errLog to ""
tell application "Terminal"
  set winCount to (count of windows)
  repeat with w in windows
    try
      set tabCount to count of tabs of w
      set errLog to errLog & "win-tabs=" & tabCount & ";"
      repeat with t in tabs of w
        try
          set ttyStr to tty of t
          set cont to ""
          try
            set cont to (contents of t) as text
          on error eMsg
            set errLog to errLog & "contents-err:" & eMsg & ";"
          end try
          set acc to acc & sepStart & ttyStr & "|||CONTENT|||" & cont & sepEnd
        on error eMsg
          set errLog to errLog & "tab-err:" & eMsg & ";"
        end try
      end repeat
    on error eMsg
      set errLog to errLog & "win-err:" & eMsg & ";"
    end try
  end repeat
end tell
return acc & "|||DEBUG|||winCount=" & winCount & " errs=" & errLog`;
      const proc = Bun.spawn(["osascript", "-e", debugScript], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const all = await readAllTerminalContents();
      const text = all.get(tty) ?? "";
      const parsed = parseTuiModal(text);
      return Response.json({
        tty,
        rawStdoutLen: out.length,
        rawStdoutHead: out.slice(0, 500),
        rawStdoutTail: out.slice(-500),
        rawStderr: err,
        contentLen: text.length,
        allTtys: [...all.keys()],
        contentTail: text.slice(-3000),
        parsed,
      });
    }

    const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (messagesMatch) {
      const sid = messagesMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta) return Response.json({ error: "session not found" }, { status: 404 });
      const msgs = meta.jsonlPath ? await readMessages(meta.jsonlPath) : [];
      // Если в Terminal-вкладке висит живой AskUserQuestion-модал, которого ещё нет в jsonl,
      // дописываем его в конец фида как фейковую question-запись — чтобы фронт мог отрендерить.
      const liveQ = await getTuiQuestion(meta.tty);
      if (liveQ) {
        // Найдём последний question-msg в фиде
        let lastQIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if ((msgs[i] as any).role === "question") { lastQIdx = i; break; }
        }
        const lastQ = lastQIdx >= 0 ? (msgs[lastQIdx] as any) : null;
        const sameLogical = lastQ && !lastQ.question?.answered && (
          lastQ.question?.question === liveQ.question ||
          lastQ.question?.question?.includes(liveQ.question) ||
          liveQ.question?.includes(lastQ.question?.question || "")
        );
        if (sameLogical) {
          // Заменяем jsonl-версию на TUI — там полные опции (включая «Свой вариант») и реальные описания.
          // Но toolUseId оставляем из jsonl (он стабилен), чтобы DOM data-tool-use-id не дёргался между поллами.
          const stableId = lastQ.question?.toolUseId || liveQ.toolUseId;
          msgs[lastQIdx] = { role: "question" as const, text: liveQ.question, ts: lastQ.ts, question: { ...liveQ, toolUseId: stableId } };
        } else {
          msgs.push({ role: "question" as const, text: liveQ.question, ts: new Date().toISOString(), question: liveQ });
        }
      }
      return new Response(JSON.stringify(msgs), {
        headers: { "content-type": "application/json", "cache-control": "no-store, no-cache, must-revalidate" },
      });
    }

    const focusMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/focus$/);
    if (focusMatch && req.method === "POST") {
      const sid = focusMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta) return Response.json({ error: "session not found" }, { status: 404 });
      if (!meta.tty) return Response.json({ terminal: "none", error: "no tty (desktop session?)" });
      const { result, stderr } = await controlTerminal(meta.tty, "focus");
      return Response.json({ terminal: result, stderr });
    }

    const wakeMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/wake$/);
    if (wakeMatch && req.method === "POST") {
      const sid = wakeMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      if (!meta.jsonlPath) return Response.json({ error: "no jsonl" }, { status: 400 });
      // Найти последнее user-сообщение в jsonl и переслать его — это retry, который реально дёрнет API.
      let lastUserText = "";
      try {
        const tail = await readTail(meta.jsonlPath, 256 * 1024);
        const lines = tail.split("\n").filter(l => l.trim().startsWith("{"));
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const r = JSON.parse(lines[i]);
            if (r.type !== "user") continue;
            const c = r.message?.content;
            const t = typeof c === "string" ? c : (Array.isArray(c) ? c.filter((x: any) => x?.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("\n") : "");
            if (t && !t.startsWith("<command-") && !t.startsWith("<system-reminder")) { lastUserText = t; break; }
          } catch {}
        }
      } catch {}
      if (!lastUserText) {
        // Fallback: пустой Enter
        const { result } = await controlTerminal(meta.tty, "send", "");
        return Response.json({ ok: true, terminal: result, fallback: "empty-enter" });
      }
      console.log(`[/wake sid=${sid}] resend last user text="${lastUserText.slice(0, 80)}"`);
      const { result } = await controlTerminal(meta.tty, "send", lastUserText);
      return Response.json({ ok: true, terminal: result, resent: lastUserText.slice(0, 120) });
    }
    // Multi-tab: отправить произвольный текст в указанный tty (для Type something / Свой вариант)
    const typeTextMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/type-text$/);
    if (typeTextMatch && req.method === "POST") {
      const sid = typeTextMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      const body = await req.json().catch(() => ({})) as { text?: string };
      if (typeof body.text !== "string" || !body.text) return Response.json({ error: "text required" }, { status: 400 });
      const res = await sendTextToTui(meta.tty, body.text);
      if (res.ok) return Response.json({ ok: true });
      return Response.json({ error: res.error }, { status: 500 });
    }
    // Live mirror TUI содержимого — последние ~50 строк для multi-tab UI
    const mirrorMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/tui-mirror$/);
    if (mirrorMatch) {
      const sid = mirrorMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      const all = await readAllTerminalContents();
      const text = all.get(meta.tty) ?? "";
      const lines = text.split("\n");
      const tail = lines.slice(-50).join("\n");
      return Response.json({ tty: meta.tty, content: tail });
    }
    // Multi-tab: отправить одну raw-клавишу (стрелки, Enter, Esc) в указанный tty
    const rawKeyMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/send-raw-key$/);
    if (rawKeyMatch && req.method === "POST") {
      const sid = rawKeyMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      const body = await req.json().catch(() => ({})) as { key?: string };
      if (!body.key || typeof body.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
      const res = await sendRawKey(meta.tty, body.key as any);
      if (res.ok) return Response.json({ ok: true });
      return Response.json({ error: res.error }, { status: 500 });
    }

    const answerMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/answer-question$/);
    if (answerMatch && req.method === "POST") {
      const sid = answerMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta?.tty) return Response.json({ error: "no tty" }, { status: 400 });
      const body = await req.json().catch(() => ({})) as { optionIndex?: number; freeText?: string };
      const idx = Number(body.optionIndex);
      if (!Number.isInteger(idx) || idx < 1 || idx > 20) return Response.json({ error: "invalid optionIndex" }, { status: 400 });
      const freeText = typeof body.freeText === "string" ? body.freeText : undefined;
      const res = await answerTuiQuestion(meta.tty, idx, freeText);
      if (res.ok) return Response.json({ ok: true });
      return Response.json({ error: res.error }, { status: 500 });
    }

    const sendMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/send$/);
    if (sendMatch && req.method === "POST") {
      const sid = sendMatch[1];
      const selfId = await getSelfSessionId();
      if (selfId && sid === selfId) {
        return Response.json({ error: "Это твоя собственная сессия — нельзя слать в неё через дашборд (зацикливание с /remote-control)" }, { status: 400 });
      }
      const meta = sessionMeta.get(sid);
      if (!meta) return Response.json({ error: "session not found" }, { status: 404 });
      if (!meta.tty) return Response.json({ terminal: "none", error: "no tty — отправка возможна только для терминальных сессий" }, { status: 400 });
      const body = await req.json().catch(() => ({})) as { text?: string };
      const text = (body.text ?? "").toString();
      if (!text.trim()) return Response.json({ error: "empty text" }, { status: 400 });
      console.log(`[/send sid=${sid} tty=${meta.tty}] text="${text.slice(0, 80)}"`);
      // Если шлём /rename — сбрасываем кэш заголовка чтобы новое имя подхватилось быстро
      if (text.trim().toLowerCase().startsWith("/rename ")) {
        titleCache.delete(sid);
      }
      const { result, stderr } = await controlTerminal(meta.tty, "send", text);
      if (result === "none") {
        return Response.json({ terminal: "none", error: `tty ${meta.tty} не найден в Terminal/iTerm — окно закрыто?` }, { status: 500 });
      }
      if (stderr) {
        return Response.json({ terminal: result, error: stderr }, { status: 500 });
      }
      return Response.json({ terminal: result, pasteHint: true });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Dashboard: http://localhost:${PORT}`);
