#!/usr/bin/env bash
# verify.sh — проверка установленного экземпляра Arklock (только чтение, ничего не меняет).
#   scripts/verify.sh [--env ФАЙЛ]
# Код возврата: 0 — ошибок нет (предупреждения возможны), 1 — есть ошибки.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance

ERR=0; WARN=0
pass() { ok "$*"; }
bad()  { fail "$*"; ERR=$((ERR + 1)); }
note() { warn "$*"; WARN=$((WARN + 1)); }

# --- контейнеры
for svc in db app; do
  cid="$(dc ps -q "$svc" 2>/dev/null | head -n 1)"
  if [ -z "$cid" ]; then bad "Контейнер $svc не запущен"; continue; fi
  state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
  if [ "$state" = running ] && [ "$health" = healthy ]; then pass "Контейнер $svc: работает, healthcheck пройден"
  else bad "Контейнер $svc: состояние=$state, healthcheck=$health"; fi
done

# --- API
base="$(app_url_local)"
if curl -fsS --max-time 5 "$base/api/v1/health" >/dev/null 2>&1; then pass "API: /health"; else bad "API: /health не отвечает"; fi
if ready="$(curl -fsS --max-time 5 "$base/api/v1/ready" 2>/dev/null)"; then pass "API: /ready — $ready"; else bad "API: /ready — приложение не готово (БД недоступна?)"; fi
ver_json="$(curl -fsS --max-time 5 "$base/api/v1/version" 2>/dev/null || true)"
if [ -n "$ver_json" ]; then
  running="$(printf '%s' "$ver_json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  commit="$(printf '%s' "$ver_json" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
  if [ "$running" = "$(app_version)" ]; then pass "Версия работающего приложения: $running (commit ${commit:0:12})"
  else bad "Версия приложения ($running) не совпадает с файлом VERSION ($(app_version)): пересоберите образ"; fi
  [ "$commit" != unknown ] || note "commit сборки неизвестен (образ собран вне штатной сборки)"
else bad "API: /version не отвечает"; fi
if curl -fsS --max-time 5 "$base/" 2>/dev/null | grep -q '<div id="app">'; then pass "Веб-интерфейс отдаётся"; else bad "Веб-интерфейс не отдаётся"; fi

# --- доступ для первого входа: контейнеры могут работать, а создать учётную запись без HTTPS нельзя
# shellcheck source=lib/access.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/access.sh"
case "$(acc_state "$ENV_FILE")" in
  https) pass "Доступ: публичный адрес ${APP_PUBLIC_URL} (HTTPS); проверить прокси и сертификат: scripts/access.sh check" ;;
  local) pass "Доступ: только этот сервер (127.0.0.1); первый вход — на сервере или через SSH-туннель (scripts/access.sh status)" ;;
  incomplete) note "Первый вход не готов: приложение доступно по сети без HTTPS, браузер не даст создать учётную запись. Выберите способ: scripts/access.sh status" ;;
  *) note "Публичный адрес ${APP_PUBLIC_URL:-?} задан без HTTPS: scripts/access.sh set proxy --url https://ИМЯ" ;;
esac

# --- миграции: число применённых = числу в журнале миграций кода
expected="$(grep -c '"tag"' "$REPO_ROOT/apps/api/drizzle/meta/_journal.json" 2>/dev/null || echo 0)"
applied="$(dc exec -T db psql -U arklock -d arklock -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]')"
if [ -z "$applied" ]; then bad "Не удалось прочитать список применённых миграций"
elif [ "$applied" = "$expected" ]; then pass "Схема БД соответствует миграциям ($applied)"
else bad "Схема БД не соответствует коду: применено $applied, ожидается $expected"; fi

# --- безопасность окружения
perm="$(stat -c '%a' "$ENV_FILE")"
if [ "$perm" = 600 ]; then pass "Права файла окружения: 600"; else bad "Файл окружения доступен другим пользователям (права $perm, нужно 600): chmod 600 $ENV_FILE"; fi
if [ -f "$BACKUP_KEY_FILE" ]; then
  kperm="$(stat -c '%a' "$BACKUP_KEY_FILE")"
  [ "$kperm" = 600 ] && pass "Ключ резервных копий: есть, права 600" || bad "Права ключа резервных копий $kperm (нужно 600)"
  case "$BACKUP_KEY_FILE" in "$DATA_ROOT"/*) bad "Ключ резервных копий лежит внутри каталога данных ($DATA_ROOT)" ;; esac
else note "Ключ резервных копий не найден ($BACKUP_KEY_FILE): резервное копирование невозможно"; fi
dbcid="$(dc ps -q db 2>/dev/null | head -n 1)"
if [ -n "$dbcid" ] && docker inspect -f '{{json .NetworkSettings.Ports}}' "$dbcid" | grep -q 'HostPort'; then bad "Порт PostgreSQL опубликован на хосте"; else pass "PostgreSQL недоступен снаружи контейнерной сети"; fi
uid="$(dc exec -T app id -u 2>/dev/null | tr -d '[:space:]')"
if [ -n "$uid" ] && [ "$uid" != 0 ]; then pass "Приложение работает без прав root (uid $uid)"; else bad "Приложение работает от root или состояние не определено"; fi

# --- каталоги и место
for d in backups state logs tmp; do [ -d "$DATA_ROOT/$d" ] && true || note "Нет каталога $DATA_ROOT/$d (scripts/repair.sh создаст)"; done
free="$(free_gib "$DATA_ROOT")"
if [ "${free:-0}" -lt 1 ]; then bad "Почти нет места в $DATA_ROOT: ${free} ГиБ"
elif [ "${free:-0}" -lt 3 ]; then note "Мало места в $DATA_ROOT: ${free} ГиБ"
else pass "Свободно в $DATA_ROOT: ${free} ГиБ"; fi

echo
if [ "$ERR" -gt 0 ]; then fail "Проверка: ошибок $ERR, предупреждений $WARN"; exit 1; fi
ok "Проверка пройдена (предупреждений: $WARN)"
