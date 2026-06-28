#!/usr/bin/env bun
// setup-local.ts — bootstrap локального дашборда на новой машине.
// Usage: bun run setup-local.ts
//
// Что делает:
//   1. bun install в текущей папке (deps)
//   2. Создаёт ~/.cc-dashboard/ и копирует туда server.ts + node_modules + icons
//   3. Генерирует VAPID-ключи (если их ещё нет)
//   4. Пишет LaunchAgent plist ~/Library/LaunchAgents/com.user.cc-dashboard.plist
//   5. Загружает LaunchAgent
// Чего НЕ делает (отдельно):
//   - setup-auth.ts → создание логина/пароля (требует TTY для пароля)
//   - VPS + Caddy + autossh туннель → см. RUNBOOK.md часть A+Б
//   - PWA-установка на iPhone

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, cpSync } from "node:fs";

const SRC = import.meta.dir;
const HOME = homedir();
const RUNTIME = join(HOME, ".cc-dashboard");

const log = (m: string) => console.log(`[setup-local] ${m}`);
const ok  = (m: string) => console.log(`[setup-local] ✓ ${m}`);
const die = (m: string): never => { console.error(`[setup-local] ✗ ${m}`); process.exit(1); };

// === Safe rm: перенаправляет rm в системный trash ===
// Страховка от случайного `rm -rf ~/.claude` и подобных аварий — файлы уходят
// в Корзину Finder через /usr/bin/trash, можно восстановить. Идемпотентно
// (повторные запуски не плодят дубли). Bypass для реального unlink:
// `command rm`, `\rm`, или `/bin/rm`. См. RUNBOOK.md «Safe rm».
async function installSafeRm() {
  const MARKER = "# === Safe rm (cc-dashboard) ===";
  const BLOCK = `
${MARKER}
# rm-wrapper: вместо unlink — отправка в Корзину через /usr/bin/trash.
# Bypass: \\rm, /bin/rm, или \`command rm\`. Файлы с дефисом — после '--'.
# Установлено cc-dashboard setup-local.ts. Чтобы отключить — удали этот блок.
rm() {
    local args=()
    local in_args=0
    for arg in "$@"; do
        if [ "$in_args" = 1 ]; then args+=("$arg"); continue; fi
        if [ "$arg" = "--" ]; then in_args=1; continue; fi
        if [[ "$arg" == -* ]]; then continue; fi
        args+=("$arg")
    done
    if [ \${#args[@]} -eq 0 ]; then echo "rm-safe: nothing to remove" >&2; return 1; fi
    /usr/bin/trash "\${args[@]}"
}
`;

  try {
    if (!(await Bun.file("/usr/bin/trash").exists())) {
      log("Safe rm: /usr/bin/trash отсутствует (macOS <14?) — пропускаю");
      return;
    }
  } catch {
    log("Safe rm: /usr/bin/trash недоступен — пропускаю");
    return;
  }

  const profiles = [join(HOME, ".bash_profile"), join(HOME, ".zshrc")];
  for (const path of profiles) {
    let content = "";
    try { content = await Bun.file(path).text(); } catch {}
    if (content.includes(MARKER)) {
      log(`Safe rm уже установлен в ${path.replace(HOME, "~")}`);
      continue;
    }
    await Bun.write(path, content + BLOCK);
    ok(`Safe rm установлен в ${path.replace(HOME, "~")}`);
  }
}

