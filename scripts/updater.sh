#!/usr/bin/env bash
# updater.sh — помощник обновлений Arklock: системная служба с ограниченным набором операций.
#   scripts/updater.sh install [--env ФАЙЛ]     установить и запустить службу systemd (идемпотентно, нужен root)
#   scripts/updater.sh status  [--env ФАЙЛ]     состояние службы и пульс
#   scripts/updater.sh repair  [--env ФАЙЛ]     восстановить службу (unit, каталог обмена, перезапуск при отсутствии пульса)
#   scripts/updater.sh uninstall [--env ФАЙЛ]   остановить и удалить службу
#   scripts/updater.sh print-unit [--env ФАЙЛ]  показать unit-файл
#   scripts/updater.sh run [--env ФАЙЛ]         рабочий цикл (запускается службой)
#
# Зачем: контейнер приложения не имеет доступа к Docker и хосту (и не должен). Веб-интерфейс кладёт запрос в каталог
# обмена $DATA_ROOT/updater, а помощник — служба root на хосте — выполняет ТОЛЬКО фиксированный набор действий:
#   check (проверка версий), update vX.Y.Z, rollback [с восстановлением БД];
#   backup, backup_verify, backup_delete, backup_export, restore (резервные копии этого проекта), logs (журналы
#   контейнеров проекта с маскированием), schedule (расписание автоматических копий).
# Кроме того, помощник периодически публикует снимки состояния (containers.json, backups.json, schedule.json):
# только контейнеры ЭТОГО проекта compose, только копии этого проекта.
# Запрос — несколько строк key=value; каждое значение проверяется по строгому шаблону. Произвольные команды, пути и
# образы из запроса выполнить невозможно. Операции запускаются теми же сценариями, что и в командной строке
# (update.sh, rollback.sh, check-updates.sh), в стерильном окружении (env -i).
#
# Файлы обмена ($DATA_ROOT/updater): request.txt (пишет приложение), status.json, remote.json, helper.json, history.jsonl,
# update.log (пишет помощник). Каталог $DATA_ROOT закрыт для обычных пользователей хоста (0750).
set -uo pipefail

# Рабочая копия: пока помощник исполняется, обновление может заменить файлы в каталоге программы.
# Поэтому цикл работает из копии сценария и библиотек, а после операции при изменении файлов перезапускается с новой копией.
if [ "${ARKLOCK_UPDATER_COPY:-}" != 1 ] && [ "${ARKLOCK_UPDATER_LIB_ONLY:-}" != 1 ] && [ "${1:-}" = run ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  RUN_DIR="$(mktemp -d /run/arklock-updater.XXXXXX 2>/dev/null || mktemp -d)"
  mkdir -p "$RUN_DIR/lib"
  cp "$SRC_DIR/updater.sh" "$RUN_DIR/updater.sh"
  cp "$SRC_DIR/lib/common.sh" "$SRC_DIR/lib/updatelib.sh" "$RUN_DIR/lib/"
  ARKLOCK_REPO_ROOT="$(cd "$SRC_DIR/.." && pwd)" ARKLOCK_UPDATER_COPY=1 ARKLOCK_UPDATER_SRC="$SRC_DIR" ARKLOCK_UPDATER_RUNDIR="$RUN_DIR" \
    exec bash "$RUN_DIR/updater.sh" "$@"
fi

# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/updatelib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/updatelib.sh"

HEARTBEAT_MAX_AGE=40
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ------------------------------------------------------------------ вспомогательное
ensure_channel() {
  install -d -m 0750 "$DATA_ROOT" 2>/dev/null || true
  install -d -m 1777 "$CH"
}

jstr() { # экранирование строки для JSON (управляющие символы удаляются, переводы строк сохраняются как \n)
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); if (NR>1) print "\\n"; print $0}'
}

atomic_write() { # atomic_write ФАЙЛ (содержимое — со стандартного ввода); имя временного файла случайное
  local f="$1" tmp
  tmp="$(mktemp "$CH/.w.XXXXXXXX")" || return 1
  cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$f" || { rm -f "$tmp"; return 1; }
}

heartbeat() {
  printf '{"ts":%s,"pid":%s,"version":"%s","project":"%s"}\n' "$(date +%s)" "$$" "$(jstr "$(app_version)")" "$COMPOSE_PROJECT_NAME" | atomic_write "$CH/helper.json"
}

# Текущая операция
ST_STATE=idle; ST_ACTION=""; ST_REQ=""; ST_NO=0; ST_TOTAL=0; ST_NAME=""; ST_STARTED=""; ST_FINISHED=""; ST_RESULT=""; ST_MSG=""; ST_FROM=""; ST_TO=""
write_status() {
  printf '{"state":"%s","action":"%s","request_id":"%s","step_no":%s,"step_total":%s,"step_name":"%s","started_at":"%s","finished_at":"%s","result":"%s","message":"%s","version_from":"%s","version_to":"%s"}\n' \
    "$ST_STATE" "$ST_ACTION" "$ST_REQ" "$ST_NO" "$ST_TOTAL" "$(jstr "$ST_NAME")" "$ST_STARTED" "$ST_FINISHED" "$ST_RESULT" "$(jstr "$ST_MSG")" "$(jstr "$ST_FROM")" "$(jstr "$ST_TO")" | atomic_write "$CH/status.json"
}

