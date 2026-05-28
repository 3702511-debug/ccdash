#!/usr/bin/env bun
// Setup helper for cc-dashboard auth.
// Usage: bun run ~/.cc-dashboard/setup-auth.ts
// Запрашивает логин/пароль (или пары login:password из аргументов), хеширует через argon2id,
// генерирует HMAC-секрет, пишет ~/.cc-dashboard/auth.json.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".cc-dashboard", "auth.json");

type AuthConfig = { users: { login: string; hash: string }[]; secret: string };

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
  const action = await prompt("Что делаем? (a)dd / (r)eset / (c)ancel: ");
  if (action === "c" || action === "") { console.log("Отмена."); process.exit(0); }
  if (action === "r") {
    existing = { users: [], secret: randomBytes(32).toString("hex") };
  }
} else {
  existing = { users: [], secret: randomBytes(32).toString("hex") };
}

const login = await prompt("Логин: ");
if (!login) { console.error("Логин пустой — отмена."); process.exit(1); }
const password = await prompt("Пароль: ", true);
if (password.length < 6) { console.error("Пароль слишком короткий (минимум 6 символов)."); process.exit(1); }
const confirm = await prompt("Повторите пароль: ", true);
if (confirm !== password) { console.error("Пароли не совпадают."); process.exit(1); }

const hash = await Bun.password.hash(password, { algorithm: "argon2id" });

const idx = existing.users.findIndex(u => u.login === login);
if (idx >= 0) {
  console.log(`Обновляю пароль для ${login}`);
  existing.users[idx].hash = hash;
} else {
  existing.users.push({ login, hash });
}

await Bun.write(AUTH_FILE, JSON.stringify(existing, null, 2));
console.log(`\n✓ Записано: ${AUTH_FILE}`);
console.log(`  Пользователей: ${existing.users.length}`);
console.log(`\nДальше: launchctl unload && launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist`);
