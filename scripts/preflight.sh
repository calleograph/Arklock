#!/usr/bin/env bash
# preflight.sh — проверка требований перед установкой или обновлением (только чтение).
#   scripts/preflight.sh [--env ФАЙЛ] [--need-gib N]
# Код возврата: 0 — можно продолжать, 1 — есть блокирующие проблемы.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
NEED=3
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --need-gib) NEED="$2"; shift 2 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
ERR=0
bad() { fail "$*"; ERR=$((ERR + 1)); }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && ok "Docker доступен" || bad "Docker недоступен"
docker compose version >/dev/null 2>&1 && ok "Compose Plugin доступен" || bad "Нет плагина docker compose"
for c in curl gpg openssl flock tar sha256sum; do command -v "$c" >/dev/null 2>&1 && ok "Утилита $c" || bad "Нет утилиты $c"; done
dc config -q 2>/dev/null && ok "Конфигурация compose корректна" || bad "Конфигурация compose содержит ошибки (docker compose config)"
free="$(free_gib "$DATA_ROOT")"
[ "${free:-0}" -ge "$NEED" ] && ok "Свободно ${free} ГиБ (нужно ≥ $NEED)" || bad "Недостаточно места в $DATA_ROOT: ${free} ГиБ (нужно ≥ $NEED)"
if curl -fsS --max-time 5 -o /dev/null https://github.com 2>/dev/null; then ok "GitHub доступен"; else warn "GitHub недоступен: проверка обновлений невозможна (работа приложения не затронута)"; fi
if [ -f "$STATE_DIR/ops.lock" ] && ! flock -n "$STATE_DIR/ops.lock" true 2>/dev/null; then bad "Выполняется другая операция (блокировка занята)"; else ok "Незавершённых операций нет"; fi
[ "$ERR" -eq 0 ] || { fail "Требования не выполнены: $ERR"; exit 1; }
ok "Требования выполнены"
