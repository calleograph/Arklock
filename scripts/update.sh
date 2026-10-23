#!/usr/bin/env bash
# update.sh — обновление Arklock до новой версии (релизного тега).
#   scripts/update.sh [--ref vX.Y.Z] [--env ФАЙЛ] [--yes] [--dry-run]
#
# Порядок: проверка требований → загрузка тегов → выбор версии → шифрованная резервная копия с проверкой →
# сохранение образа текущей версии → сборка новой (старая продолжает работать) → запуск и миграции →
# healthcheck и проверки → фиксация результата. При ошибке выполняется автоматическое восстановление:
#   • если схема БД не менялась — возврат кода и образа предыдущей версии;
#   • если миграции успели примениться — восстановление БД из копии, сделанной перед обновлением.
# Этот же сценарий использует помощник обновлений для кнопки «Обновить» в веб-интерфейсе.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/updatelib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/updatelib.sh"

REF=""; YES=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --env) export ENV_FILE="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
need_cmd git
upd_init
[ -z "$REF" ] || [[ "$REF" =~ $TAG_RE ]] || die "--ref: допустимы только релизные теги вида vX.Y.Z"

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "Каталог программы не является git-репозиторием: обновление невозможно"
acquire_lock
# Адрес публикации, вписанный вручную в compose.yaml (версии 1.0.x), переносится в APP_BIND файла окружения;
# сам файл возвращается к версии релиза. Любые другие изменения файлов по-прежнему останавливают обновление.
ic_migrate_bind "$REPO_ROOT" "$ENV_FILE" "$DATA_ROOT/config-backups" $((1 - DRY)) || die "Перенос адреса публикации не выполнен (ничего не изменено)."
# Если APP_BIND потерян (как после прошлого обновления 1.0.x → 1.11.x), адрес берём у работающего приложения.
[ "$DRY" -eq 1 ] || ic_restore_bind_from_running "$ENV_FILE" "$COMPOSE_PROJECT_NAME"
DIRTY="$(ic_modified_files "$REPO_ROOT")"
[ "$DRY" -eq 1 ] || [ -z "$DIRTY" ] || die "В каталоге программы есть локальные изменения: $(printf '%s' "$DIRTY" | tr '\n' ' ') — обновление остановлено (ничего не изменено). См. docs/TROUBLESHOOTING.md."
# место проверяется по фактическим размерам образа, базы и вложений, а не фиксированным порогом
"$REPO_ROOT/scripts/preflight.sh" --env "$ENV_FILE" --need-gib 0 || die "Требования для обновления не выполнены (ничего не изменено)."
upd_space_check || die "Недостаточно места для обновления (ничего не изменено). Освободите место или расширьте диск."

upd_step 1 7 "Проверка требований и получение версий"
upd_log "Проверка обновлений: получение тегов"
upd_fetch || die "Не удалось связаться с репозиторием. Приложение продолжает работать без изменений."

CUR_COMMIT="$(git_commit)"; CUR_VERSION="$(app_version)"
TARGET_TAG="${REF:-$(upd_latest_tag)}"
[ -n "$TARGET_TAG" ] || die "В репозитории нет релизных тегов"
git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/tags/$TARGET_TAG^{commit}" >/dev/null || die "Тег $TARGET_TAG не найден"
TARGET_COMMIT="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$TARGET_TAG^{commit}")"
if [ "$TARGET_COMMIT" = "$CUR_COMMIT" ]; then ok "Установлена актуальная версия ($CUR_VERSION)"; exit 0; fi
if [ -z "$REF" ] && ! upd_ver_gt "$TARGET_TAG" "v$CUR_VERSION"; then ok "Новых версий нет (установлена $CUR_VERSION, последняя $TARGET_TAG)"; exit 0; fi
if [ -n "$REF" ] && ! upd_ver_gt "$TARGET_TAG" "v$CUR_VERSION"; then die "Версия $TARGET_TAG не новее установленной ($CUR_VERSION). Для возврата используйте scripts/rollback.sh."; fi

