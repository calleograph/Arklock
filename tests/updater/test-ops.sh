#!/usr/bin/env bash
# Проверка действий помощника с резервными копиями, журналами и расписанием на работающей установке.
#   tests/updater/test-ops.sh КАТАЛОГ_ДАННЫХ [ФАЙЛ_ОКРУЖЕНИЯ]
# Запросы кладутся в каталог обмена так же, как это делает веб-приложение. Требуются права sudo.
set -euo pipefail
DATA="${1:?каталог данных}"
ENVF="${2:-}"
CH="$DATA/updater"
FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
rd() { sudo cat "$1" 2>/dev/null || true; }
# has ФАЙЛ ШАБЛОН — содержит ли файл подстроку (без конвейера: grep -q при pipefail даёт ложные отказы)
has() { local c; c="$(rd "$1")"; [[ "$c" == *"$2"* ]]; }

# send ДЕЙСТВИЕ [ПАРАМЕТР=ЗНАЧЕНИЕ…] — ставит запрос и ждёт завершения именно этого запроса
send() {
  local id=""
  id="$(cat /proc/sys/kernel/random/uuid)"
  { echo "request_id=$id"; for l in "$@"; do echo "$l"; done; } | sudo tee "$CH/request.new" > /dev/null
  sudo mv "$CH/request.new" "$CH/request.txt"
  for _ in $(seq 1 240); do
    if has "$CH/status.json" "\"request_id\":\"$id\"" && ! has "$CH/status.json" '"state":"running"'; then return 0; fi
    sleep 1
  done
  echo "запрос не завершился за 240 с: $(rd "$CH/status.json")"
  return 1
}
state() { rd "$CH/status.json" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'; }
message() { rd "$CH/status.json" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p'; }

# 1. Снимок контейнеров: только контейнеры проекта (app и db), без чужих
for _ in $(seq 1 30); do has "$CH/containers.json" '"service":"db"' && break; sleep 1; done
svcs="$(rd "$CH/containers.json" | jq -r '.items[].service' | sort | tr '\n' ' ')"
[ "$svcs" = "app db " ] && ok "containers.json: только app и db" || bad "containers.json: '$svcs'"

# 2. Копия: создаётся, проверяется, попадает в снимок
send action=backup label=ci && [ "$(state)" = success ] && ok "backup создан" || bad "backup: $(message)"
name="$(rd "$CH/backups.json" | jq -r '.items[0].name')"
case "$name" in *-ci.bak.gpg) ok "в списке копий: $name" ;; *) bad "backups.json: '$name'" ;; esac
size="$(rd "$CH/backups.json" | jq -r '.items[0].size')"
[ "${size:-0}" -gt 100 ] && ok "размер копии $size" || bad "размер копии '$size'"

send action=backup_verify "file=$name" && [ "$(state)" = success ] && ok "backup_verify" || bad "backup_verify: $(message)"

# 3. Чужая или несуществующая копия отклоняется без последствий
send action=backup_delete "file=${COMPOSE_PROJECT_NAME:-arklock}-nonexistent.bak.gpg" || true
[ "$(state)" = failed ] && ok "несуществующая копия: отказ ($(message))" || bad "несуществующая копия принята"
send action=backup_delete "file=foreign-project-1.bak.gpg" || true
[ "$(state)" = failed ] && ok "копия другого проекта: отказ" || bad "копия другого проекта принята"

# 4. Расписание
send action=schedule schedule_enabled=1 schedule_hour=3 schedule_keep=5 && [ "$(state)" = success ] && ok "schedule" || bad "schedule: $(message)"
[ "$(rd "$CH/schedule.json" | jq -r '.enabled,.hour,.keep' | tr '\n' ' ')" = "true 3 5 " ] && ok "schedule.json" || bad "schedule.json: $(rd "$CH/schedule.json")"

# расписание нужно только для проверки сохранения: выключаем, чтобы не мешать остальным шагам CI
send action=schedule schedule_enabled=0 schedule_hour=3 schedule_keep=5 && [ "$(state)" = success ] && ok "schedule выключено" || bad "schedule off: $(message)"

# 5. Журналы: получены и не содержат секретов из файла окружения
send action=logs service=app lines=100 && [ "$(state)" = success ] && ok "logs app" || bad "logs: $(message)"
[ -n "$(rd "$CH/logs.txt")" ] && ok "журнал не пуст" || bad "журнал пуст"
if [ -n "$ENVF" ]; then
  pw="$(sudo sed -n 's/^POSTGRES_PASSWORD=//p' "$ENVF")"
  sec="$(sudo sed -n 's/^APP_SECRET=//p' "$ENVF")"
  if [ -n "$pw" ] && has "$CH/logs.txt" "$pw"; then bad "пароль БД в журнале"; else ok "пароль БД в журнале не найден"; fi
  if [ -n "$sec" ] && has "$CH/logs.txt" "$sec"; then bad "APP_SECRET в журнале"; else ok "APP_SECRET в журнале не найден"; fi
fi

# 6. Подготовка к скачиванию и удаление
send action=backup_export "file=$name" && [ "$(state)" = success ] && ok "backup_export" || bad "backup_export: $(message)"
sudo test -f "$CH/export/$name" && ok "копия подготовлена" || bad "нет $CH/export/$name"
send action=backup_delete "file=$name" && [ "$(state)" = success ] && ok "backup_delete" || bad "backup_delete: $(message)"
sudo test ! -e "$CH/export/$name" && ok "подготовленная копия убрана" || bad "подготовленная копия осталась"
sleep 12
has "$CH/backups.json" "$name" && bad "копия осталась в списке" || ok "копия исчезла из списка"

[ "$FAILS" -eq 0 ] || { echo "Не пройдено: $FAILS"; exit 1; }
echo "Действия помощника проверены"
