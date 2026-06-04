# RUNBOOK — установка CC Dashboard на свою инфру

> **Это инструкция для Claude Code.** Пользователь склонировал репо и хочет развернуть CC Dashboard на своём Mac с публичным доступом через свою VPS и свой домен.
>
> **Принципы работы:**
> - Один шаг за сообщение, жди от пользователя «готово» прежде чем двигаться дальше
> - Не делай destructive команды (`rm -rf`, `launchctl unload` чужих агентов и т.п.) без подтверждения
> - Если результат отличается от ожидаемого — остановись, опиши что увидел, спроси
> - Все runtime-файлы — в `~/.cc-dashboard/` (macOS launchd не читает `~/Documents/` из-за TCC)

---

## Параметры (заполни вместе с пользователем перед стартом)

| параметр | пример | как получить |
|---|---|---|
| `<LOGIN>` | `me@example.com` | придумывает пользователь |
| `<PUBLIC_DOMAIN>` | `dash.example.com` или `mydash.duckdns.org` | свой домен или бесплатный DuckDNS |
| `<VPS_IP>` | `203.0.113.42` | IP арендованной VPS |
| `<VPS_ROOT_USER>` | `root` или `ubuntu` | владелец-юзер на VPS для первоначальной настройки |
| `<TUNNEL_USER>` | `dash-tunnel` | отдельный SSH-юзер на VPS только для reverse-туннеля |
| `<LOCAL_PORT>` | `8787` | локальный порт дашборда (обычно 8787, можно не менять) |
| `<VPS_PORT>` | `18787` | порт на VPS для reverse forward (обычно 18787, любой свободный >1024) |

**Перед запуском:**
1. DNS `<PUBLIC_DOMAIN>` должен указывать (A-запись) на `<VPS_IP>`. Проверь: `dig +short <PUBLIC_DOMAIN>` → `<VPS_IP>`
2. У пользователя должен быть SSH-доступ к VPS под `<VPS_ROOT_USER>` (для шага A — настройка VPS-side)

---

## Часть A. VPS-side настройка (на сервере)

Делается один раз. Если у пользователя уже настроены Caddy и SSH-юзер для туннеля — пропусти.

### A1. Установка Caddy

```bash
ssh <VPS_ROOT_USER>@<VPS_IP>
apt update && apt install -y caddy autossh   # Ubuntu/Debian
# или: dnf install -y caddy autossh           # Rocky/Alma
```

### A2. Caddy блок для дашборда

Добавь в `/etc/caddy/Caddyfile`:

```caddyfile
<PUBLIC_DOMAIN> {
    reverse_proxy 127.0.0.1:<VPS_PORT>
    encode gzip
}
```

Если порт 443 занят другим сервисом — можешь использовать `<PUBLIC_DOMAIN>:8443 { ... }`, тогда URL будет с портом.

Проверь синтаксис и перезагрузи:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

SSL выдастся автоматически по http-01 как только Mac пробросит туннель.

### A3. Отдельный SSH-юзер для туннеля

Создай юзера БЕЗ shell — только для port forwarding. Это защитит VPS даже если приватный ключ пользователя скомпрометируют.

```bash
useradd -m -s /usr/sbin/nologin <TUNNEL_USER>
mkdir -p /home/<TUNNEL_USER>/.ssh
chmod 700 /home/<TUNNEL_USER>/.ssh
touch /home/<TUNNEL_USER>/.ssh/authorized_keys
chmod 600 /home/<TUNNEL_USER>/.ssh/authorized_keys
chown -R <TUNNEL_USER>:<TUNNEL_USER> /home/<TUNNEL_USER>/.ssh
```

Ограничь юзера в sshd. Создай `/etc/ssh/sshd_config.d/tunnel-users.conf`:

```
Match User <TUNNEL_USER>
    AllowTcpForwarding remote
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitOpen 127.0.0.1:<VPS_PORT>
    ForceCommand /bin/false
```

```bash
sshd -t   # проверить синтаксис
systemctl reload ssh   # или: systemctl reload sshd
```

Скажи пользователю: «VPS-side настроен. Жду публичный SSH-ключ с Mac — это будет на шаге Б4». Жди когда дойдём до Б4 и пользователь пришлёт `.pub`.

### A4. Когда пользователь пришлёт публичный ключ (на шаге Б4):

```bash
ssh <VPS_ROOT_USER>@<VPS_IP> "echo 'ssh-ed25519 AAAA... key-comment' >> /home/<TUNNEL_USER>/.ssh/authorized_keys"
```

