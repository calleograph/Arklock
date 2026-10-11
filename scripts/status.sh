#!/usr/bin/env bash
# status.sh — краткое состояние экземпляра Arklock (только чтение).
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
while [ $# -gt 0 ]; do case "$1" in --env) ENV_FILE="$2"; shift 2 ;; *) die "Неизвестный параметр: $1" ;; esac; done
init_instance

echo "== Экземпляр: $COMPOSE_PROJECT_NAME (профиль ${INSTALL_PROFILE:-?})"
echo "Версия в каталоге:   $(app_version) ($(git_commit | cut -c1-12))"
v="$(curl -fsS --max-time 4 "$(app_url_local)/api/v1/version" 2>/dev/null || true)"
echo "Работающая версия:   ${v:-приложение не отвечает}"
echo "Адрес:               ${APP_PUBLIC_URL:-$(app_url_local)}"
echo
echo "== Контейнеры"
dc ps --format 'table {{.Service}}\t{{.Image}}\t{{.State}}\t{{.Status}}' 2>/dev/null || warn "Не удалось получить состояние контейнеров"
echo
echo "== Место"
df -h "$DATA_ROOT" | tail -n 1 | awk '{print "Каталог данных: занято " $3 " из " $2 " (" $5 "), свободно " $4}'
echo
echo "== Резервные копии"
last="$(state_get backup last_at)"
echo "Последняя копия:     ${last:-нет} ($(state_get backup last_file))"
echo "Всего копий:         $(find "$BACKUP_DIR" -maxdepth 1 -name '*.bak.gpg' 2>/dev/null | wc -l)"
echo
echo "== Установка"
echo "Установлено:         $(state_get install installed_at)"
echo "Последнее обновление: $(state_get update last_success_at)"