TARGET_VERSION="$(git -C "$REPO_ROOT" show "$TARGET_COMMIT:VERSION" 2>/dev/null | tr -d '[:space:]')"
[ "v$TARGET_VERSION" = "$TARGET_TAG" ] || die "Файл VERSION ($TARGET_VERSION) в теге $TARGET_TAG не совпадает с тегом — релиз не принят."
if [ "${ARKLOCK_REQUIRE_SIGNED_TAGS:-0}" = 1 ]; then
  git -C "$REPO_ROOT" verify-tag "$TARGET_TAG" >/dev/null 2>&1 || die "Подпись тега $TARGET_TAG не подтверждена (ARKLOCK_REQUIRE_SIGNED_TAGS=1)"
fi

TARGET_MIGR="$(upd_migrations_at "$TARGET_COMMIT")"
CUR_MIGR="$(upd_migrations_applied)"
upd_log "Обновление $CUR_VERSION → $TARGET_VERSION (миграций: сейчас ${CUR_MIGR:-?}, в новой версии $TARGET_MIGR)"
if [ "$DRY" -eq 1 ]; then ok "[dry-run] будет выполнено обновление до $TARGET_TAG; изменений не внесено"; exit 0; fi
if [ "$YES" -ne 1 ]; then read -r -p "Обновить Arklock до $TARGET_TAG? [y/N] " a; [ "$a" = y ] || die "Отменено."; fi

