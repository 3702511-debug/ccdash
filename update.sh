#!/bin/bash
# update.sh — обновить локальный дашборд из git и перезагрузить.
# Usage: ./update.sh
# Запускать из папки cc-dashboard (где клонирован репо).

set -e
cd "$(dirname "$0")"

echo "[update] git pull..."
git pull --ff-only

echo "[update] re-running setup-local.ts (deps + копия в ~/.cc-dashboard/)..."
bun run setup-local.ts

echo ""
echo "✓ Готово. Дашборд перезапущен с новой версией."
echo "  Health: curl -s http://localhost:8787/api/health"
