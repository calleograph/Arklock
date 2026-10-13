#!/usr/bin/env bash
# rollback.sh — возврат к версии, установленной до последнего обновления.
#   scripts/rollback.sh [--env ФАЙЛ] [--yes] [--dry-run] [--with-restore]
#
# Откат кода и образа БЕЗ отката схемы БД небезопасен. Поэтому:
#   • если после обновления применялись новые миграции — откат кода ОТКАЗЫВАЕТ (ничего не меняется), пока вы явно не
#     выберете --with-restore: тогда БД восстанавливается из копии, сделанной перед обновлением (данные, записанные
#     после обновления, будут потеряны), и только затем возвращается код;
#   • если схема не менялась — возвращаются только код и образ (образ предыдущей версии сохранён, пересборки нет).
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/updatelib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/updatelib.sh"

YES=0; DRY=0; WITH_RESTORE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --with-restore) WITH_RESTORE=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
upd_init
acquire_lock

PREV_COMMIT="$(state_get update previous_commit)"; PREV_VERSION="$(state_get update previous_version)"
PREV_IMAGE="$(state_get update previous_image)"; BACKUP_FILE="$(state_get update backup_file)"
[ -n "$PREV_COMMIT" ] && [ -n "$PREV_IMAGE" ] || die "Нет сведений о предыдущей версии: откатываться некуда."
docker image inspect "$PREV_IMAGE" >/dev/null 2>&1 || die "Образ предыдущей версии ($PREV_IMAGE) отсутствует локально — откат без пересборки невозможен."
git -C "$REPO_ROOT" cat-file -e "$PREV_COMMIT^{commit}" 2>/dev/null || die "Коммит предыдущей версии отсутствует в репозитории"

CUR_VERSION="$(app_version)"
APPLIED="$(upd_migrations_applied)"
PREV_MIGR="$(upd_migrations_at "$PREV_COMMIT")"
info "Текущая версия $CUR_VERSION → возврат к $PREV_VERSION. Миграций в БД: ${APPLIED:-?}; известно предыдущей версии: $PREV_MIGR"

NEED_RESTORE=0
if [ -z "$APPLIED" ]; then
  fail "Не удалось определить состояние БД — совместимость схемы не проверена, откат остановлен."; exit 3
elif [ "$APPLIED" -gt "$PREV_MIGR" ]; then
  NEED_RESTORE=1
  fail "============================================================"
  fail "Автоматический откат невозможен: после обновления применено миграций БД: $((APPLIED - PREV_MIGR))."
  fail "Предыдущая версия ($PREV_VERSION) не знает новую схему; запуск старого кода поверх неё может испортить данные."
  if [ "$WITH_RESTORE" -eq 1 ] && [ -f "$BACKUP_FILE" ]; then
    warn "Выбран --with-restore: БД будет восстановлена из копии перед обновлением ($(basename "$BACKUP_FILE")). Данные, записанные после обновления, будут потеряны."
  else
    fail "Варианты: (1) остаться на новой версии и исправить проблему обновлением; (2) scripts/rollback.sh --with-restore —"
    fail "восстановить БД из копии перед обновлением (потеря данных, записанных после обновления): ${BACKUP_FILE:-копия не найдена}"
    fail "============================================================"
    exit 3
  fi
else
  ok "Схема БД совместима с предыдущей версией — достаточно вернуть код и образ"
fi

if [ "$DRY" -eq 1 ]; then ok "[dry-run] откат возможен ($([ "$NEED_RESTORE" -eq 1 ] && echo 'с восстановлением БД' || echo 'только код и образ'))"; exit 0; fi
if [ "$YES" -ne 1 ]; then read -r -p "Выполнить откат на $PREV_VERSION? [y/N] " a; [ "$a" = y ] || die "Отменено."; fi

state_set update status rolling_back
# адрес публикации, вписанный вручную в compose.yaml, переносится в APP_BIND до переключения кода
ic_migrate_bind "$REPO_ROOT" "$ENV_FILE" "$DATA_ROOT/config-backups" 1 || die "Перенос адреса публикации не выполнен (откат не начат)."
git -C "$REPO_ROOT" checkout --quiet --detach "$PREV_COMMIT" || die "Не удалось переключить код"
ic_apply_legacy_bind "$REPO_ROOT" "$ENV_FILE" || warn "Адрес публикации предыдущей версии не применён: проверьте APP_BIND (docs/TROUBLESHOOTING.md)."
export ARKLOCK_IMAGE="$PREV_IMAGE" ARKLOCK_IMAGE_OVERRIDE="$PREV_IMAGE"
if [ "$NEED_RESTORE" -eq 1 ]; then
  "$REPO_ROOT/scripts/restore.sh" "$BACKUP_FILE" --env "$ENV_FILE" --yes || die "Восстановление БД не удалось. Копия: $BACKUP_FILE"
else
  upd_wait_app 180 || die "Предыдущая версия не стала готовой: scripts/logs.sh"
fi
if ! "$REPO_ROOT/scripts/verify.sh" --env "$ENV_FILE" >"$DATA_ROOT/logs/rollback-verify.log" 2>&1; then
  warn "verify сообщил о проблемах после отката:"; cat "$DATA_ROOT/logs/rollback-verify.log" >&2
fi
upd_retag_current "$PREV_IMAGE"
state_set update status rolled_back_manually
state_set update finished_at "$(date -u +%FT%TZ)"
state_set install version "$PREV_VERSION"
upd_log "Откат выполнен: $CUR_VERSION → $PREV_VERSION"
ok "Выполнен откат на $PREV_VERSION."
warn "Каталог программы в состоянии detached HEAD. Чтобы снова получать обновления: scripts/update.sh"