history_add() {
  printf '{"at":"%s","action":"%s","result":"%s","version_from":"%s","version_to":"%s","message":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$ST_ACTION" "$ST_RESULT" "$(jstr "$ST_FROM")" "$(jstr "$ST_TO")" "$(jstr "$ST_MSG")" >> "$CH/history.jsonl"; chmod 644 "$CH/history.jsonl"
  # журнал истории ограничен по размеру
  if [ "$(wc -l < "$CH/history.jsonl")" -gt 500 ]; then tail -n 300 "$CH/history.jsonl" > "$CH/.history.tmp" && mv -f "$CH/.history.tmp" "$CH/history.jsonl"; fi
}

# ------------------------------------------------------------------ разбор и проверка запроса
# Результат: REQ_ID, REQ_ACTION, REQ_VERSION, REQ_RESTORE. Возвращает 0 только для корректного запроса.
parse_request() { # parse_request ФАЙЛ
  local file="$1" line key val
  REQ_ID=""; REQ_ACTION=""; REQ_VERSION=""; REQ_RESTORE=0; REQ_ERR=""
  REQ_FILE=""; REQ_LABEL=""; REQ_SERVICE=""; REQ_LINES=""; REQ_SCHED_ENABLED=""; REQ_SCHED_HOUR=""; REQ_SCHED_KEEP=""
  [ -f "$file" ] && [ ! -L "$file" ] || { REQ_ERR="запрос не является обычным файлом"; return 1; }
  [ "$(stat -c '%s' "$file")" -le 1024 ] || { REQ_ERR="запрос слишком большой"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    [[ "$line" == *=* ]] || { REQ_ERR="строка без '='"; return 1; }
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      request_id) [[ "$val" =~ $UUID_RE ]] || { REQ_ERR="неверный request_id"; return 1; }; REQ_ID="$val" ;;
      action) case "$val" in check|update|rollback|backup|backup_verify|backup_delete|backup_export|backup_import|restore|logs|schedule|offsite_import|offsite_test|offsite_push|offsite_pull|offsite_verify|offsite_delete|offsite_refresh|offsite_clear) REQ_ACTION="$val" ;; *) REQ_ERR="недопустимое действие"; return 1 ;; esac ;;
      file) [[ "$val" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.bak\.gpg$ ]] && [[ "$val" != *..* ]] || { REQ_ERR="недопустимое имя копии"; return 1; }; REQ_FILE="$val" ;;
      label) [[ "$val" =~ ^[a-z0-9]{1,20}$ ]] || { REQ_ERR="недопустимая метка"; return 1; }; REQ_LABEL="$val" ;;
      service) case "$val" in app|db) REQ_SERVICE="$val" ;; *) REQ_ERR="недопустимая служба"; return 1 ;; esac ;;
      lines) [[ "$val" =~ ^[0-9]{2,4}$ ]] && [ "$val" -ge 10 ] && [ "$val" -le 2000 ] || { REQ_ERR="недопустимое число строк"; return 1; }; REQ_LINES="$val" ;;
      schedule_enabled) case "$val" in 0|1) REQ_SCHED_ENABLED="$val" ;; *) REQ_ERR="неверный schedule_enabled"; return 1 ;; esac ;;
      schedule_hour) [[ "$val" =~ ^[0-9]{1,2}$ ]] && [ "$val" -le 23 ] || { REQ_ERR="неверный час"; return 1; }; REQ_SCHED_HOUR="$val" ;;
      schedule_keep) [[ "$val" =~ ^[0-9]{1,2}$ ]] && [ "$val" -ge 1 ] && [ "$val" -le 90 ] || { REQ_ERR="неверное число копий"; return 1; }; REQ_SCHED_KEEP="$val" ;;
      version) [[ "$val" =~ $TAG_RE ]] || { REQ_ERR="недопустимая версия"; return 1; }; REQ_VERSION="$val" ;;
      with_restore) case "$val" in 0|1) REQ_RESTORE="$val" ;; *) REQ_ERR="неверное with_restore"; return 1 ;; esac ;;
      by) [[ "$val" =~ $UUID_RE ]] || { REQ_ERR="неверный by"; return 1; } ;;
      at) [[ "$val" =~ ^[0-9T:.Z+-]{10,40}$ ]] || { REQ_ERR="неверное время"; return 1; } ;;
      *) REQ_ERR="неизвестный параметр запроса"; return 1 ;;
    esac
  done < "$file"
  [ -n "$REQ_ID" ] && [ -n "$REQ_ACTION" ] || { REQ_ERR="не хватает обязательных параметров"; return 1; }
  if [ "$REQ_ACTION" = update ] && [ -z "$REQ_VERSION" ]; then REQ_ERR="для update нужна версия"; return 1; fi
  case "$REQ_ACTION" in
    backup_verify|backup_delete|backup_export|backup_import|restore|offsite_push|offsite_pull|offsite_verify|offsite_delete) [ -n "$REQ_FILE" ] || { REQ_ERR="не указана копия"; return 1; } ;;
    logs) [ -n "$REQ_SERVICE" ] && [ -n "$REQ_LINES" ] || { REQ_ERR="для logs нужны service и lines"; return 1; } ;;
    schedule) [ -n "$REQ_SCHED_ENABLED" ] && [ -n "$REQ_SCHED_HOUR" ] && [ -n "$REQ_SCHED_KEEP" ] || { REQ_ERR="для schedule нужны все параметры"; return 1; } ;;
  esac
  return 0
}

