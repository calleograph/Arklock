#!/usr/bin/env bash
# restore.sh — восстановление Arklock из зашифрованной копии backup.sh. Работает из командной строки,
# веб-приложение для этого не нужно.
#   scripts/restore.sh ФАЙЛ [--env ФАЙЛ] [--yes] [--no-safety-backup]
#   scripts/restore.sh --remote ИМЯ [--env ФАЙЛ] [--yes]   взять копию с удалённого хранилища (scripts/remote.sh)
#
# ОПАСНО: заменяет содержимое базы данных проекта данными из копии. Перед заменой создаётся аварийная копия
# текущего состояния (метка pre-restore), если база доступна. Файл окружения НЕ заменяется (на новом сервере
# секреты и порты свои); конфигурация из копии остаётся внутри архива на случай ручной сверки.
# На новом сервере: install.sh → скопировать ключ резервного шифрования в /etc/arklock/backup.key → при копии на удалённом
# хранилище: remote.sh configure (адрес и секреты хранилища), remote.sh list → restore.sh --remote ИМЯ.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

FILE=""; YES=0; SAFETY=1; REMOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --no-safety-backup) SAFETY=0; shift ;;
    --remote) REMOTE="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Неизвестный параметр: $1" ;;
    *) FILE="$1"; shift ;;
  esac
done
init_instance
if [ -n "$REMOTE" ]; then
  [ -z "$FILE" ] || die "Укажите либо файл копии, либо --remote ИМЯ"
  [[ "$REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.bak\.gpg$ ]] || die "--remote: имя копии вида *.bak.gpg"
  info "Загрузка копии $REMOTE с удалённого хранилища…"
  "$REPO_ROOT/scripts/remote.sh" pull "$REMOTE" "$BACKUP_DIR" >/dev/null || die "Копия не загружена с удалённого хранилища (или повреждена при передаче)"
  FILE="$BACKUP_DIR/$REMOTE"
fi
[ -n "$FILE" ] && [ -f "$FILE" ] || die "Укажите существующий файл копии"
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

if [ -d "$tmp/blobs" ]; then
  info "Восстановление вложений…"
  rm -rf "$DATA_ROOT/blobs.prev"
  [ -d "$DATA_ROOT/blobs" ] && mv "$DATA_ROOT/blobs" "$DATA_ROOT/blobs.prev"
  mv "$tmp/blobs" "$DATA_ROOT/blobs"
  chown -R 1000:1000 "$DATA_ROOT/blobs" 2>/dev/null || warn "Не удалось назначить владельца каталога вложений"
  rm -rf "$DATA_ROOT/blobs.prev"
else
  warn "В копии нет вложений (создана версией без поддержки файлов): текущие файлы оставлены без изменений"
fi

info "Запуск приложения…"
export_build_info
dc up -d --no-build --wait --wait-timeout 180 app >/dev/null || die "Приложение не стало готовым после восстановления: scripts/logs.sh"
wait_ready 120 || die "API не отвечает после восстановления"
state_set backup last_restore_at "$(date -u +%FT%TZ)"
state_set backup last_restore_from "$(basename "$FILE")"
ok "Восстановление завершено. Пользователи входят прежними мастер-паролями."
ok "Проверьте систему: scripts/verify.sh"