// 0. Sanity
if (process.platform !== "darwin") die("Только macOS (LaunchAgent специфичен для macOS).");
// Bun.which() может вернуть ephemeral путь типа /private/tmp/bun-node-XXX/bun
// (если setup запущен через npx/bunx), который очищается при ребуте macOS — после первой
// перезагрузки plist становится битым и launchd падает с Input/output error.
// Поэтому если найденный bun в /tmp, пытаемся подобрать постоянный путь.
function resolveStableBunPath(): string {
  const found = Bun.which("bun");
  const isEphemeral = (p: string | null) => !!p && (p.startsWith("/private/tmp/") || p.startsWith("/tmp/"));
  if (found && !isEphemeral(found)) return found;
  const candidates = [
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    join(HOME, ".bun/bin/bun"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  die("bun не найден в постоянной директории. Установи через brew install bun или curl -fsSL https://bun.sh/install | bash");
}
const bunPath = resolveStableBunPath();
log(`bun: ${bunPath}`);

// 1. Deps
if (!existsSync(join(SRC, "node_modules", "web-push"))) {
  log("Устанавливаю зависимости (bun install)...");
  const p = Bun.spawn(["bun", "install"], { cwd: SRC, stdout: "inherit", stderr: "inherit" });
  await p.exited;
  if (p.exitCode !== 0) die("bun install упал");
}
ok("dependencies");

// 2. Runtime dir
mkdirSync(RUNTIME, { recursive: true });
mkdirSync(join(RUNTIME, "icons"), { recursive: true });

// Copy code + deps + release info + watchdog скрипты
for (const f of ["server.ts", "package.json", "bun.lock", "setup-auth.ts", "RELEASE.json", "server-watchdog.sh", "tunnel-watchdog.sh"]) {
  const src = join(SRC, f);
  if (existsSync(src)) cpSync(src, join(RUNTIME, f));
}
cpSync(join(SRC, "node_modules"), join(RUNTIME, "node_modules"), { recursive: true });
// Запомним путь к git-репо — сервер использует его для git pull при авто-обновлении.
await Bun.write(join(RUNTIME, "repo-path.txt"), SRC);
ok(`copied to ${RUNTIME}`);

// Icons (если есть в репо)
const iconsSrc = join(SRC, "icons");
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, join(RUNTIME, "icons"), { recursive: true });
  ok("icons");
} else {
  log("(icons/ в репо не найдены — иконки PWA будут отсутствовать. Опционально: сгенерируй через rsvg-convert из icon.svg)");
}

// 3. VAPID keys
const vapidPath = join(RUNTIME, "vapid.json");
if (!existsSync(vapidPath)) {
  log("Генерирую VAPID-ключи для push-уведомлений...");
  const webpush = (await import("web-push")).default;
  const keys = webpush.generateVAPIDKeys();
  await Bun.write(vapidPath, JSON.stringify({
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "https://example.com",  // !!! заменить на свой HTTPS домен после настройки VPS
  }, null, 2));
  ok(`VAPID → ${vapidPath}`);
  log("  ⚠  ПЕРЕД использованием push: замени subject в vapid.json на свой HTTPS-URL (Apple Push требует валидного домена).");
} else {
  ok("VAPID уже есть");
}

// 4. Whisper.cpp model (опционально, для голосового ввода)
const whisperModel = join(RUNTIME, "whisper-models", "ggml-base.bin");
if (!existsSync(whisperModel)) {
  log("(голосовой ввод): для whisper нужна модель ggml-base.bin. Установи отдельно:");
  log("  brew install whisper-cpp");
  log("  mkdir -p ~/.cc-dashboard/whisper-models");
  log("  curl -L -o ~/.cc-dashboard/whisper-models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin");
}

// 4.5. Claude Code: auto-permission mode. Без этого Claude Code на каждой bash-команде
// показывает «Do you want to proceed?» — для пользователя дашборда это сильно мешает.
// Создаём ТОЛЬКО если settings.json ещё нет (не трогаем существующие настройки).
const claudeSettingsPath = join(HOME, ".claude", "settings.json");
if (!existsSync(claudeSettingsPath)) {
  log("Создаю ~/.claude/settings.json в auto-permission mode (без вопросов на каждую команду)…");
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  await Bun.write(claudeSettingsPath, JSON.stringify({
    permissions: { defaultMode: "auto" },
    skipAutoPermissionPrompt: true,
  }, null, 2));
  ok("~/.claude/settings.json создан (auto mode)");
} else {
  log("(~/.claude/settings.json уже есть — не трогаю)");
}

