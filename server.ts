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

function encodeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9.]/g, "-");
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
    status = ageSec > 600 ? "idle" : "thinking";
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

  return { status, lastActivity: ts, sessionId, recordCwd };
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

async function snapshot(): Promise<Session[]> {
  const [freshJsonls, pidInfos, tabTitles, selfId] = await Promise.all([
    findAllFreshJsonls(),
    gatherPidInfos(),
    getTabTitles(),
    getSelfSessionId(),
  ]);
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

  return sessions;
}

interface Message {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: string;
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
  // Adaptive: если в окне нет user/assistant сообщений (jsonl мог забиться api_error/system),
  // расширяем окно — до 16МБ или размера файла.
  const file = Bun.file(jsonlPath);
  const totalSize = file.size;
  let win = limitBytes;
  let messages: Message[] = [];
  while (messages.length < 5 && win <= 16 * 1024 * 1024 && win <= totalSize * 2) {
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
            } else if (item?.type === "tool_use") {
              messages.push({ role: "tool", text: compactToolUse(item), ts });
            }
          }
        }
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
        repeat with w in windows
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
  tell application "Terminal"
    activate
    do script cmd
  end tell
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
const CACHE = "cc-dashboard-v1";
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/"])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
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
  body { font: 14px/1.4 -apple-system, "SF Pro Text", system-ui, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 16px; min-height: 100vh; display: flex; flex-direction: column; }
  /* Chrome fullscreen on macOS slides a toolbar over the top ~60px when cursor hits the top edge.
     Detection via JS: body.chrome-fs is set when window covers the whole screen.
     В фуллскрине прижимаем body к 100vh с overflow:hidden, чтобы выезжающий тулбар Chrome
     не показывал «дырку» под собой и не было лишнего скроллбара. Скролл живёт внутри .feed. */
  body.chrome-fs { padding-top: 64px; height: 100vh; max-height: 100vh; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  h1 { font-family: 'UnifrakturCook', 'Pirata One', serif; font-size: clamp(26px, 4.5vw, 42px); font-weight: 700; margin: 0; flex: 1; min-width: 0; color: #f0f6fc; text-align: center; letter-spacing: 0.04em; line-height: 1.05; text-shadow: 0 0 14px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.5); position: relative; }
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
  .conn-banner { background: #b3260f; color: #fff; padding: 10px 16px; font-size: 13px; text-align: center; line-height: 1.35; border-bottom: 1px solid #d73a49; }
  .conn-banner b { display: block; font-size: 14px; margin-bottom: 2px; }
  .conn-banner .conn-detail { opacity: 0.85; font-size: 12px; }
  .conn-banner.warn { background: #8d5a00; border-bottom-color: #d4a500; }
  .refresh-btn.spinning svg { animation: spin 0.6s linear infinite; }
  /* Drawer (sessions list) — slides in from left on all platforms */
  #drawer { position: fixed; top: 0; left: 0; bottom: 0; width: min(85vw, 360px); background: #0d1117; border-right: 1px solid #30363d; transform: translateX(-100%); transition: transform 0.22s ease; z-index: 100; display: flex; flex-direction: column; padding-top: env(safe-area-inset-top, 0); padding-bottom: env(safe-area-inset-bottom, 0); }
  #drawer.open { transform: translateX(0); }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #30363d; }
  .drawer-title { font-size: 14px; font-weight: 500; color: #e6edf3; }
  .drawer-close { background: transparent; border: 0; color: #8b949e; font-size: 24px; cursor: pointer; line-height: 1; padding: 4px 10px; }
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
  .resume-btn:hover { background: #388bfd; }
  .resume-btn:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }

  /* Panels (multi-session workspace) */
  #panels { display: flex; gap: 12px; overflow-x: auto; flex: 1; min-height: 0; padding-bottom: 12px; }
  #panels:empty::before { content: ''; }
  .welcome { display: none; flex: 1; flex-direction: column; padding: 32px 24px; overflow-y: auto; }
  .welcome.show { display: flex; }
  .welcome-inner { width: 100%; max-width: 1200px; margin: 0 auto; }
  .welcome-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(240px, 25vw, 320px), 1fr)); gap: 14px; }
  .welcome-grid .card { padding: 16px; }
  .welcome-empty { color: #6e7681; text-align: center; padding: 60px 20px; font-size: 16px; }
  .panel { background: #0d1117; border: 1px solid #30363d; border-radius: 10px; min-width: 460px; flex: 1 1 0; display: flex; flex-direction: column; max-height: calc(100vh - 60px); }
  .panel-header { padding: 12px 16px; display: flex; align-items: center; gap: 8px; }
  .panel-header .title-block { flex: 1; min-width: 0; cursor: pointer; user-select: none; }
  .panel-header .title-main { font-size: 14px; font-weight: 500; color: #e6edf3; margin-bottom: 2px; word-break: break-word; }
  .panel-header .cwd-line { font-size: 11px; color: #8b949e; word-break: break-all; }
  .panel-header button { background: #21262d; border: 0; color: #c9d1d9; padding: 0; border-radius: 50%; width: 36px; height: 36px; min-width: 36px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .panel-header button:hover { background: #30363d; color: white; }
  .panel-header button svg { width: 16px; height: 16px; display: block; }
  .panel-header .interrupt-btn { width: auto; min-width: auto; padding: 0 14px; font-size: 13px; font-weight: 500; color: white; background: #d73a49; border-radius: 18px; height: 36px; letter-spacing: 0.02em; }
  .panel-header .interrupt-btn:hover { background: #cb2431; }
  .panel-header .close-btn:hover { background: #d73a49; color: white; }
  .warn { background: #321c1c; color: #f0c674; padding: 8px 14px; font-size: 12px; border-bottom: 1px solid #30363d; }
  .warn.self { background: #1f1633; color: #a371f7; }
  .feed { flex: 1; overflow-y: auto; padding: 14px 16px; }
  .feed > * { max-width: 900px; margin-left: auto; margin-right: auto; }
  .msg { margin-bottom: 12px; }
  .msg .who { font-size: 11px; color: #6e7681; margin-bottom: 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  .msg.user .who { color: #58a6ff; }
  .msg.assistant .who { color: #c9d1d9; }
  .msg.tool .who { color: #8b949e; }
  .msg .body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
  .msg.tool .body { color: #8b949e; font-size: 12px; }
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
  .mic-btn.recording { background: #d73a49; animation: pulse 1s ease-in-out infinite; }
  .mic-btn.transcribing { background: #1f6feb; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }
  @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  .mic-btn.transcribing svg { animation: spin 1s linear infinite; }
  .composer textarea { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 22px; padding: 10px 16px; font: 13px/1.4 -apple-system, sans-serif; resize: none; height: 40px; min-height: 40px; max-height: 50vh; overflow-y: auto; box-sizing: border-box; }
  .composer textarea:focus { outline: none; border-color: #58a6ff; }
  .composer .send-btn { background: #238636; border: 0; color: white; padding: 0; border-radius: 50%; cursor: pointer; width: 40px; height: 40px; min-width: 40px; display: inline-flex; align-items: center; justify-content: center; }
  .composer .send-btn:hover { background: #2ea043; }
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
    body { min-height: 100dvh; }
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
</style>
</head>
<body>
<div id="conn-banner" class="conn-banner" style="display:none"></div>
<div class="topbar">
  <button id="menu-btn" class="menu-btn" title="Сессии">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <h1>CC Dashboard<span class="blood" aria-hidden="true">CC Dashboard</span></h1>
  <button id="push-btn" class="menu-btn" title="Включить пуш-уведомления" style="display:none">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
  </button>
</div>
<div class="meta" id="meta">подключение…</div>
<div id="drawer">
  <div class="drawer-head">
    <div class="drawer-title">Сессии</div>
    <button id="drawer-close" class="drawer-close">×</button>
  </div>
  <div class="grid" id="grid"></div>
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
    const badge = s.tty ? '<span class="badge">'+s.tty+'</span>' : (isDead ? '<span class="badge">закрыто</span>' : (s.isDesktop ? '<span class="badge">desktop</span>' : ''));
    const pidLabel = s.pid > 0 ? 'pid ' + s.pid : '';
    const head = s.title
      ? \`<div class="title">\${escapeHtml(s.title)}</div>\${badge ? \`<div class="cwd">\${badge}</div>\` : ''}\`
      : \`<div class="cwd big">\${escapeHtml(s.cwdLabel)}\${badge}</div>\`;
    const classes = [s.status, s.isSelf ? 'self' : '', panels.has(s.sessionId) ? 'open' : '', isDead ? 'dead' : ''].filter(Boolean).join(' ');
    const resumeBtn = isDead ? \`<button class="resume-btn" data-sid="\${s.sessionId}" data-cwd="\${escapeHtml(s.cwd)}">▶ Resume</button>\` : '';
    return \`
      <div class="card \${classes}" data-sid="\${s.sessionId}">
        \${head}
        <div class="row">
          <span class="status \${s.status}">\${STATUS_LABELS[s.status] ?? s.status}</span>
          <span>\${s.lastActivityRel === '—' ? '' : s.lastActivityRel + ' назад'}\${pidLabel ? ' · ' + pidLabel : ''}</span>
        </div>
        \${resumeBtn}
      </div>
    \`;
  }).join("");
}

function wireCards(container) {
  for (const el of container.querySelectorAll(".card")) {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("resume-btn")) return;
      onCardClick(el.dataset.sid);
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
  sessions.sort((a, b) => {
    if (a.tty && !b.tty) return -1;
    if (!a.tty && b.tty) return 1;
    if (a.tty && b.tty) return a.tty.localeCompare(b.tty);
    return a.sessionId.localeCompare(b.sessionId);
  });
  const grid = document.getElementById("grid");
  const welcomeGrid = document.getElementById("welcome-grid");
  const welcomeEmpty = document.getElementById("welcome-empty");
  if (sessions.length === 0) {
    grid.innerHTML = '<div class="empty">Нет запущенных claude-процессов</div>';
    welcomeGrid.innerHTML = '';
    welcomeEmpty.style.display = 'block';
  } else {
    const html = buildCardsHTML(sessions);
    grid.innerHTML = html;
    welcomeGrid.innerHTML = html;
    welcomeEmpty.style.display = 'none';
    wireCards(grid);
    wireCards(welcomeGrid);
  }
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

document.getElementById("menu-btn").addEventListener("click", openDrawer);
document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

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
  } else {
    warnEl.style.display = "none";
  }
  const blocked = s.isDesktop || s.isSelf;
  p.el.querySelector("textarea").disabled = blocked;
  p.el.querySelector(".send-btn").disabled = blocked;
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
    const html = msgs.map(m => \`
      <div class="msg \${m.role}">
        <div class="who">\${m.role}</div>
        <div class="body">\${renderMd(m.text)}</div>
      </div>
    \`).join("");
    if (p.lastFeedHtml === html) return;
    p.lastFeedHtml = html;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    feed.innerHTML = html;
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
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
      <button class="refresh-btn" title="Обновить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
      <button class="interrupt-btn" title="Прервать текущий процесс claude (Esc)">Stop</button>
      <button class="close-btn" title="Закрыть панель">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
      </button>
    </div>
    <div class="warn" style="display:none"></div>
    <div class="feed"><div class="msg"><div class="who">…</div><div class="body">загружаю</div></div></div>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </button>
        <button class="send-btn" style="display:none" title="Отправить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  \`;
  document.getElementById("panels").appendChild(el);

  // Click-to-copy for code blocks, inline code, and link-copy buttons
  el.querySelector(".feed").addEventListener("click", async (e) => {
    const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
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
    micBtnEl.style.display = hasText ? "none" : "";
    sendBtnEl.style.display = hasText ? "" : "none";
  };
  el.querySelector("textarea").addEventListener("input", updateSendMic);

  el.querySelector(".close-btn").addEventListener("click", () => closePanel(sid));
  el.querySelector(".focus-btn").addEventListener("click", () => focusWindow(sid));
  el.querySelector(".title-block").addEventListener("click", () => {
    const s = findSession(sid);
    if (!s || !s.title) return;  // only toggle when title is shown
    const cwdEl = el.querySelector(".cwd-line");
    cwdEl.style.display = cwdEl.style.display === "none" ? "" : "none";
  });
  el.querySelector(".refresh-btn").addEventListener("click", (ev) => {
    ev.currentTarget.classList.add("spinning");
    location.reload();
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
  panels.set(sid, { el, pollInterval: interval, attachments });
  updateWelcome();
  updatePanelHeader(sid);
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

function closePanel(sid) {
  const p = panels.get(sid);
  if (!p) return;
  clearInterval(p.pollInterval);
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
      hintEl.textContent = "✓ Отправлено" + (atts.length ? " (" + atts.length + " файл(ов))" : "") + ".";
      hintEl.style.display = "";
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
const connBanner = document.getElementById("conn-banner");
let lastConnError = null;
function showConn(level, title, detail) {
  if (lastConnError === title) return;
  lastConnError = title;
  connBanner.className = "conn-banner" + (level === "warn" ? " warn" : "");
  connBanner.innerHTML = "<b>" + title + "</b><span class='conn-detail'>" + detail + "</span>";
  connBanner.style.display = "block";
}
function hideConn() {
  if (lastConnError === null) return;
  lastConnError = null;
  connBanner.style.display = "none";
}
async function checkHealth() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (res.ok) { hideConn(); return; }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      showConn("err", "Mac недоступен", "Туннель до твоего Mac не отвечает. Возможно интернет на Mac упал или дашборд-сервер не запущен (status " + res.status + ").");
    } else if (res.status >= 500) {
      showConn("err", "Серверная ошибка дашборда", "Status " + res.status + ". Возможно сервер на Mac перезапускается.");
    } else {
      hideConn();
    }
  } catch (e) {
    showConn("err", "Нет связи", "Не удаётся достучаться до eadashboard.duckdns.org. Проверь интернет/VPN на устройстве.");
  }
}
setInterval(checkHealth, 10000);
checkHealth();
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
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushBtn.style.display = "none";
    return;
  }
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) { pushBtn.style.display = "none"; return; }
  const sub = await reg.pushManager.getSubscription();
  const granted = Notification.permission === "granted" && !!sub;
  pushBtn.style.display = "";
  pushBtn.style.opacity = granted ? "0.5" : "1";
  pushBtn.title = granted ? "Уведомления включены (клик — выключить)" : "Включить пуш-уведомления";
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
      // 410 Gone = subscription expired/revoked
      if (e?.statusCode === 410 || e?.statusCode === 404) dead.push(i);
      else console.error("[push] send failed:", e?.statusCode, e?.body?.slice?.(0, 200));
    }
  }));
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !dead.includes(i));
    await savePushSubs();
  }
}

// Periodic poller: detect transition into "waiting" status, send push.
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
    }
  } catch (e) { console.error("[push poller]", e); }
}, 3000);

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
      const script = `tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            try
              if (tty of t) is "/dev/${meta.tty}" then
                set selected of t to true
                set frontmost of w to true
                activate
                delay 0.15
                tell application "System Events" to key code 53
                return "ok"
              end if
            end try
          end repeat
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

    const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (messagesMatch) {
      const sid = messagesMatch[1];
      const meta = sessionMeta.get(sid);
      if (!meta) return Response.json({ error: "session not found" }, { status: 404 });
      if (!meta.jsonlPath) return Response.json([]);
      const msgs = await readMessages(meta.jsonlPath);
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