# --- резервная копия перед обновлением
upd_step 2 7 "Резервная копия перед обновлением"
state_set update status running
state_set update started_at "$(date -u +%FT%TZ)"
upd_log "Резервная копия перед обновлением"
"$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --label pre-update --keep 20 || { state_set update status failed_backup; die "Резервная копия не создана — обновление остановлено, изменений нет."; }
BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/*-pre-update.bak.gpg 2>/dev/null | head -n 1)"
[ -n "$BACKUP_FILE" ] || { state_set update status failed_backup; die "Файл резервной копии не найден"; }

# --- сохранение текущего состояния для отката
IMG_BASE="$(upd_image_base)"
PREV_IMAGE="${IMG_BASE}:prev-${CUR_COMMIT:0:12}"
# Образ берётся у РАБОТАЮЩЕГО контейнера (по идентификатору), а не по тегу: после отката тег мог указывать на другую версию.
RUNNING_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$(dc ps -q app | head -n 1)" 2>/dev/null)"
[ -n "$RUNNING_IMAGE_ID" ] || die "Не удалось определить образ работающего приложения"
docker tag "$RUNNING_IMAGE_ID" "$PREV_IMAGE" || die "Не удалось сохранить образ текущей версии"
state_set update previous_version "$CUR_VERSION"
state_set update previous_commit "$CUR_COMMIT"
state_set update previous_image "$PREV_IMAGE"
state_set update previous_migrations "${CUR_MIGR:-0}"
state_set update target_version "$TARGET_VERSION"
state_set update target_commit "$TARGET_COMMIT"
state_set update backup_file "$BACKUP_FILE"

recover() { # recover ПРИЧИНА — автоматическое восстановление после неудачи
  local why="$1" now
  upd_log "ОШИБКА обновления: $why. Запуск восстановления…"
  now="$(upd_migrations_applied)"
  if [ -z "$now" ] || [ "${now:-0}" -le "${CUR_MIGR:-0}" ]; then
    upd_log "Схема БД не менялась — возврат кода и образа версии $CUR_VERSION"
    if upd_revert_code "$CUR_COMMIT" "$PREV_IMAGE"; then
      upd_retag_current "$PREV_IMAGE"
      state_set update status rolled_back; state_set update finished_at "$(date -u +%FT%TZ)"
      fail "Обновление не выполнено, система возвращена на версию $CUR_VERSION и работает."
    else
      state_set update status recovery_failed
      fail "Автоматический возврат не удался. Выполните: scripts/rollback.sh и scripts/repair.sh; копия перед обновлением: $BACKUP_FILE"
    fi
  else
    upd_log "Миграции уже применены ($now > ${CUR_MIGR:-0}) — восстановление БД из копии перед обновлением"
    git -C "$REPO_ROOT" checkout --quiet --detach "$CUR_COMMIT" || true
    ic_apply_legacy_bind "$REPO_ROOT" "$ENV_FILE" || true
    export ARKLOCK_IMAGE="$PREV_IMAGE" ARKLOCK_IMAGE_OVERRIDE="$PREV_IMAGE"
    if "$REPO_ROOT/scripts/restore.sh" "$BACKUP_FILE" --env "$ENV_FILE" --yes --no-safety-backup; then
      upd_retag_current "$PREV_IMAGE"
      state_set update status restored_from_backup; state_set update finished_at "$(date -u +%FT%TZ)"
      fail "Обновление не выполнено. БД восстановлена из копии перед обновлением, версия $CUR_VERSION работает."
    else
      state_set update status recovery_failed
      fail "Автоматическое восстановление не удалось. Копия перед обновлением: $BACKUP_FILE. Выполните: scripts/restore.sh \"$BACKUP_FILE\""
    fi
  fi
  exit 1
}

# --- получение новой версии и сборка (прежняя версия продолжает работать)
git -C "$REPO_ROOT" checkout --quiet --detach "$TARGET_COMMIT" || { state_set update status failed; die "Не удалось переключить код на $TARGET_TAG"; }
upd_step 3 7 "Получение и сборка новой версии"
upd_log "Сборка образа версии $TARGET_VERSION"
export_build_info
if fetch_release_image "$TARGET_VERSION" "$TARGET_COMMIT"; then
  upd_log "Загружен готовый образ релиза $TARGET_VERSION"
elif ! dc build app >"$DATA_ROOT/logs/update-build.log" 2>&1; then
  git -C "$REPO_ROOT" checkout --quiet --detach "$CUR_COMMIT"
  ic_apply_legacy_bind "$REPO_ROOT" "$ENV_FILE" || true
  state_set update status failed_build; state_set update finished_at "$(date -u +%FT%TZ)"
  tail -n 15 "$DATA_ROOT/logs/update-build.log" | mask_text_stream >&2
  die "Сборка новой версии не удалась. Работающая версия $CUR_VERSION не затронута."
fi

# --- запуск (миграции применяются приложением при старте) и проверки
upd_step 4 7 "Запуск новой версии и миграции БД"
upd_log "Запуск новой версии и применение миграций"
upd_wait_app "${ARKLOCK_UPDATE_WAIT:-240}" || recover "приложение не стало готовым после запуска"
upd_step 5 7 "Проверка работоспособности"
"$REPO_ROOT/scripts/verify.sh" --env "$ENV_FILE" >"$DATA_ROOT/logs/update-verify.log" 2>&1 || { tail -n 20 "$DATA_ROOT/logs/update-verify.log" >&2; recover "проверка verify не пройдена"; }
"$REPO_ROOT/scripts/smoke-test.sh" --env "$ENV_FILE" >"$DATA_ROOT/logs/update-smoke.log" 2>&1 || { tail -n 20 "$DATA_ROOT/logs/update-smoke.log" >&2; recover "smoke-тест не пройден"; }

upd_step 6 7 "Фиксация результата"
NEW_MIGR="$(upd_migrations_applied)"
state_set update status success
state_set update last_success_at "$(date -u +%FT%TZ)"
state_set update finished_at "$(date -u +%FT%TZ)"
state_set update migrations_after "${NEW_MIGR:-0}"
state_set install version "$TARGET_VERSION"
state_set install commit "$TARGET_COMMIT"
upd_log "Обновление завершено: $CUR_VERSION → $TARGET_VERSION (миграции: ${CUR_MIGR:-?} → ${NEW_MIGR:-?})"
# только после успеха: остаются образ новой версии и образ $CUR_VERSION для отката, старые образы и кэш сборки удаляются
upd_cleanup "$PREV_IMAGE"
upd_step 7 7 "Готово"
ok "Arklock обновлён до $TARGET_VERSION. Откат: scripts/rollback.sh (безопасен, только если схема БД не менялась)."