# ------------------------------------------------------------------ выполнение операций
status_message() { # понятное описание итога по коду состояния update.sh / rollback.sh
  case "$1" in
    success) echo "Обновление выполнено" ;;
    failed_backup) echo "Не удалось создать резервную копию. Система не изменена." ;;
    failed_build) echo "Не удалось собрать новую версию. Работающая версия не затронута." ;;
    rolled_back) echo "Обновление не удалось. Выполнен возврат на прежнюю версию, данные не изменены." ;;
    restored_from_backup) echo "Обновление не удалось. База данных восстановлена из копии, работает прежняя версия." ;;
    recovery_failed) echo "Обновление не удалось, автоматическое восстановление тоже не удалось. Требуется вмешательство администратора (scripts/rollback.sh, scripts/restore.sh)." ;;
    rolled_back_manually) echo "Откат выполнен" ;;
    *) echo "${1:-Ошибка, см. журнал}" ;;
  esac
}

clean_run() { # запуск в стерильном окружении: настройки берутся только из файла окружения
  # Домашний каталог службы — внутри каталога данных (при ProtectHome каталог /root недоступен для записи).
  local home="$STATE_DIR/home"
  mkdir -p "$home/.docker" && chmod 700 "$home"
  env -i PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME="$home" DOCKER_CONFIG="$home/.docker" LANG=C.UTF-8 \
    ARKLOCK_PROGRESS=1 ARKLOCK_UPDATE_WAIT="${ARKLOCK_UPDATE_WAIT:-240}" "$@"
}

run_logged() { # run_logged КОМАНДА… — вывод в update.log (с маскированием), отметки этапов в status.json
  local line n total name
  clean_run "$@" 2>&1 | while IFS= read -r line; do
    if [[ "$line" =~ ^ARKLOCK_STEP\ ([0-9]+)\ ([0-9]+)\ (.*)$ ]]; then
      n="${BASH_REMATCH[1]}"; total="${BASH_REMATCH[2]}"; name="${BASH_REMATCH[3]}"
      ST_NO="$n"; ST_TOTAL="$total"; ST_NAME="$name"; write_status
    fi
    printf '%s\n' "$line" | sed 's/\x1b\[[0-9;]*m//g' | mask_text_stream >> "$CH/update.log"
  done
  return "${PIPESTATUS[0]}"
}

do_check() {
  local rc status latest checked changelog migr commit
  # check-updates.sh сам фиксирует результат в состоянии; здесь формируется remote.json для интерфейса
  clean_run "$REPO_ROOT/scripts/check-updates.sh" --env "$ENV_FILE" > "$CH/.check.out" 2>&1; rc=$?
  checked="$(date -u +%FT%TZ)"; latest=""; changelog=""; migr=null
  case "$rc" in
    10) status=available; latest="$(upd_latest_tag)"
        commit="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$latest^{commit}" 2>/dev/null)"
        changelog="$(git -C "$REPO_ROOT" show "$commit:CHANGELOG.md" 2>/dev/null | head -n 80)"
        migr="$(upd_migrations_at "$commit")" ;;
    0) status=up_to_date; latest="v$(app_version)" ;;
    *) status=unreachable ;;
  esac
  printf '{"checked_at":"%s","status":"%s","latest":"%s","changelog":"%s","migrations":%s}\n' \
    "$checked" "$status" "$(jstr "$latest")" "$(jstr "$changelog")" "$migr" | atomic_write "$CH/remote.json"
  rm -f "$CH/.check.out"
  [ "$status" != unreachable ]
}

process_request() { # process_request ФАЙЛ_ЗАПРОСА
  local file="$1" rc=0
  ST_NO=0; ST_TOTAL=0; ST_NAME=""; ST_MSG=""; ST_RESULT=""; ST_FINISHED=""; ST_FROM="$(app_version)"; ST_TO=""
  if ! parse_request "$file"; then
    ST_STATE=failed; ST_ACTION=rejected; ST_REQ=""; ST_RESULT=rejected; ST_MSG="Запрос отклонён: $REQ_ERR"
    ST_STARTED="$(date -u +%FT%TZ)"; ST_FINISHED="$ST_STARTED"; write_status; history_add
    rm -f "$file"; return
  fi
  rm -f "$file"
  ST_STATE=running; ST_ACTION="$REQ_ACTION"; ST_REQ="$REQ_ID"; ST_STARTED="$(date -u +%FT%TZ)"
  [ "$REQ_ACTION" = update ] && ST_TO="${REQ_VERSION#v}"
  write_status
  : > "$CH/update.log"; chmod 644 "$CH/update.log"

  case "$REQ_ACTION" in
    backup|backup_verify|backup_delete|backup_export|backup_import|restore|logs|schedule|offsite_*)
      run_ops_action || rc=$?
      ;;
    check)
      ST_NAME="Проверка версий"; ST_NO=1; ST_TOTAL=1; write_status
      do_check || rc=1
      ST_MSG="$([ "$rc" -eq 0 ] && echo 'Проверка выполнена' || echo 'Репозиторий недоступен')" ;;
    update)
      run_logged "$REPO_ROOT/scripts/update.sh" --env "$ENV_FILE" --ref "$REQ_VERSION" --yes || rc=$?
      ST_MSG="$(status_message "$(state_get update status)")" ;;
    rollback)
      ST_NAME="Откат"; ST_NO=1; ST_TOTAL=1; write_status
      if [ "$REQ_RESTORE" = 1 ]; then run_logged "$REPO_ROOT/scripts/rollback.sh" --env "$ENV_FILE" --yes --with-restore || rc=$?
      else run_logged "$REPO_ROOT/scripts/rollback.sh" --env "$ENV_FILE" --yes || rc=$?; fi
      ST_MSG="$(status_message "$(state_get update status)")"
      [ "$rc" -ne 3 ] || ST_MSG="Автоматический откат невозможен: изменилась схема БД (см. журнал)" ;;
  esac
  ST_FINISHED="$(date -u +%FT%TZ)"
  if [ "$rc" -eq 0 ]; then ST_STATE=success; ST_RESULT=success; ST_NO="$ST_TOTAL"; else ST_STATE=failed; ST_RESULT=failed; fi
  [ -n "$ST_MSG" ] || ST_MSG="$([ "$rc" -eq 0 ] && echo 'Выполнено' || echo 'Ошибка, см. журнал')"
  # история записывается ДО итогового статуса: интерфейс, увидев завершение, сразу находит запись
  [ "$REQ_ACTION" = check ] || history_add
  write_status
}

