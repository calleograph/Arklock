#!/usr/bin/env bash
# smoke-test.sh — быстрая проверка основных сценариев работающего экземпляра (без изменения данных).
#   scripts/smoke-test.sh [--env ФАЙЛ]
# Глубокая проверка с созданием пользователя и шифрованной записи выполняется в CI (scripts/smoke-container.mjs).
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
while [ $# -gt 0 ]; do case "$1" in --env) export ENV_FILE="$2"; shift 2 ;; *) die "Неизвестный параметр: $1" ;; esac; done
init_instance
base="$(app_url_local)"
ERR=0
check() { # check ОПИСАНИЕ КОМАНДА…
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else fail "$d"; ERR=$((ERR + 1)); fi
}
hdr() { curl -fsSI --max-time 5 "$base/" 2>/dev/null | tr -d '\r' | grep -qi "^$1"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }

check "GET /api/v1/health" curl -fsS --max-time 5 "$base/api/v1/health"
check "GET /api/v1/ready" curl -fsS --max-time 5 "$base/api/v1/ready"
check "GET /api/v1/version" curl -fsS --max-time 5 "$base/api/v1/version"
check "Веб-интерфейс" bash -c "curl -fsS --max-time 5 '$base/' | grep -q '<div id=\"app\">'"
check "Заголовок Content-Security-Policy" hdr content-security-policy
check "Заголовок X-Content-Type-Options" hdr x-content-type-options
check "Защищённый маршрут без токена → 401" test "$(status_of "$base/api/v1/vaults")" = 401
check "Несуществующий путь API → 404 (JSON)" test "$(status_of "$base/api/v1/no-such-route")" = 404
check "Вход с неверными данными → 401" test "$(status_of -X POST -H 'content-type: application/json' -d '{"email":"smoke@example.com","authKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' "$base/api/v1/auth/login")" = 401
[ "$ERR" -eq 0 ] || { fail "Проверок не пройдено: $ERR"; exit 1; }
ok "Основные сценарии работают"
