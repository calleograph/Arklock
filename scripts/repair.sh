#!/usr/bin/env bash
# repair.sh — исправление известных проблем установки.
#   scripts/repair.sh [--env ФАЙЛ] [--restart] [--yes]
#
# Автоматически и безопасно: создание отсутствующих служебных каталогов, права на файлы окружения и ключа,
# проверка миграций и соединения с БД.
# Только с --restart: перезапуск неисправных контейнеров Arklock (нужен --yes либо подтверждение).
# НИКОГДА не выполняется: очистка БД, удаление томов, перегенерация секретов и ключей, сброс данных пользователей.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
RESTART=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
FIXED=0

for d in backups state updater logs tmp blobs; do
  if [ ! -d "$DATA_ROOT/$d" ]; then install -d -m 0750 "$DATA_ROOT/$d" && ok "Создан каталог $DATA_ROOT/$d" && FIXED=$((FIXED + 1)); fi
done
for f in "$ENV_FILE" "$BACKUP_KEY_FILE"; do
  if [ -f "$f" ] && [ "$(stat -c '%a' "$f")" != 600 ]; then chmod 600 "$f" && ok "Права 600 на $f" && FIXED=$((FIXED + 1)); fi
done
[ -f "$BACKUP_KEY_FILE" ] || warn "Ключ резервных копий отсутствует: $BACKUP_KEY_FILE. Автоматически не создаётся (существующие копии стали бы нечитаемыми). Если копий нет, создайте новый вручную: openssl rand -base64 48 > $BACKUP_KEY_FILE"

if dc exec -T db psql -U arklock -d arklock -tAc 'select 1' >/dev/null 2>&1; then ok "Соединение с БД работает"
else warn "БД недоступна"; fi

# Неисправные контейнеры
for svc in db app; do
  cid="$(dc ps -q "$svc" 2>/dev/null | head -n 1)"
  health=""; [ -n "$cid" ] && health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
  if [ -n "$cid" ] && [ "$health" = healthy ]; then ok "Контейнер $svc исправен"; continue; fi
  warn "Контейнер $svc неисправен (состояние: ${health:-не создан})"
  if [ "$RESTART" -eq 1 ]; then
    if [ "$YES" -ne 1 ]; then read -r -p "Перезапустить $svc? [y/N] " a; [ "$a" = y ] || continue; fi
    export_build_info
    dc up -d --no-build --wait --wait-timeout 180 "$svc" >/dev/null 2>&1 && ok "Контейнер $svc перезапущен" && FIXED=$((FIXED + 1)) || fail "Не удалось запустить $svc: scripts/logs.sh $svc"
  else
    info "Для перезапуска: scripts/repair.sh --restart"
  fi
done

"$REPO_ROOT/scripts/verify.sh" --env "$ENV_FILE" || { fail "После исправлений остались проблемы"; exit 1; }
ok "Исправлений выполнено: $FIXED"
