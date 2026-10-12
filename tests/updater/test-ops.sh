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

# 5а. Удалённое хранилище (S3): настройка из веб-интерфейса, проверка, автоматическая отправка, проверка целостности, ротация
if [ -n "${OFFSITE_ENDPOINT:-}" ]; then
  b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
  {
    echo "type=$(b64 s3)"; echo "endpoint=$(b64 "$OFFSITE_ENDPOINT")"; echo "region=$(b64 us-east-1)"; echo "bucket=$(b64 "$OFFSITE_BUCKET")"
    echo "prefix=$(b64 ci/web)"; echo "access_key=$(b64 "$OFFSITE_ACCESS")"; echo "secret_key=$(b64 "$OFFSITE_SECRET")"
    echo "allow_http=$(b64 1)"; echo "auto=$(b64 1)"; echo "keep=$(b64 2)"
  } | sudo tee "$CH/offsite-config.in" > /dev/null
  sudo chmod 600 "$CH/offsite-config.in"
  send action=offsite_import && [ "$(state)" = success ] && ok "offsite_import" || bad "offsite_import: $(message)"
  sudo test ! -e "$CH/offsite-config.in" && ok "файл настройки с секретами не остался в общем каталоге" || bad "файл настройки остался в $CH"
  [ "$(rd "$CH/offsite.json" | jq -r '.configured,.type,.bucket,.keep' | tr '\n' ' ')" = "true s3 $OFFSITE_BUCKET 2 " ] && ok "offsite.json" || bad "offsite.json: $(rd "$CH/offsite.json")"
  if has "$CH/offsite.json" "$OFFSITE_SECRET"; then bad "секрет в offsite.json"; else ok "секрета нет в снимке"; fi
  if has "$CH/history.jsonl" "$OFFSITE_SECRET" || has "$CH/update.log" "$OFFSITE_SECRET"; then bad "секрет в журнале помощника"; else ok "секрета нет в журнале помощника"; fi
  send action=offsite_test && [ "$(state)" = success ] && ok "offsite_test" || bad "offsite_test: $(message)"
  # копия по запросу уходит на хранилище автоматически (auto=1)
  send action=backup label=remote && [ "$(state)" = success ] && ok "backup с отправкой" || bad "backup: $(message)"
  rname="$(rd "$CH/backups.json" | jq -r '.items[0].name')"
  [ "$(rd "$CH/offsite.json" | jq -r --arg n "$rname" '[.items[].name] | index($n) != null')" = true ] && ok "копия $rname на хранилище" || bad "копии нет на хранилище: $(rd "$CH/offsite.json")"
  [ "$(rd "$CH/offsite.json" | jq -r '.last_result')" = ok ] && ok "итог последней отправки: ok" || bad "итог отправки: $(rd "$CH/offsite.json")"
  send action=offsite_verify "file=$rname" && [ "$(state)" = success ] && ok "offsite_verify" || bad "offsite_verify: $(message)"
  # ротация на хранилище: храним 2, третья копия вытесняет самую старую
  send action=backup label=remote2 && send action=backup label=remote3 && ok "ещё две копии" || bad "ещё копии: $(message)"
  send action=offsite_refresh && [ "$(state)" = success ] || bad "offsite_refresh: $(message)"
  [ "$(rd "$CH/offsite.json" | jq -r '[.items[] | select(.name | contains("-remote"))] | length')" = 2 ] && ok "ротация на хранилище: осталось 2" || bad "ротация: $(rd "$CH/offsite.json" | jq -c '[.items[].name]')"
  send action=offsite_delete "file=$rname" || true
  # самая старая могла быть уже вытеснена: удаление отсутствующего объекта не ошибка
  send action=offsite_clear && [ "$(state)" = success ] && ok "offsite_clear" || bad "offsite_clear: $(message)"
  [ "$(rd "$CH/offsite.json" | jq -r '.configured')" = false ] && ok "настройка и секреты удалены" || bad "после clear: $(rd "$CH/offsite.json")"
  sudo test ! -e "$(dirname "$ENVF")/remote.conf" && ok "remote.conf стёрт" || bad "remote.conf остался"
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