# ------------------------------------------------------------------ резервные копии, журналы, расписание, снимки состояния
backup_path() { printf '%s/%s' "$BACKUP_DIR" "$1"; }
own_backup() { # принадлежит ли копия этому проекту (имя начинается с имени проекта) и существует ли
  [[ "$1" == "${COMPOSE_PROJECT_NAME}"-* ]] && [ -f "$(backup_path "$1")" ] && [ ! -L "$(backup_path "$1")" ]
}

run_ops_action() {
  local rc=0 f
  ST_TOTAL=1; ST_NO=1
  case "$REQ_ACTION" in
    backup)
      ST_NAME="Резервная копия"; write_status
      run_logged "$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" ${REQ_LABEL:+--label "$REQ_LABEL"} || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo 'Резервная копия создана и проверена' || echo 'Не удалось создать резервную копию, см. журнал')"
      if [ "$rc" -eq 0 ]; then offsite_after_backup && ST_MSG="$ST_MSG; копия на удалённом хранилище" || ST_MSG="$ST_MSG; ОТПРАВКА НА УДАЛЁННОЕ ХРАНИЛИЩЕ НЕ УДАЛАСЬ (см. журнал)"; fi ;;
    backup_verify)
      ST_NAME="Проверка копии"; write_status
      own_backup "$REQ_FILE" || { ST_MSG="Копия не найдена"; return 1; }
      run_logged "$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --verify "$(backup_path "$REQ_FILE")" || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия $REQ_FILE корректна" || echo "Копия $REQ_FILE НЕ прошла проверку")" ;;
    backup_import)
      # копия, загруженная в веб-интерфейсе, лежит в каталоге обмена; имя файла проверено при приёме запроса
      ST_NAME="Загрузка копии"; write_status
      [[ "$REQ_FILE" =~ ^upload-[0-9a-f-]{36}\.bak\.gpg$ ]] || { ST_MSG="Недопустимое имя загруженного файла"; return 1; }
      src="$CH/inbox/$REQ_FILE"
      [ -f "$src" ] && [ ! -L "$src" ] || { ST_MSG="Загруженный файл не найден"; return 1; }
      name="${COMPOSE_PROJECT_NAME}-uploaded-$(date -u +%Y%m%dT%H%M%SZ).bak.gpg"
      mv -f -- "$src" "$(backup_path "$name")" && chmod 600 "$(backup_path "$name")" || { ST_MSG="Не удалось принять файл"; return 1; }
      # проверка тем же ключом, что и у своих копий: копия с другого сервера откроется только с его ключом резервного шифрования
      run_logged "$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --verify "$(backup_path "$name")" || rc=$?
      if [ "$rc" -eq 0 ]; then
        ST_MSG="Копия загружена и проверена: $name"
      else
        rm -f -- "$(backup_path "$name")"
        ST_MSG="Файл не прошёл проверку: он повреждён или зашифрован другим ключом. Скопируйте на этот сервер ключ резервного шифрования исходного сервера."
        return 1
      fi ;;
    backup_delete)
      ST_NAME="Удаление копии"; write_status
      own_backup "$REQ_FILE" || { ST_MSG="Копия не найдена"; return 1; }
      f="$(backup_path "$REQ_FILE")"; rm -f -- "$f" "$f.json" "$CH/export/$REQ_FILE"
      ST_MSG="Копия $REQ_FILE удалена" ;;
    backup_export)
      ST_NAME="Подготовка копии к скачиванию"; write_status
      own_backup "$REQ_FILE" || { ST_MSG="Копия не найдена"; return 1; }
      install -d -m 0755 "$CH/export"
      f="$(backup_path "$REQ_FILE")"
      # жёсткая ссылка не занимает места; права на исходник возвращаются при очистке
      ln -f -- "$f" "$CH/export/$REQ_FILE" 2>/dev/null || cp -f -- "$f" "$CH/export/$REQ_FILE" || rc=1
      chmod 644 "$CH/export/$REQ_FILE" 2>/dev/null || true
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия готова к скачиванию на 10 минут" || echo "Не удалось подготовить копию")" ;;
    restore)
      ST_NAME="Восстановление из копии"; write_status
      own_backup "$REQ_FILE" || { ST_MSG="Копия не найдена"; return 1; }
      run_logged "$REPO_ROOT/scripts/restore.sh" "$(backup_path "$REQ_FILE")" --env "$ENV_FILE" --yes || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "База данных восстановлена из $REQ_FILE" || echo "Восстановление не удалось, см. журнал (аварийная копия создана до начала)")" ;;
    logs)
      ST_NAME="Журналы контейнера"; write_status
      clean_run "$REPO_ROOT/scripts/logs.sh" --env "$ENV_FILE" "$REQ_SERVICE" -n "$REQ_LINES" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | mask_text_stream | tail -c 300000 | atomic_write "$CH/logs.txt" || rc=1
      printf '%s\n' "$REQ_SERVICE" | atomic_write "$CH/logs.service"
      ST_MSG="Журнал получен" ;;
    offsite_import)
      ST_NAME="Удалённое хранилище: настройка"; write_status
      [ -f "$CH/offsite-config.in" ] && [ ! -L "$CH/offsite-config.in" ] || { ST_MSG="Файл настройки не найден"; return 1; }
      # перенос во внутренний каталог: файл с секретами не остаётся в общем каталоге обмена
      install -d -m 0700 "$STATE_DIR/offsite"
      mv -f -- "$CH/offsite-config.in" "$STATE_DIR/offsite/config.in" && chmod 600 "$STATE_DIR/offsite/config.in"
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" import "$STATE_DIR/offsite/config.in" || rc=$?
      rm -f -- "$STATE_DIR/offsite/config.in"
      ST_MSG="$([ "$rc" -eq 0 ] && echo 'Настройка удалённого хранилища сохранена' || echo 'Настройка отклонена, см. журнал')"
      offsite_publish 1 ;;
    offsite_test)
      ST_NAME="Удалённое хранилище: проверка соединения"; write_status
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" test || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo 'Соединение проверено: запись, чтение и удаление работают' || echo 'Соединение не проверено, см. журнал')" ;;
    offsite_push)
      ST_NAME="Отправка копии на удалённое хранилище"; write_status
      own_backup "$REQ_FILE" || { ST_MSG="Копия не найдена"; return 1; }
      offsite_push_file "$REQ_FILE" || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия $REQ_FILE отправлена и проверена на хранилище" || echo 'Отправка не удалась, см. журнал')"
      offsite_publish 1 ;;
    offsite_pull)
      ST_NAME="Загрузка копии с удалённого хранилища"; write_status
      [[ "$REQ_FILE" == "${COMPOSE_PROJECT_NAME}"-* ]] || { ST_MSG="Копия другого проекта"; return 1; }
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" pull "$REQ_FILE" "$BACKUP_DIR" || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия $REQ_FILE загружена и проверена" || echo 'Загрузка не удалась, см. журнал')"
      publish_backups ;;
    offsite_verify)
      ST_NAME="Проверка копии на удалённом хранилище"; write_status
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" verify "$REQ_FILE" || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия $REQ_FILE на хранилище цела" || echo "Копия $REQ_FILE на хранилище НЕ прошла проверку")" ;;
    offsite_delete)
      ST_NAME="Удаление копии на удалённом хранилище"; write_status
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" delete "$REQ_FILE" || rc=$?
      ST_MSG="$([ "$rc" -eq 0 ] && echo "Копия $REQ_FILE удалена с хранилища" || echo 'Удаление не удалось, см. журнал')"
      offsite_publish 1 ;;
    offsite_refresh)
      ST_NAME="Удалённое хранилище: список копий"; write_status
      offsite_publish 1
      ST_MSG="Список обновлён" ;;
    offsite_clear)
      ST_NAME="Удалённое хранилище: удаление настройки"; write_status
      run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" clear || rc=$?
      offsite_publish 1
      ST_MSG="Настройка и секреты удалены с этого сервера" ;;
    schedule)
      ST_NAME="Расписание копий"; write_status
      state_set backup sched_enabled "$REQ_SCHED_ENABLED"; state_set backup sched_hour "$REQ_SCHED_HOUR"; state_set backup sched_keep "$REQ_SCHED_KEEP"
      publish_schedule
      ST_MSG="Расписание сохранено" ;;
  esac
  return "$rc"
}

