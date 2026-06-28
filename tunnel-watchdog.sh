#!/bin/bash
# tunnel-watchdog.sh — раз в минуту проверяет, что дашборд доступен через публичный URL.
# Если 3 подряд проверки падают, принудительно вычищает старую sshd-сессию на VPS
# и перезагружает локальный LaunchAgent autossh.
#
# Запускается из LaunchAgent com.user.cc-watchdog раз в 60 сек.
#
# ENV (выставляется setup-local.ts → plist из ~/.cc-dashboard/tunnel-config.json):
#   PUBLIC_URL   — например https://eadashboard.duckdns.org:8443/api/health
#   VPS_HOST     — например root@5.181.202.248
#   TUNNEL_PORT  — например 18787
#   SSH_KEY      — например /Users/ea/.ssh/id_ed25519
#   TUNNEL_AGENT — путь к ~/Library/LaunchAgents/com.user.cc-tunnel.plist
# Если PUBLIC_URL не задан — скрипт молча выходит (watchdog inactive).

[ -z "$PUBLIC_URL" ] && exit 0

VPS="${VPS_HOST:-root@5.181.202.248}"
TUNNEL_PORT="${TUNNEL_PORT:-18787}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
STATE_FILE="$HOME/.cc-dashboard/watchdog-fails.count"
LOG="$HOME/.cc-dashboard/watchdog.log"
TUNNEL_AGENT="${TUNNEL_AGENT:-$HOME/Library/LaunchAgents/com.user.cc-tunnel.plist}"
TUNNEL_ERR="$HOME/.cc-dashboard/tunnel.err.log"
FAIL_THRESHOLD=3

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# health check (public URL)
http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$PUBLIC_URL" 2>/dev/null)

if [ "$http_code" = "200" ]; then
  if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" != "0" ]; then
    echo "[$(ts)] recovered (http $http_code)" >> "$LOG"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

# Публичный URL не отвечает. Проверим, реально ли туннель сломан, или это
# клиентская проблема (VPN/DNS на Mac режет outbound к VPS-IP). Делаем SSH на VPS
# и оттуда curl на локальный туннель-порт — если 200, туннель жив, recovery не нужен.
tunnel_code=$(ssh -o ConnectTimeout=4 -o BatchMode=yes -o StrictHostKeyChecking=no \
  -i "$SSH_KEY" "$VPS" \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://localhost:$TUNNEL_PORT/api/health" \
  2>/dev/null)

if [ "$tunnel_code" = "200" ]; then
  # Туннель ЖИВ — Caddy с VPS получает 200 OK через наш autossh-forward.
  # Значит публичный URL недоступен из-за местной сети (VPN/DNS/firewall),
  # а не из-за упавшего туннеля. Не делаем recovery, сбрасываем счётчик.
  if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" != "0" ]; then
    echo "[$(ts)] публичный URL=$http_code, но туннель жив (SSH-check=200) — местная сеть, recovery не нужно" >> "$LOG"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

# fail (и публика, и туннель не отвечают, либо SSH к VPS не прошёл)
fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"
echo "[$(ts)] fail #$fails (public=$http_code tunnel=$tunnel_code)" >> "$LOG"

if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
  exit 0
fi

# Если autossh жив И в tunnel.err.log за последнюю минуту есть свежее
# "remote port forwarding failed" — порт занят зомби на VPS, kill+reload бесполезен.
# Ждём, пока sshd на VPS сам отпустит мёртвый forward (через ClientAliveInterval).
if [ -f "$TUNNEL_ERR" ] \
   && find "$TUNNEL_ERR" -newermt '1 minute ago' -print 2>/dev/null | grep -q . \
   && grep -q "remote port forwarding failed" "$TUNNEL_ERR" \
   && pgrep -f "autossh" >/dev/null 2>&1; then
  echo "[$(ts)] skip reload — autossh жив, порт занят на VPS, жду освобождения" >> "$LOG"
  sleep 30
  exit 0
fi

echo "[$(ts)] threshold reached, recovering tunnel…" >> "$LOG"

# 1. Чистим старую sshd-сессию на VPS, которая держит TUNNEL_PORT
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "$SSH_KEY" "$VPS" \
  "lsof -ti:$TUNNEL_PORT | xargs -r kill -9" >> "$LOG" 2>&1

# 2. Перезагружаем локальный autossh.
launchctl unload "$TUNNEL_AGENT" 2>> "$LOG"
sleep 15
pkill -f autossh 2>> "$LOG"
sleep 2
launchctl load "$TUNNEL_AGENT" 2>> "$LOG"

echo 0 > "$STATE_FILE"
echo "[$(ts)] tunnel agent reloaded" >> "$LOG"
