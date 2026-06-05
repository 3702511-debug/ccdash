#!/bin/bash
# server-watchdog.sh — раз в минуту проверяет, что локальный дашборд-сервер отвечает.
# Если 3 фейла подряд — перезагружает LaunchAgent com.user.cc-dashboard.
# Это «парашют второго уровня»: tunnel-watchdog проверяет публичный URL, а этот — сам процесс.
# Запускается из LaunchAgent com.user.cc-server-watchdog каждые 60 сек.

URL="http://localhost:8787/api/health"
STATE_FILE="$HOME/.cc-dashboard/server-watchdog-fails.count"
LOG="$HOME/.cc-dashboard/server-watchdog.log"
SERVER_AGENT="$HOME/Library/LaunchAgents/com.user.cc-dashboard.plist"
FAIL_THRESHOLD=3

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# health-check с коротким timeout, чтобы не ждать долго зависший сервер
http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL" 2>/dev/null)

if [ "$http_code" = "200" ]; then
  if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" != "0" ]; then
    echo "[$(ts)] server recovered (http $http_code)" >> "$LOG"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"
echo "[$(ts)] server fail #$fails (http $http_code)" >> "$LOG"

if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
  exit 0
fi

echo "[$(ts)] threshold reached, restarting dashboard server..." >> "$LOG"

# Принудительно перезагружаем — даже если launchctl unload вернёт ошибку, load всё равно дёрнем
launchctl unload "$SERVER_AGENT" 2>> "$LOG"
sleep 2
# на всякий случай добиваем зависший процесс если launchd его не убил
pkill -f "bun.*/\.cc-dashboard/server.ts" 2>> "$LOG"
sleep 1
launchctl load "$SERVER_AGENT" 2>> "$LOG"

echo 0 > "$STATE_FILE"
echo "[$(ts)] dashboard server reloaded" >> "$LOG"