# ------------------------------------------------------------------ удалённое хранилище копий (S3 / SMB)
offsite_conf() { printf '%s' "${ARKLOCK_REMOTE_CONF:-$(dirname "$ENV_FILE")/remote.conf}"; }
offsite_configured() { [ -s "$(offsite_conf)" ]; }
offsite_setting() { # offsite_setting КЛЮЧ — значение без секретов из «remote.sh show»
  "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" show 2>/dev/null | sed -n "s/^$1=//p" | head -n1
}

# Отправляет копию, затем применяет ротацию на хранилище; итог фиксируется в состоянии.
offsite_push_file() { # offsite_push_file ИМЯ
  local name="$1" rc=0 keep
  run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" push "$(backup_path "$name")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    keep="$(offsite_setting keep)"; keep="${keep:-14}"
    run_logged "$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" prune "$keep" || true
    state_set offsite last_result ok; state_set offsite last_error ""
  else
    state_set offsite last_result failed; state_set offsite last_error "отправка не удалась"
  fi
  state_set offsite last_at "$(date -u +%FT%TZ)"; state_set offsite last_file "$name"
  return "$rc"
}

# После успешной копии: если автоматическая отправка включена, отправить последнюю. Код 0 и при выключенной отправке.
offsite_after_backup() {
  offsite_configured || return 0
  [ "$(offsite_setting auto)" = 1 ] || return 0
  local name; name="$(state_get backup last_file)"
  [ -n "$name" ] && own_backup "$name" || return 0
  local rc=0
  offsite_push_file "$name" || rc=$?
  offsite_publish 1
  return "$rc"
}