Подтверди: «Ключ добавлен на VPS, можно поднимать туннель».

---

## Часть Б. Mac-side установка

### Б0. Проверка окружения

```bash
which bun
which autossh
which git
sw_vers -productVersion
ls ~/.cc-dashboard/auth.json 2>/dev/null && echo "ALREADY INSTALLED" || echo "fresh install"
```

Что должно быть:
- **bun** — обязателен; если нет: `brew install bun`
- **autossh** — обязателен; если нет: `brew install autossh`
- **git** — обычно есть; если нет: `xcode-select --install`
- **macOS 13+** для PWA на iPhone (iOS 16.4+)

Если `ALREADY INSTALLED` — спроси: переустановить или обновить только код?

### Б1. Локальная установка

Из директории, куда склонирован репо:

```bash
bun run setup-local.ts
```

Скрипт делает:
1. `bun install` (deps)
2. Копирует `server.ts`, `node_modules`, `icons/` в `~/.cc-dashboard/`
3. Генерирует VAPID-ключи (`~/.cc-dashboard/vapid.json`) — subject пока `https://example.com`, поменяем в Б6
4. Записывает путь к репо (`~/.cc-dashboard/repo-path.txt`) — нужен для self-update
5. Создаёт и загружает LaunchAgent `~/Library/LaunchAgents/com.user.cc-dashboard.plist`

Проверка:

```bash
sleep 3
curl -s http://localhost:<LOCAL_PORT>/api/health
```

Ожидаем: 503 (нет auth.json) или 200. Если ни то ни другое — глянь `~/.cc-dashboard/err.log`.

### Б2. Создание учётки

```bash
bun run ~/.cc-dashboard/setup-auth.ts
```

Пользователь вводит логин (`<LOGIN>`) и пароль. **Пароль в чате не пиши.**

После «✓ Записано»:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.cc-dashboard.plist
launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist
sleep 2
curl -s http://localhost:<LOCAL_PORT>/api/health
```

Должно вернуть `{"ok":true,...}`. Скажи: «Локальный дашборд работает. Открой http://localhost:<LOCAL_PORT> в Safari и проверь логин» — жди подтверждения.

### Б3. Если нужен только локальный доступ — стоп

Если пользователь хочет дашборд только на этом Mac (без iPhone/удалённого доступа) — установка закончена. Дальше шаги Б4-Б8 нужны только для публичного доступа через VPS.

### Б4. SSH-ключ для туннеля

Отдельный ключ только для reverse-туннеля:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/cc-tunnel -C "<TUNNEL_USER>@$(hostname)"
cat ~/.ssh/cc-tunnel.pub
```

**Покажи пользователю публичный ключ.** Если ты же помогаешь и с VPS-side в этой же сессии — просто выполни команду из A4 сейчас. Если пользователь сам владелец VPS — попроси добавить ключ в `authorized_keys` юзера `<TUNNEL_USER>`.

**Жди подтверждения «ключ добавлен»** прежде чем поднимать туннель.

### Б5. autossh LaunchAgent (туннель)

```bash
USER_NAME=$(whoami)
AUTOSSH_PATH=$(which autossh)

cat > ~/Library/LaunchAgents/com.user.cc-tunnel.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.cc-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${AUTOSSH_PATH}</string>
    <string>-M</string><string>0</string>
    <string>-N</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-i</string><string>/Users/${USER_NAME}/.ssh/cc-tunnel</string>
    <string>-R</string><string><VPS_PORT>:localhost:<LOCAL_PORT></string>
    <string><TUNNEL_USER>@<VPS_IP></string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>AUTOSSH_GATETIME</key><string>0</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/${USER_NAME}/.cc-dashboard/tunnel.log</string>
  <key>StandardErrorPath</key><string>/Users/${USER_NAME}/.cc-dashboard/tunnel.err.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.user.cc-tunnel.plist
sleep 4
launchctl list | grep cc-tunnel
```

Подожди минуту и проверь:

```bash
sleep 30
curl -sk --max-time 10 https://<PUBLIC_DOMAIN>/api/health
```

Ожидаем: `{"ok":true,...}`.

Если 502 / timeout — `~/.cc-dashboard/tunnel.err.log` подскажет (Permission denied = ключ не прописан; forwarding failed = порт занят на VPS).

### Б6. VAPID subject → реальный домен

Apple Push требует валидный HTTPS subject:

```bash
bun -e '
const f = require("os").homedir() + "/.cc-dashboard/vapid.json";
const c = await Bun.file(f).json();
c.subject = "https://<PUBLIC_DOMAIN>";
await Bun.write(f, JSON.stringify(c, null, 2));
'
launchctl unload ~/Library/LaunchAgents/com.user.cc-dashboard.plist
launchctl load ~/Library/LaunchAgents/com.user.cc-dashboard.plist
```

### Б7. Watchdog туннеля

Если туннель зависнет — watchdog поднимет его через 3 минуты.

```bash
USER_NAME=$(whoami)
cat > ~/.cc-dashboard/tunnel-watchdog.sh <<'EOF'
#!/bin/bash
URL="https://<PUBLIC_DOMAIN>/api/health"
STATE_FILE="$HOME/.cc-dashboard/watchdog-fails.count"
LOG="$HOME/.cc-dashboard/watchdog.log"
TUNNEL_AGENT="$HOME/Library/LaunchAgents/com.user.cc-tunnel.plist"
FAIL_THRESHOLD=3
ts() { date '+%Y-%m-%d %H:%M:%S'; }
http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL" 2>/dev/null)
if [ "$http_code" = "200" ]; then
  if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" != "0" ]; then
    echo "[$(ts)] recovered" >> "$LOG"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi
fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"
echo "[$(ts)] fail #$fails (http $http_code)" >> "$LOG"
if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then exit 0; fi
echo "[$(ts)] threshold reached, reloading tunnel..." >> "$LOG"
launchctl unload "$TUNNEL_AGENT" 2>> "$LOG"
sleep 2
pkill -f "autossh" 2>> "$LOG"
sleep 1
launchctl load "$TUNNEL_AGENT" 2>> "$LOG"
echo 0 > "$STATE_FILE"
EOF

# подставь свой <PUBLIC_DOMAIN> в скрипт:
sed -i '' "s|<PUBLIC_DOMAIN>|твой-домен.example.com|g" ~/.cc-dashboard/tunnel-watchdog.sh
chmod +x ~/.cc-dashboard/tunnel-watchdog.sh

cat > ~/Library/LaunchAgents/com.user.cc-watchdog.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.cc-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/${USER_NAME}/.cc-dashboard/tunnel-watchdog.sh</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>/Users/${USER_NAME}/.cc-dashboard/watchdog.out.log</string>
  <key>StandardErrorPath</key><string>/Users/${USER_NAME}/.cc-dashboard/watchdog.err.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.user.cc-watchdog.plist
```

### Б8. PWA на iPhone

Скажи пользователю:

> 1. Открой `https://<PUBLIC_DOMAIN>` в **Safari** на iPhone
> 2. Залогинься — Safari предложит сохранить пароль, согласись (потом Face ID для автозаполнения)
> 3. «Поделиться» (квадрат со стрелкой ↑) → пролистни → **«На экран Домой»** → Добавить
> 4. Открой иконку с домашнего экрана
> 5. Колокольчик в шапке → разреши уведомления

### Б9. Финальная проверка

```bash
launchctl list | grep -E "cc-dashboard|cc-tunnel|cc-watchdog"
curl -s http://localhost:<LOCAL_PORT>/api/health
curl -sk https://<PUBLIC_DOMAIN>/api/health
```

Все должны вернуть `{"ok":true,...}`.

Запусти пару `claude` сессий в Terminal — они появятся в дашборде через 5-10 сек.

---

## Авто-обновления

Дашборд раз в 10 минут поллит `RELEASE.json` в git-репо origin. При появлении новой версии — на iPhone красная точка на бургер-меню, тап → changelog → «Обновить сейчас» → дашборд сам делает `git pull` и перезапускается.

**Ручных обновлений делать не нужно.**

---

## Troubleshooting

| симптом | где смотреть |
|---|---|
| `curl localhost:<LOCAL_PORT>` 503 | `auth.json` не создан, см. Б2 |
| 502 на публичном URL | autossh упал, `~/.cc-dashboard/tunnel.err.log`; или Caddy блок не работает |
| autossh «Permission denied (publickey)» | ключ не добавлен в `authorized_keys` юзера `<TUNNEL_USER>` |
| autossh «port X: forwarding failed» | старая sshd-сессия держит порт; на VPS: `lsof -ti:<VPS_PORT> \| xargs -r kill` |
| Push не приходит | проверь vapid.json subject (Б6), переподпишись в дашборде |
| Сессии не появляются | проверь что `claude` запущен; должен появиться файл в `~/.claude/projects/<encoded>/<sid>.jsonl` |
| Все логи | `~/.cc-dashboard/{out,err,tunnel,watchdog}.log` |
