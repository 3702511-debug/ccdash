#!/usr/bin/env bun
// Setup helper for cc-dashboard auth.
// Usage: bun run ~/.cc-dashboard/setup-auth.ts
// Запрашивает логин/пароль (или пары login:password из аргументов), хеширует через argon2id,
// генерирует HMAC-секрет, пишет ~/.cc-dashboard/auth.json.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".cc-dashboard", "auth.json");

type AuthUser = { login: string; hash: string; allowedSessionTitles?: string[] };
type AuthConfig = { users: AuthUser[]; secret: string };

// CLI флаги для неинтерактивного использования:
//   --add                       при существующем auth.json добавить юзера (по умолчанию интерактивный prompt)
//   --reset                     при существующем auth.json сбросить всех (опасно)
//   --login <login>             логин (без флага — интерактивный prompt)
//   --password <password>       пароль (без флага — скрытый prompt)
//   --restrict "title1,title2"  whitelist по custom-title; пусто/нет — admin
//
// Если все --login/--password переданы — скрипт работает полностью без TTY.
function getFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? "";
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function parseRestrictArg(): string[] | null {
  const v = getFlag("--restrict");
  if (v === null) return null;
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

async function prompt(label: string, hidden = false): Promise<string> {
  process.stdout.write(label);
  if (hidden) {
    // Disable echo
    const { stdin } = process;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    return new Promise((resolve) => {
      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        for (const ch of s) {
          const code = ch.charCodeAt(0);
          if (code === 0x0d || code === 0x0a) {
            stdin.removeListener("data", onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            process.stdout.write("\n");
            resolve(buf);
            return;
          }
          if (code === 0x03) {
            process.stdout.write("\n");
            process.exit(130);
          }
          if (code === 0x7f || code === 0x08) {
            buf = buf.slice(0, -1);
          } else {
            buf += ch;
          }
        }
      };
      stdin.on("data", onData);
    });
  } else {
    for await (const line of console) return line.trim();
    return "";
  }
}

let existing: AuthConfig | null = null;
try { existing = await Bun.file(AUTH_FILE).json(); } catch {}

if (existing) {
  console.log(`Существующий auth.json найден. Текущие пользователи: ${existing.users.map(u => u.login).join(", ")}`);
  let action: string;
  if (hasFlag("--add")) action = "a";
  else if (hasFlag("--reset")) action = "r";
  else action = await prompt("Что делаем? (a)dd / (r)eset / (c)ancel: ");
  if (action === "c" || action === "") { console.log("Отмена."); process.exit(0); }
  if (action === "r") {
    existing = { users: [], secret: randomBytes(32).toString("hex") };
  }
} else {
  existing = { users: [], secret: randomBytes(32).toString("hex") };
}

const loginFlag = getFlag("--login");
const passwordFlag = getFlag("--password");
const login = loginFlag !== null ? loginFlag : await prompt("Логин: ");
if (!login) { console.error("Логин пустой — отмена."); process.exit(1); }
const password = passwordFlag !== null ? passwordFlag : await prompt("Пароль: ", true);
if (password.length < 6) { console.error("Пароль слишком короткий (минимум 6 символов)."); process.exit(1); }
if (passwordFlag === null) {
  const confirm = await prompt("Повторите пароль: ", true);
  if (confirm !== password) { console.error("Пароли не совпадают."); process.exit(1); }
}

const hash = await Bun.password.hash(password, { algorithm: "argon2id" });

// Whitelist: --restrict из CLI или интерактивный prompt. Пусто = admin (видит всё).
let restrictTitles: string[] | null = parseRestrictArg();
if (restrictTitles === null) {
  const restrictRaw = await prompt("Ограничить пользователя сессиями (custom-title через запятую, пусто = admin): ");
  if (restrictRaw) {
    restrictTitles = restrictRaw.split(",").map(s => s.trim()).filter(Boolean);
  }
}

const idx = existing.users.findIndex(u => u.login === login);
const newUser: AuthUser = { login, hash };
if (restrictTitles && restrictTitles.length > 0) {
  newUser.allowedSessionTitles = restrictTitles;
}
if (idx >= 0) {
  console.log(`Обновляю пользователя ${login}`);
  existing.users[idx] = { ...newUser, hash };
} else {
  existing.users.push(newUser);
}

await Bun.write(AUTH_FILE, JSON.stringify(existing, null, 2));
console.log(`\n✓ Записано: ${AUTH_FILE}`);
console.log(`  Пользователей: ${existing.users.length}`);
console.log(`\nДальше: launchctl unload && launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist`);
