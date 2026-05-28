# DEPLOY.md — Playbook для Claude Code

Это инструкция для **тебя, Claude**. Пользователь открыл папку cc-dashboard и попросил развернуть.
Проведи его через шаги ниже. Спрашивай интерактивно, выполняй команды, проверяй результат.

**Принципы:**
- Один шаг за сообщение, жди от пользователя «готово» прежде чем двигаться дальше
- Все runtime-файлы кладутся в `~/.cc-dashboard/` (macOS launchd не читает `~/Documents/` из-за TCC)
- Не делай destructive операций без подтверждения
- Если что-то отличается от ожидаемого — спроси, не угадывай

---

## Шаг 0. Prereqs check

Проверь окружение, прежде чем что-то ставить:

```bash
which bun                  # Bun обязателен
sw_vers -productVersion    # macOS 13+ рекомендуется (для PWA на iPhone — iOS 16.4+)
ls ~/.cc-dashboard/auth.json 2>/dev/null  # уже устанавливали?
```

Если **bun** не найден — скажи пользователю:
> Bun не установлен. Запусти в обычном Терминале: `brew install bun` (или `curl -fsSL https://bun.sh/install | bash`). После установки скажи «готово».

Если `auth.json` уже есть — это переустановка. Спроси: переустановить с нуля или обновить только код?

---

## Шаг 1. Локальный сервер

Запусти `setup-local.ts`:

```bash
bun run /путь/к/cc-dashboard/setup-local.ts
```

Скрипт:
- Установит зависимости (bun install)
- Скопирует server.ts + node_modules + иконки в `~/.cc-dashboard/`
- Сгенерирует VAPID-ключи для push (`~/.cc-dashboard/vapid.json`)
- Создаст LaunchAgent plist
- Загрузит его (`launchctl load`)

После завершения сервер должен слушать на `localhost:8787`. Проверь:

```bash
curl -s http://localhost:8787/api/health
# ожидаем {"ok":true,"ts":...}
```

Если 503 — `auth.json` ещё не создан, переходи к шагу 2 и потом перезагрузи LaunchAgent.

---

## Шаг 2. Аутентификация

Пользователь должен задать логин/пароль. Запросов в чате избегай — пароль в логах не нужен:

> В отдельном Терминале выполни:
> ```
> bun run ~/.cc-dashboard/setup-auth.ts
> ```
> Скрипт спросит логин и пароль (пароль скрытый). После «✓ Записано» скажи мне «готово».

Когда ответил «готово»:
```bash
launchctl unload ~/Library/LaunchAgents/com.user.cc-dashboard.plist
launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist
curl -s http://localhost:8787/api/health  # должно быть 200
```

Открой `http://localhost:8787` в браузере → форма логина → войди со своими кредами.

**Готово для локальной работы на этом Mac.** Если нужен только локальный доступ — можно стопиться здесь.

---

## Шаг 3. Удалённый доступ с iPhone (опционально)

Спроси пользователя:

> Хочешь открывать дашборд с iPhone через интернет? Если да — есть два варианта:
>
> **A) Tailscale** — бесплатно, проще. Работает если у тебя на iPhone НЕТ другого VPN (Tailscale тоже VPN, iOS позволяет только один).
>
> **B) Свой VPS + Caddy + reverse SSH** — сложнее, но работает параллельно с любым VPN на iPhone.
>
> Какой вариант?

### Вариант A: Tailscale

1. `brew install tailscale` → `sudo tailscale up`
2. На iPhone: App Store → Tailscale → войди в тот же аккаунт
3. Запроси HTTPS-сертификат для magic-DNS имени Mac:
   ```bash
   sudo tailscale cert <macbook-name>.tail-XXXXX.ts.net
   ```
4. Прокинь Caddy локально (или Tailscale Funnel) — детали зависят от версии. Если усложняется — переключайся на вариант B.

### Вариант B: VPS + Caddy + autossh

**Нужно от пользователя:**
- IP/hostname его VPS, ssh-доступ (root или sudo) → SSH-ключ Mac уже добавлен в `authorized_keys` на VPS
- Домен, который указывает на этот VPS (DuckDNS подойдёт — бесплатно, `https://www.duckdns.org`)