# Снимок для интерфейса: настройка без секретов, итог последней отправки и (при list=1 либо раз в 30 минут) список копий.
OFFSITE_LISTED_AT=0
offsite_publish() { # offsite_publish [1 — обновить список]
  local force="${1:-0}" now conf="false" typ="" ep="" region="" bucket="" prefix="" host="" share="" user="" auto=0 keep=14 items="[]" lerr="" listed=""
  now="$(date +%s)"
  if offsite_configured; then
    conf="true"
    local line k v
    while IFS= read -r line; do
      k="${line%%=*}"; v="${line#*=}"
      case "$k" in type) typ="$v" ;; endpoint) ep="$v" ;; region) region="$v" ;; bucket) bucket="$v" ;; prefix) prefix="$v" ;; host) host="$v" ;; share) share="$v" ;; user) user="$v" ;; auto) auto="$v" ;; keep) keep="$v" ;; esac
    done < <("$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" show 2>/dev/null)
    if [ "$force" = 1 ] || [ $((now - OFFSITE_LISTED_AT)) -ge 1800 ]; then
      OFFSITE_LISTED_AT="$now"
      local out first=1
      if out="$("$REPO_ROOT/scripts/remote.sh" --env "$ENV_FILE" list 2>"$STATE_DIR/offsite/list.err")"; then
        items="["
        while read -r name size _; do
          [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.bak\.gpg$ ]] || continue
          [ "$first" = 1 ] || items+=","
          first=0; items+="{\"name\":\"$(jstr "$name")\",\"size\":${size:-0}}"
        done <<< "$out"
        items+="]"
        listed="$(date -u +%FT%TZ)"
      else
        lerr="$(tail -n 1 "$STATE_DIR/offsite/list.err" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | mask_text_stream | cut -c1-200)"
        lerr="${lerr:-список не получен}"
      fi
      printf '%s\n' "$items" > "$STATE_DIR/offsite/items.json"
      printf '%s\n' "$listed" > "$STATE_DIR/offsite/listed_at"; printf '%s\n' "$lerr" > "$STATE_DIR/offsite/list_error"
    else
      items="$(cat "$STATE_DIR/offsite/items.json" 2>/dev/null || echo '[]')"
      listed="$(cat "$STATE_DIR/offsite/listed_at" 2>/dev/null || true)"; lerr="$(cat "$STATE_DIR/offsite/list_error" 2>/dev/null || true)"
    fi
  fi
  printf '{"configured":%s,"type":"%s","endpoint":"%s","region":"%s","bucket":"%s","prefix":"%s","host":"%s","share":"%s","user":"%s","auto":%s,"keep":%s,"last_at":"%s","last_result":"%s","last_file":"%s","last_error":"%s","listed_at":"%s","list_error":"%s","items":%s}\n' \
    "$conf" "$(jstr "$typ")" "$(jstr "$ep")" "$(jstr "$region")" "$(jstr "$bucket")" "$(jstr "$prefix")" "$(jstr "$host")" "$(jstr "$share")" "$(jstr "$user")" \
    "$([ "${auto:-0}" = 1 ] && echo true || echo false)" "${keep:-14}" \
    "$(jstr "$(state_get offsite last_at)")" "$(jstr "$(state_get offsite last_result)")" "$(jstr "$(state_get offsite last_file)")" "$(jstr "$(state_get offsite last_error)")" \
    "$(jstr "$listed")" "$(jstr "$lerr")" "$items" | atomic_write "$CH/offsite.json"
}

publish_schedule() {
  local en hour keep last
  en="$(state_get backup sched_enabled)"; hour="$(state_get backup sched_hour)"; keep="$(state_get backup sched_keep)"; last="$(state_get backup sched_last_at)"
  printf '{"enabled":%s,"hour":%s,"keep":%s,"last_at":"%s","last_result":"%s"}\n' \
    "$([ "${en:-0}" = 1 ] && echo true || echo false)" "${hour:-3}" "${keep:-14}" "$(jstr "$last")" "$(jstr "$(state_get backup sched_last_result)")" | atomic_write "$CH/schedule.json"
}