// 5. LaunchAgent
const plistPath = join(HOME, "Library", "LaunchAgents", "com.user.cc-dashboard.plist");
const serverPath = join(RUNTIME, "server.ts");
const outLog = join(RUNTIME, "out.log");
const errLog = join(RUNTIME, "err.log");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.cc-dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>${RUNTIME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${outLog}</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
</dict>
</plist>
`;

const isInstalled = existsSync(plistPath);
await Bun.write(plistPath, plist);
if (isInstalled) {
  Bun.spawnSync(["launchctl", "unload", plistPath]);
}
const ld = Bun.spawnSync(["launchctl", "load", plistPath]);
if (ld.exitCode === 0) ok(`LaunchAgent: ${plistPath}`);
else die(`launchctl load упал: ${ld.stderr?.toString()}`);

// 5b. Watchdog'и (server + tunnel) — автоматически реанимируют упавший сервер/туннель.
// server-watchdog ставится всегда. tunnel-watchdog требует tunnel-config.json
// (см. README.md «Tunnel watchdog») — без конфига он молча неактивен.
async function installAgent(name: string, templateFile: string, subs: Record<string, string>) {
  const tplPath = join(SRC, templateFile);
  if (!existsSync(tplPath)) { log(`(${templateFile} нет в репо — пропускаю ${name})`); return; }
  let xml = await Bun.file(tplPath).text();
  for (const [k, v] of Object.entries(subs)) {
    xml = xml.split(`{{${k}}}`).join(v);
  }
  const agentPath = join(HOME, "Library", "LaunchAgents", `${name}.plist`);
  const wasInstalled = existsSync(agentPath);
  await Bun.write(agentPath, xml);
  if (wasInstalled) Bun.spawnSync(["launchctl", "unload", agentPath]);
  const r = Bun.spawnSync(["launchctl", "load", agentPath]);
  if (r.exitCode === 0) ok(`LaunchAgent: ${agentPath}`);
  else log(`  launchctl load ${name}: ${r.stderr?.toString()?.slice(0, 200)}`);
}

await installAgent("com.user.cc-server-watchdog", "com.user.cc-server-watchdog.plist.template", {
  RUNTIME,
});

// tunnel-watchdog требует ~/.cc-dashboard/tunnel-config.json
// Формат:
//   { "publicUrl": "https://<твой-домен>:8443/api/health",
//     "vpsHost":   "root@<ip>",      // или user@host для kris-tunnel
//     "tunnelPort": "18787",         // порт, который reverse-forward'ит autossh
//     "sshKey":    "$HOME/.ssh/id_ed25519",
//     "tunnelAgent": "$HOME/Library/LaunchAgents/com.user.cc-tunnel.plist" }
const tunnelConfigPath = join(RUNTIME, "tunnel-config.json");
if (existsSync(tunnelConfigPath)) {
  try {
    const cfg = await Bun.file(tunnelConfigPath).json();
    const expand = (s: string) => s.replace(/^\$HOME/, HOME).replace(/^~/, HOME);
    await installAgent("com.user.cc-watchdog", "com.user.cc-watchdog.plist.template", {
      RUNTIME,
      HOME,
      PUBLIC_URL: cfg.publicUrl ?? "",
      VPS_HOST: cfg.vpsHost ?? "",
      TUNNEL_PORT: String(cfg.tunnelPort ?? ""),
      SSH_KEY: expand(cfg.sshKey ?? join(HOME, ".ssh/id_ed25519")),
      TUNNEL_AGENT: expand(cfg.tunnelAgent ?? join(HOME, "Library/LaunchAgents/com.user.cc-tunnel.plist")),
    });
  } catch (e) {
    log(`  tunnel-config.json есть, но parse упал: ${e}`);
  }
} else {
  log("(tunnel-watchdog: ~/.cc-dashboard/tunnel-config.json не найден — watchdog туннеля неактивен. См. README «Tunnel watchdog».)");
}

// 6. Создать главную сессию «CC Dash» если её ещё нет
const mainSessionPath = join(RUNTIME, "main-session.json");
if (!existsSync(mainSessionPath)) {
  log("Создаю главную сессию «CC Dash» в Terminal…");
  const cwdEsc = SRC.replace(/"/g, '\\"');
  const script = `tell application "System Events"
  set prevApp to name of first process whose frontmost is true
end tell
tell application "Terminal"
  activate
  set newTab to do script "cd \\"${cwdEsc}\\" && claude"
  delay 8
  do script "/rename CC Dash" in newTab
  delay 0.2
  do script "" in newTab
  delay 2
end tell
tell application "System Events"
  try
    set visible of process "Terminal" to false
  end try
end tell
try
  tell application prevApp to activate
end try
return "ok"`;
  const proc = Bun.spawnSync(["osascript", "-e", script]);
  if (proc.exitCode === 0) {
    ok("главная сессия запущена, через 5-10 сек подхватится дашбордом");
    log("  Чтобы пометить её как главную: после появления в дашборде запиши её sid в ~/.cc-dashboard/main-session.json");
    log("  Можно сделать через UI (TODO) или вручную:");
    log("    1. Открой http://localhost:8787/api/sessions");
    log("    2. Найди объект с title=\"CC Dash\", скопируй sessionId");
    log("    3. echo '{\"sid\":\"<тот-sid>\",\"name\":\"CC Dash\"}' > ~/.cc-dashboard/main-session.json");
  } else {
    log(`  AppleScript упал (${proc.stderr?.toString()?.slice(0, 200)}). Создай главную сессию вручную через UI.`);
  }
}

// 7. Smoke test
await new Promise(r => setTimeout(r, 1000));
try {
  const res = await fetch("http://localhost:8787/api/health");
  if (res.ok) ok("сервер отвечает на localhost:8787");
  else if (res.status === 503) {
    log("  Server up, но auth.json ещё нет. Запусти отдельно:");
    log("    bun run ~/.cc-dashboard/setup-auth.ts");
    log("  и потом:");
    log(`    launchctl unload ${plistPath} && launchctl load ${plistPath}`);
  } else log(`  health = ${res.status}`);
} catch {
  log("(сервер ещё не стартовал, проверь через секунду: curl localhost:8787/api/health)");
}

// 8. Full Disk Access для bun — обязательный шаг, иначе launchd-запущенный bun
//    не сможет читать ~/.claude/projects/ и дашборд покажет 0 сессий.
//    Программно дать FDA нельзя (политика macOS), но открываем нужную панель System Settings
//    и инструктируем пользователя добавить bun.
console.log();
console.log("════════════════════════════════════════════════════════════");
console.log("⚠  ВАЖНО: дай bun полный доступ к диску (Full Disk Access)");
console.log("════════════════════════════════════════════════════════════");
console.log();
console.log("Без этого launchd-bun не увидит сессии Claude Code, и дашборд");
console.log("будет показывать 0 чатов даже когда они активны в Terminal.");
console.log();
console.log("Сейчас откроется панель Системных настроек. Что сделать:");
console.log(`  1. Нажми «+» в списке`);
console.log(`  2. В диалоге Finder: Shift+Cmd+G → введи путь к bun (см. ниже)`);
console.log(`     bun: ${bunPath}`);
console.log(`  3. Выбери файл bun и нажми «Открыть»`);
console.log(`  4. Включи слайдер напротив bun`);
console.log(`  5. Вернись в этот терминал и нажми Enter, чтобы продолжить`);
console.log();
// Открываем панель Privacy & Security → Full Disk Access напрямую через URL scheme
Bun.spawnSync(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
process.stdout.write("Жму Enter после того как добавил bun в Full Disk Access... ");
// читаем одну строку из stdin для ожидания подтверждения
await new Promise<void>(resolve => {
  process.stdin.once("data", () => resolve());
  process.stdin.resume();
});
process.stdin.pause();
// После FDA нужно перезапустить launchd-bun, чтобы новые TCC права применились
Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.user.cc-dashboard`]);
ok("LaunchAgent перезапущен — новый bun теперь с FDA");

// Safe rm: ставим обёртку для rm в bash/zsh, перенаправляющую в Корзину.
// Открой новый Terminal-таб (или source ~/.bash_profile / source ~/.zshrc),
// чтобы изменения подхватились — старые табы продолжат работать со стандартным rm.
await installSafeRm();

console.log();
console.log("====================================");
console.log("✓ Локальная установка завершена.");
console.log("====================================");
console.log();
console.log("Дальше:");
console.log("  1. Создай учётку: bun run ~/.cc-dashboard/setup-auth.ts");
console.log("  2. Открой http://localhost:8787 и залогинься");
console.log("  3. (опционально) Удалённый доступ с iPhone — см. RUNBOOK.md часть A+Б");
