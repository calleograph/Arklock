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
#   check (проверка версий), update vX.Y.Z, rollback [с восстановлением БД].
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
    "$(date -u +%FT%TZ)" "$ST_ACTION" "$ST_RESULT" "$(jstr "$ST_FROM")" "$(jstr "$ST_TO")" "$(jstr "$ST_MSG")" >> "$CH/history.jsonl"
  # журнал истории ограничен по размеру
  if [ "$(wc -l < "$CH/history.jsonl")" -gt 500 ]; then tail -n 300 "$CH/history.jsonl" > "$CH/.history.tmp" && mv -f "$CH/.history.tmp" "$CH/history.jsonl"; fi
}

# ------------------------------------------------------------------ разбор и проверка запроса
# Результат: REQ_ID, REQ_ACTION, REQ_VERSION, REQ_RESTORE. Возвращает 0 только для корректного запроса.
parse_request() { # parse_request ФАЙЛ
  local file="$1" line key val
  REQ_ID=""; REQ_ACTION=""; REQ_VERSION=""; REQ_RESTORE=0; REQ_ERR=""
  [ -f "$file" ] && [ ! -L "$file" ] || { REQ_ERR="запрос не является обычным файлом"; return 1; }
  [ "$(stat -c '%s' "$file")" -le 1024 ] || { REQ_ERR="запрос слишком большой"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    [[ "$line" == *=* ]] || { REQ_ERR="строка без '='"; return 1; }
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      request_id) [[ "$val" =~ $UUID_RE ]] || { REQ_ERR="неверный request_id"; return 1; }; REQ_ID="$val" ;;
      action) case "$val" in check|update|rollback) REQ_ACTION="$val" ;; *) REQ_ERR="недопустимое действие"; return 1 ;; esac ;;
      version) [[ "$val" =~ $TAG_RE ]] || { REQ_ERR="недопустимая версия"; return 1; }; REQ_VERSION="$val" ;;
      with_restore) case "$val" in 0|1) REQ_RESTORE="$val" ;; *) REQ_ERR="неверное with_restore"; return 1 ;; esac ;;
      by) [[ "$val" =~ $UUID_RE ]] || { REQ_ERR="неверный by"; return 1; } ;;
      at) [[ "$val" =~ ^[0-9T:.Z+-]{10,40}$ ]] || { REQ_ERR="неверное время"; return 1; } ;;
      *) REQ_ERR="неизвестный параметр запроса"; return 1 ;;
    esac
  done < "$file"
  [ -n "$REQ_ID" ] && [ -n "$REQ_ACTION" ] || { REQ_ERR="не хватает обязательных параметров"; return 1; }
  if [ "$REQ_ACTION" = update ] && [ -z "$REQ_VERSION" ]; then REQ_ERR="для update нужна версия"; return 1; fi
  return 0
}

# ------------------------------------------------------------------ выполнение операций
clean_run() { # запуск в стерильном окружении: настройки берутся только из файла окружения
  env -i PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root LANG=C.UTF-8 \
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
    check)
      ST_NAME="Проверка версий"; ST_NO=1; ST_TOTAL=1; write_status
      do_check || rc=1
      ST_MSG="$([ "$rc" -eq 0 ] && echo 'Проверка выполнена' || echo 'Репозиторий недоступен')" ;;
    update)
      run_logged "$REPO_ROOT/scripts/update.sh" --env "$ENV_FILE" --ref "$REQ_VERSION" --yes || rc=$?
      ST_MSG="$(state_get update status)" ;;
    rollback)
      ST_NAME="Откат"; ST_NO=1; ST_TOTAL=1; write_status
      if [ "$REQ_RESTORE" = 1 ]; then run_logged "$REPO_ROOT/scripts/rollback.sh" --env "$ENV_FILE" --yes --with-restore || rc=$?
      else run_logged "$REPO_ROOT/scripts/rollback.sh" --env "$ENV_FILE" --yes || rc=$?; fi
      ST_MSG="$(state_get update status)"
      [ "$rc" -ne 3 ] || ST_MSG="Автоматический откат невозможен: изменилась схема БД (см. журнал)" ;;
  esac
  ST_FINISHED="$(date -u +%FT%TZ)"
  if [ "$rc" -eq 0 ]; then ST_STATE=success; ST_RESULT=success; ST_NO="$ST_TOTAL"; else ST_STATE=failed; ST_RESULT=failed; fi
  [ -n "$ST_MSG" ] || ST_MSG="$([ "$rc" -eq 0 ] && echo 'Выполнено' || echo 'Ошибка, см. журнал')"
  write_status
  [ "$REQ_ACTION" = check ] || history_add
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
  while true; do
    heartbeat
    if [ -e "$CH/request.txt" ] || [ -L "$CH/request.txt" ]; then
      if [ -L "$CH/request.txt" ]; then rm -f "$CH/request.txt"
      else
        mv -f "$CH/request.txt" "$CH/request.processing" 2>/dev/null && process_request "$CH/request.processing"
        # Помощник сам мог быть обновлён операцией: перезапуск из свежей копии
        cur_sum="$(sha256sum "$REPO_ROOT/scripts/updater.sh" 2>/dev/null | cut -d' ' -f1)"
        if [ -n "$cur_sum" ] && [ "$cur_sum" != "$last_sum" ]; then
          info "Сценарий помощника обновлён — перезапуск"
          rm -rf "${ARKLOCK_UPDATER_RUNDIR:-}"
          exec env -u ARKLOCK_UPDATER_COPY -u ARKLOCK_REPO_ROOT "$REPO_ROOT/scripts/updater.sh" run --env "$ENV_FILE"
        fi
      fi
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