publish_backups() {
  local first=1 f name size mtime sha ver mig
  {
    printf '{"dir":"%s","free_gib":%s,"items":[' "$(jstr "$BACKUP_DIR")" "$(free_gib "$BACKUP_DIR" 2>/dev/null || echo 0)"
    # shellcheck disable=SC2012
    for f in $(ls -1t "$BACKUP_DIR/${COMPOSE_PROJECT_NAME}"-*.bak.gpg 2>/dev/null | head -n 200); do
      name="$(basename "$f")"; size="$(stat -c '%s' "$f" 2>/dev/null || echo 0)"; mtime="$(date -u -d "@$(stat -c '%Y' "$f" 2>/dev/null || echo 0)" +%FT%TZ)"
      sha="$(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$f.json" 2>/dev/null | head -n1)"
      ver="$(sed -n 's/.*"appVersion": *"\([^"]*\)".*/\1/p' "$f.json" 2>/dev/null | head -n1)"
      mig="$(sed -n 's/.*"migrations": *\([0-9]*\).*/\1/p' "$f.json" 2>/dev/null | head -n1)"
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"name":"%s","size":%s,"created_at":"%s","sha256":"%s","version":"%s","migrations":%s}' "$(jstr "$name")" "$size" "$mtime" "$(jstr "$sha")" "$(jstr "$ver")" "${mig:-0}"
    done
    printf ']}\n'
  } | atomic_write "$CH/backups.json"
}

publish_containers() {
  local first=1 id line stats
  stats="$(docker stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null || true)"
  {
    printf '{"items":['
    for id in $(dc ps -aq 2>/dev/null); do
      line="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id" 2>/dev/null)" || continue
      IFS='|' read -r svc img st health started restarts <<< "$line"
      cpu="$(printf '%s\n' "$stats" | awk -F'|' -v i="${id:0:12}" '$1==i {print $2}')"; mem="$(printf '%s\n' "$stats" | awk -F'|' -v i="${id:0:12}" '$1==i {print $3}')"
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"service":"%s","image":"%s","state":"%s","health":"%s","started_at":"%s","restarts":%s,"cpu":"%s","memory":"%s"}' \
        "$(jstr "$svc")" "$(jstr "$img")" "$(jstr "$st")" "$(jstr "$health")" "$(jstr "$started")" "${restarts:-0}" "$(jstr "$cpu")" "$(jstr "$mem")"
    done
    printf '],"at":"%s"}\n' "$(date -u +%FT%TZ)"
  } | atomic_write "$CH/containers.json"
}

