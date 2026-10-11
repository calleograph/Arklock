#!/usr/bin/env bash
# restore.sh — восстановление Arklock из зашифрованной копии backup.sh. Работает из командной строки,
# веб-приложение для этого не нужно.
#   scripts/restore.sh ФАЙЛ [--env ФАЙЛ] [--yes] [--no-safety-backup]
#
# ОПАСНО: заменяет содержимое базы данных проекта данными из копии. Перед заменой создаётся аварийная копия
# текущего состояния (метка pre-restore), если база доступна. Файл окружения НЕ заменяется (на новом сервере
# секреты и порты свои); конфигурация из копии остаётся внутри архива на случай ручной сверки.
# На новом сервере: install.sh → скопировать ключ резервного шифрования в /etc/arklock/backup.key → restore.sh.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

FILE=""; YES=0; SAFETY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --no-safety-backup) SAFETY=0; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Неизвестный параметр: $1" ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || die "Укажите существующий файл копии"
init_instance
need_cmd gpg; need_cmd tar
[ -r "$BACKUP_KEY_FILE" ] || die "Нет ключа резервного шифрования: $BACKUP_KEY_FILE (скопируйте ключ исходного сервера)"
acquire_lock
mkdir -p "$DATA_ROOT/tmp"

umask 077
tmp="$(mktemp -d "$DATA_ROOT/tmp/restore.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

info "Проверка копии…"
"$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --verify "$FILE" || die "Копия не прошла проверку — восстановление не начато, данные не изменены."
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" -d "$FILE" | tar -x -C "$tmp"

bk_ver="$(sed -n 's/.*"appVersion": *"\([^"]*\)".*/\1/p' "$tmp/manifest.json")"
bk_mig="$(sed -n 's/.*"migrations": *\([0-9]*\).*/\1/p' "$tmp/manifest.json")"
code_mig="$(grep -c '"tag"' "$REPO_ROOT/apps/api/drizzle/meta/_journal.json")"
if [ "${bk_mig:-0}" -gt "$code_mig" ]; then
  die "Копия создана более новой версией ($bk_ver, миграций $bk_mig), чем установленная (миграций $code_mig). Сначала обновите Arklock."
fi
info "Копия: версия $bk_ver, миграций $bk_mig; установленная версия $(app_version), миграций $code_mig"
[ "$bk_mig" -ge "$code_mig" ] || info "Недостающие миграции будут применены при запуске приложения"

warn "Текущая база данных проекта «$COMPOSE_PROJECT_NAME» будет ЗАМЕНЕНА данными из копии."
if [ "$YES" -ne 1 ]; then
  read -r -p "Для подтверждения введите имя проекта ($COMPOSE_PROJECT_NAME): " ans
  [ "$ans" = "$COMPOSE_PROJECT_NAME" ] || die "Подтверждение не получено — отмена."
fi

dc up -d --wait db >/dev/null 2>&1 || die "Не удалось запустить контейнер базы данных"
if [ "$SAFETY" -eq 1 ]; then
  if dc exec -T db psql -U arklock -d arklock -tAc 'select 1' >/dev/null 2>&1; then
    info "Аварийная копия текущего состояния…"
    "$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --label pre-restore --keep 50 || die "Аварийная копия не создана — восстановление остановлено (повторите с --no-safety-backup, если текущие данные не нужны)."
  else
    warn "Текущая БД недоступна или пуста — аварийная копия пропущена"
  fi
fi

info "Остановка приложения…"
dc stop app >/dev/null
info "Пересоздание базы данных…"
dc exec -T db psql -U arklock -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS arklock WITH (FORCE)' -c 'CREATE DATABASE arklock OWNER arklock' >/dev/null \
  || die "Не удалось пересоздать базу данных. Аварийная копия: $BACKUP_DIR (метка pre-restore)."
info "Загрузка данных…"
dc exec -T db pg_restore -U arklock -d arklock --no-owner --exit-on-error < "$tmp/db.dump" \
  || die "pg_restore завершился с ошибкой. Данные до восстановления — в аварийной копии (метка pre-restore)."

info "Запуск приложения…"
export_build_info
dc up -d --no-build --wait --wait-timeout 180 app >/dev/null || die "Приложение не стало готовым после восстановления: scripts/logs.sh"
wait_ready 120 || die "API не отвечает после восстановления"
state_set backup last_restore_at "$(date -u +%FT%TZ)"
state_set backup last_restore_from "$(basename "$FILE")"
ok "Восстановление завершено. Пользователи входят прежними мастер-паролями."
ok "Проверьте систему: scripts/verify.sh"
