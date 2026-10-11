#!/usr/bin/env bash
# check-updates.sh — проверка доступных версий (ничего не меняет, кроме локальной копии тегов git).
#   scripts/check-updates.sh [--env ФАЙЛ]
# Код возврата: 0 — актуальная версия, 10 — доступна новая, 1 — ошибка (в т.ч. репозиторий недоступен).
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/updatelib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/updatelib.sh"
while [ $# -gt 0 ]; do case "$1" in --env) export ENV_FILE="$2"; shift 2 ;; *) die "Неизвестный параметр: $1" ;; esac; done
init_instance
upd_init
if ! upd_fetch; then
  state_set update last_check_status unreachable
  state_set update last_check_at "$(date -u +%FT%TZ)"
  fail "Репозиторий недоступен. Установленная версия продолжает работать."
  exit 1
fi
latest="$(upd_latest_tag)"; cur="v$(app_version)"
state_set update last_check_at "$(date -u +%FT%TZ)"
state_set update latest_known "${latest:-}"
if [ -n "$latest" ] && upd_ver_gt "$latest" "$cur"; then
  state_set update last_check_status available
  commit="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$latest^{commit}")"
  info "Доступна версия $latest (установлена $cur). Миграций в новой версии: $(upd_migrations_at "$commit")."
  git -C "$REPO_ROOT" show "$commit:CHANGELOG.md" 2>/dev/null | sed -n '1,40p'
  exit 10
fi
state_set update last_check_status up_to_date
ok "Установлена актуальная версия $cur"