cleanup_exports() { # копии, подготовленные к скачиванию, живут 10 минут
  local f
  [ -d "$CH/export" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$BACKUP_DIR/$(basename "$f")" ] && chmod 600 "$BACKUP_DIR/$(basename "$f")" 2>/dev/null
    rm -f -- "$f"
  done < <(find "$CH/export" -maxdepth 1 -type f -mmin +10 2>/dev/null)
}

scheduled_backup_due() {
  local en hour today
  en="$(state_get backup sched_enabled)"; [ "$en" = 1 ] || return 1
  hour="$(state_get backup sched_hour)"; hour="${hour:-3}"; today="$(date +%F)"
  [ "$(state_get backup sched_last_date)" != "$today" ] || return 1
  [ "$((10#$(date +%H)))" -ge "$((10#$hour))" ]
}

run_scheduled_backup() {
  local rc=0 keep
  keep="$(state_get backup sched_keep)"; keep="${keep:-14}"
  # отметка до запуска: сбой не приводит к бесконечным повторам в течение дня
  state_set backup sched_last_date "$(date +%F)"
  ST_STATE=running; ST_ACTION=backup; ST_REQ=""; ST_NO=1; ST_TOTAL=1; ST_NAME="Резервная копия по расписанию"; ST_MSG=""; ST_RESULT=""
  ST_FROM="$(app_version)"; ST_TO=""; ST_STARTED="$(date -u +%FT%TZ)"; ST_FINISHED=""; write_status
  : > "$CH/update.log"; chmod 644 "$CH/update.log"
  run_logged "$REPO_ROOT/scripts/backup.sh" --env "$ENV_FILE" --label auto --keep "$keep" || rc=$?
  ST_FINISHED="$(date -u +%FT%TZ)"
  if [ "$rc" -eq 0 ]; then
    ST_STATE=success; ST_RESULT=success; ST_MSG="Резервная копия по расписанию создана"
    offsite_after_backup || ST_MSG="$ST_MSG; ОТПРАВКА НА УДАЛЁННОЕ ХРАНИЛИЩЕ НЕ УДАЛАСЬ (см. журнал)"
  else ST_STATE=failed; ST_RESULT=failed; ST_MSG="Копия по расписанию не создана, см. журнал"; fi
  state_set backup sched_last_at "$ST_FINISHED"; state_set backup sched_last_result "$ST_RESULT"
  history_add; write_status; publish_schedule; publish_backups
}

# ------------------------------------------------------------------ рабочий цикл
cmd_run() {
  ensure_channel
  local last_sum cur_sum
  last_sum="$(sha256sum "$SRC_SCRIPT" 2>/dev/null | cut -d' ' -f1)"
  [ -f "$CH/status.json" ] || write_status
  # Прерванная ранее операция: если помощник был остановлен посреди работы, статус «running» недостоверен.
  if grep -q '"state":"running"' "$CH/status.json" 2>/dev/null; then
    ST_STATE=failed; ST_ACTION="$(sed -n 's/.*"action":"\([^"]*\)".*/\1/p' "$CH/status.json")"; ST_RESULT=interrupted
    ST_MSG="Операция была прервана (перезапуск помощника или сервера). Выполните проверку: scripts/verify.sh; при необходимости scripts/rollback.sh."
    ST_FINISHED="$(date -u +%FT%TZ)"; write_status; history_add
  fi
  rm -f "$CH/request.processing"
  info "Помощник обновлений запущен (проект $COMPOSE_PROJECT_NAME)"
  local tick=0
  while true; do
    heartbeat
    # снимки состояния: раз в ~10 секунд; копии — также сразу после операций
    if [ $((tick % 5)) -eq 0 ]; then publish_containers; publish_backups; publish_schedule; cleanup_exports; fi
    tick=$((tick + 1))
    if [ -e "$CH/request.txt" ] || [ -L "$CH/request.txt" ]; then
      if [ -L "$CH/request.txt" ]; then rm -f "$CH/request.txt"
      else
        mv -f "$CH/request.txt" "$CH/request.processing" 2>/dev/null && process_request "$CH/request.processing"
        publish_backups; publish_schedule; publish_containers
        # Помощник сам мог быть обновлён операцией: перезапуск из свежей копии
        cur_sum="$(sha256sum "$REPO_ROOT/scripts/updater.sh" 2>/dev/null | cut -d' ' -f1)"
        if [ -n "$cur_sum" ] && [ "$cur_sum" != "$last_sum" ]; then
          info "Сценарий помощника обновлён — перезапуск"
          rm -rf "${ARKLOCK_UPDATER_RUNDIR:-}"
          exec env -u ARKLOCK_UPDATER_COPY -u ARKLOCK_REPO_ROOT "$REPO_ROOT/scripts/updater.sh" run --env "$ENV_FILE"
        fi
      fi
    elif scheduled_backup_due; then
      run_scheduled_backup
    fi
    sleep 2
  done
}

# ------------------------------------------------------------------ служба systemd
unit_text() {
  cat <<EOF
[Unit]
Description=Arklock update helper (${COMPOSE_PROJECT_NAME})
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${REPO_ROOT}/scripts/updater.sh run --env ${ENV_FILE}
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
}

heartbeat_age() { # секунд с последнего пульса, пусто — нет пульса
  local ts
  ts="$(sed -n 's/.*"ts":\([0-9]*\).*/\1/p' "$CH/helper.json" 2>/dev/null)"
  [ -n "$ts" ] && echo $(( $(date +%s) - ts ))
}

cmd_install() {
  need_root; need_cmd systemctl
  ensure_channel
  [ -f "$CH/history.jsonl" ] || : > "$CH/history.jsonl"
  # файлы обмена должны быть читаемы приложением независимо от umask вызывающего
  chmod 644 "$CH/history.jsonl"
  unit_text > "$UNIT_FILE.new"
  if [ ! -f "$UNIT_FILE" ] || ! cmp -s "$UNIT_FILE" "$UNIT_FILE.new"; then mv -f "$UNIT_FILE.new" "$UNIT_FILE"; systemctl daemon-reload; else rm -f "$UNIT_FILE.new"; fi
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl restart "$UNIT"
  local age
  for _ in $(seq 1 30); do
    age="$(heartbeat_age)"
    if [ -n "$age" ] && [ "$age" -lt 10 ]; then ok "Помощник обновлений запущен (служба $UNIT)"; return 0; fi
    sleep 1
  done
  fail "Служба запущена, но пульс помощника не обнаружен: journalctl -u $UNIT"; return 1
}

cmd_status() {
  local active age
  active="$(systemctl is-active "$UNIT" 2>/dev/null || true)"; age="$(heartbeat_age)"
  echo "Служба:      $UNIT — ${active:-неизвестно}"
  echo "Пульс:       ${age:+$age с назад}${age:-нет}"
  [ "$active" = active ] && [ -n "$age" ] && [ "$age" -lt "$HEARTBEAT_MAX_AGE" ]
}

cmd_repair() {
  need_root
  ensure_channel
  local age
  age="$(heartbeat_age)"
  if [ ! -f "$UNIT_FILE" ] || ! cmp -s "$UNIT_FILE" <(unit_text) || ! systemctl is-active --quiet "$UNIT" || [ -z "$age" ] || [ "$age" -ge "$HEARTBEAT_MAX_AGE" ]; then
    info "Восстановление службы помощника"; cmd_install
  else ok "Помощник исправен"; fi
}

cmd_uninstall() {
  need_root
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"; systemctl daemon-reload
  ok "Служба $UNIT удалена (данные и история сохранены в $CH)"
}

# Режим «только функции» — для тестов разбора запроса (tests/updater/test-parse.sh).
if [ "${ARKLOCK_UPDATER_LIB_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

CMD="${1:-status}"; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
CH="$DATA_ROOT/updater"
UNIT="arklock-updater-${COMPOSE_PROJECT_NAME}"
UNIT_FILE="${UPDATER_UNIT_DIR:-/etc/systemd/system}/$UNIT.service"
SRC_SCRIPT="${ARKLOCK_UPDATER_SRC:-$SCRIPT_DIR}/updater.sh"

case "$CMD" in
  run) cmd_run ;;
  install) cmd_install ;;
  status) cmd_status ;;
  repair) cmd_repair ;;
  uninstall) cmd_uninstall ;;
  print-unit) unit_text ;;
  *) die "Неизвестная команда: $CMD" ;;
esac