Шаги:

1. **Caddy на VPS** (Ubuntu/Debian):
   ```bash
   ssh root@<VPS_IP> 'apt update && apt install -y caddy'
   ```
   Caddyfile (на VPS, `/etc/caddy/Caddyfile`):
   ```
   <твой-домен>:8443 {
       reverse_proxy localhost:18787
   }
   ```
   Если порт 443 свободен — лучше используй 443 (стандарт). Если занят (другим сервисом VPN например) — порт 8443 ок, но придётся указывать его в URL.
   ```bash
   ssh root@<VPS_IP> 'systemctl reload caddy'
   ```

2. **autossh туннель Mac → VPS** (на Mac, через LaunchAgent):

   Создай `~/Library/LaunchAgents/com.user.cc-tunnel.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.user.cc-tunnel</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/autossh</string>
       <string>-M</string><string>0</string>
       <string>-N</string>
       <string>-o</string><string>ServerAliveInterval=30</string>
       <string>-o</string><string>ServerAliveCountMax=3</string>
       <string>-o</string><string>ExitOnForwardFailure=yes</string>
       <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
       <string>-i</string><string>/Users/<USER>/.ssh/id_ed25519</string>
       <string>-R</string><string>18787:localhost:8787</string>
       <string>root@<VPS_IP></string>
     </array>
     <key>EnvironmentVariables</key>
     <dict><key>AUTOSSH_GATETIME</key><string>0</string></dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/Users/<USER>/.cc-dashboard/tunnel.log</string>
     <key>StandardErrorPath</key><string>/Users/<USER>/.cc-dashboard/tunnel.err.log</string>
   </dict>
   </plist>
   ```
   ```bash
   brew install autossh
   launchctl load ~/Library/LaunchAgents/com.user.cc-tunnel.plist
   ```

3. **Проверка**: с iPhone (или из другой сети) открой `https://<твой-домен>:8443` — должна появиться форма логина.

4. **Обнови VAPID-subject** на тот же URL (Apple Push требует валидного HTTPS):
   ```bash
   bun -e '
   const f = require("os").homedir() + "/.cc-dashboard/vapid.json";
   const c = await Bun.file(f).json();
   c.subject = "https://<твой-домен>";
   await Bun.write(f, JSON.stringify(c, null, 2));
   '
   launchctl unload ~/Library/LaunchAgents/com.user.cc-dashboard.plist
   launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist
   ```

---

## Шаг 4. PWA на iPhone

1. Открой URL в Safari на iPhone (если нужен VPN на iPhone — сначала подключи его)
2. Войди логин/пароль → Safari предложит сохранить — соглашайся (потом будет Face ID для автозаполнения)
3. Кнопка «Поделиться» (квадрат со стрелкой вверх) → пролистни → «На экран Домой» → Добавить
4. Открой иконку CC Dashboard с домашнего экрана
5. Жми колокольчик в шапке → разреши уведомления → готово

---

## Шаг 5. Финальная проверка

- Открой пару `claude` сессий в Terminal на Mac
- Зайди на дашборд (с Mac или iPhone)
- Должны отобразиться все сессии. Клик по карточке → панель. Отправь тестовое сообщение.
- Push-уведомление: запусти долгую задачу в claude, переключись в другое приложение — когда claude завершит и попросит ответ, придёт уведомление.

## Troubleshooting

- **`curl localhost:8787` пустой / 503** → auth.json не создан, см. шаг 2
- **С iPhone «нет связи»** → проверь Caddy (`systemctl status caddy`), autossh туннель (`launchctl list | grep cc-tunnel`), что VPN на iPhone включён если нужен
- **Push не приходит** → VAPID subject должен быть HTTPS URL твоего домена, не `.local` и не mailto. Apple возвращает `403 BadJwtToken` если subject невалиден.
- **Сессии не появляются в дашборде** → проверь что `claude` реально запущен и в `~/.claude/sessions/<pid>.json` есть metadata
- **Логи**: `~/.cc-dashboard/out.log`, `~/.cc-dashboard/err.log`, `~/.cc-dashboard/tunnel.log`
