#!/usr/bin/env bash
# diag.sh — диагностический пакет для поддержки. Секреты маскируются; содержимое БД, ключи и пароли не включаются.
#   scripts/diag.sh [--env ФАЙЛ]   → $DATA_ROOT/tmp/arklock-diag-<время>.tar.gz
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
while [ $# -gt 0 ]; do case "$1" in --env) export ENV_FILE="$2"; shift 2 ;; *) die "Неизвестный параметр: $1" ;; esac; done
init_instance
mkdir -p "$DATA_ROOT/tmp"
umask 077
work="$(mktemp -d "$DATA_ROOT/tmp/diag.XXXXXX")"
trap 'rm -rf "$work"' EXIT
OUT="$DATA_ROOT/tmp/arklock-diag-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

{
  echo "Arklock $(app_version) commit $(git_commit)"; date -u
  . /etc/os-release 2>/dev/null && echo "ОС: $PRETTY_NAME"
  uname -a; uptime
  echo; free -m; echo; df -h "$DATA_ROOT" /
} > "$work/system.txt" 2>&1
{
  docker --version; docker compose version
  echo; dc ps 2>&1
  echo; docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E "^${COMPOSE_PROJECT_NAME}|arklock"
} > "$work/docker.txt" 2>&1
mask_env_stream < "$ENV_FILE" > "$work/env.masked"
"$REPO_ROOT/scripts/verify.sh" --env "$ENV_FILE" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | mask_text_stream > "$work/verify.txt" || true
for s in app db; do dc logs --no-color --tail 500 "$s" 2>&1 | mask_text_stream > "$work/log-$s.txt"; done
cp "$STATE_DIR"/*.state "$work/" 2>/dev/null || true
for f in "$work"/*.state; do [ -f "$f" ] && mask_env_stream < "$f" > "$f.masked" && rm -f "$f"; done

tar -C "$work" -czf "$OUT" .
chmod 600 "$OUT"
ok "Диагностический пакет: $OUT"
info "Секреты в пакете замаскированы, но проверьте содержимое перед отправкой."
