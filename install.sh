#!/usr/bin/env bash
# Установщик Arklock.
#
#   sudo ./install.sh [параметры]
#
# Профили:
#   standalone   отдельный сервер: при необходимости устанавливаются Docker и системные пакеты.
#   shared-host  на сервере уже работают другие приложения: Docker и системные настройки НЕ устанавливаются и НЕ меняются,
#                порт подбирается свободный, чужие контейнеры, Nginx и порты не затрагиваются.
#
# Параметры:
#   --profile standalone|shared-host   профиль (по умолчанию определяется автоматически)
#   --dir ПУТЬ        каталог программы (по умолчанию /opt/arklock; при запуске из клона — он сам)
#   --data ПУТЬ       каталог данных DATA_ROOT (по умолчанию /var/lib/arklock): резервные копии, состояние, журналы
#   --config ПУТЬ     каталог конфигурации (по умолчанию /etc/arklock)
#   --project ИМЯ     имя compose-проекта (по умолчанию arklock)
#   --port ПОРТ       порт на 127.0.0.1 (по умолчанию подбирается свободный: 8080 или выше)
#   --url АДРЕС       публичный адрес (https://…), по которому пользователи откроют Arklock
#   --https РЕЖИМ     автоматическая настройка Nginx и HTTPS: letsencrypt | self-signed | existing (нужен --domain);
#                     в профиле shared-host Nginx не меняется — создаётся только пример конфигурации
#   --domain ИМЯ      имя сервера для HTTPS (например, arklock.example.com)
#   --email АДРЕС     почта для уведомлений Let's Encrypt
#   --tls-cert ФАЙЛ --tls-key ФАЙЛ   свой сертификат и ключ (режим existing)
#   --ref ТЕГ         версия для загрузки (по умолчанию — последний релиз; main — только с --allow-unreleased)
#   --repo URL        репозиторий исходного кода
#   --allow-unreleased  разрешить установку непомеченной ветки (для разработки и проверки)
#   --yes             не задавать вопросов
#   --dry-run         только показать, что будет сделано
#   -h, --help        справка
#
# Повторный запуск безопасен: данные, секреты и тома не пересоздаются, исправляются только известные проблемы установки.
set -euo pipefail

REPO_URL_DEFAULT="https://github.com/calleograph/arklock.git"
PROFILE=""; INSTALL_DIR=""; DATA_ROOT=""; CONFIG_DIR="/etc/arklock"; PROJECT="arklock"; PORT=""; PUBLIC_URL=""
HTTPS_MODE=""; DOMAIN=""; ACME_EMAIL=""; TLS_CERT=""; TLS_KEY=""
REF=""; REPO_URL="$REPO_URL_DEFAULT"; ALLOW_UNRELEASED=0; YES=0; DRY=0; BOOTSTRAPPED=0

usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --data) DATA_ROOT="${2:-}"; shift 2 ;;
    --config) CONFIG_DIR="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --https) HTTPS_MODE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --tls-cert) TLS_CERT="${2:-}"; shift 2 ;;
    --tls-key) TLS_KEY="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --allow-unreleased) ALLOW_UNRELEASED=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --bootstrapped) BOOTSTRAPPED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (см. --help)" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$HTTPS_MODE" in
  ''|letsencrypt|self-signed|existing) ;;
  *) echo "--https: letsencrypt, self-signed или existing" >&2; exit 2 ;;
esac
if [ -n "$HTTPS_MODE" ] && [ -z "$DOMAIN" ]; then echo "--https требует --domain" >&2; exit 2; fi

say()  { printf '[..] %s\n' "$*"; }
okk()  { printf '[ok] %s\n' "$*"; }
warnn() { printf '[warn] %s\n' "$*" >&2; }
bail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" -eq 0 ] || bail "Запустите установщик от root: sudo ./install.sh"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] || bail "Недопустимое имя проекта: $PROJECT"
case "$PROFILE" in ''|standalone|shared-host) ;; *) bail "Профиль: standalone или shared-host" ;; esac

# ------------------------------------------------------------------ 1. Операционная система и ресурсы
. /etc/os-release 2>/dev/null || bail "Не удалось определить операционную систему"
OS_ID="${ID:-unknown}"; OS_VER="${VERSION_ID:-0}"
case "$OS_ID:$OS_VER" in
  ubuntu:24.04|debian:12) okk "Операционная система: $PRETTY_NAME" ;;
  *)
    if [ "${ARKLOCK_ALLOW_UNSUPPORTED_OS:-0}" = 1 ]; then warnn "ОС $PRETTY_NAME не входит в проверенный список (Ubuntu 24.04, Debian 12) — продолжаем по ARKLOCK_ALLOW_UNSUPPORTED_OS=1"
    else bail "Поддерживаются Ubuntu 24.04 LTS и Debian 12 (обнаружено: $PRETTY_NAME). Для обхода: ARKLOCK_ALLOW_UNSUPPORTED_OS=1"; fi ;;
esac
case "$(uname -m)" in x86_64|aarch64) okk "Архитектура: $(uname -m)" ;; *) bail "Неподдерживаемая архитектура: $(uname -m)" ;; esac
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
[ "$MEM_MB" -ge 900 ] || bail "Мало оперативной памяти: ${MEM_MB} МБ (нужно не менее 1 ГБ)"
okk "Ресурсы: CPU $(nproc), память ${MEM_MB} МБ"
command -v systemctl >/dev/null 2>&1 || warnn "systemd не обнаружен: автозапуск помощника обновлений будет недоступен"

# ------------------------------------------------------------------ 2. Самозагрузка (установщик скачан отдельно)
if [ ! -f "$HERE/scripts/lib/common.sh" ] || [ ! -f "$HERE/compose.yaml" ]; then
  [ "$BOOTSTRAPPED" -eq 0 ] || bail "Не найдены файлы Arklock рядом с установщиком"
  command -v git >/dev/null 2>&1 || { say "Установка git"; run apt-get update -qq; run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates; }
  INSTALL_DIR="${INSTALL_DIR:-/opt/arklock}"
  if [ -z "$REF" ]; then
    say "Определяю последний релиз…"
    REF="$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>/dev/null | sed 's#.*refs/tags/##' | sort -V | tail -n 1 || true)"
    if [ -z "$REF" ]; then
      [ "$ALLOW_UNRELEASED" -eq 1 ] || bail "В репозитории нет опубликованных релизов. Укажите --ref ТЕГ либо --allow-unreleased для установки ветки main (только для проверки)."
      REF="main"
    fi
  fi
  [ "$REF" != "main" ] || [ "$ALLOW_UNRELEASED" -eq 1 ] || bail "Установка ветки main допустима только с --allow-unreleased"
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    say "Загрузка Arklock ($REF) в $INSTALL_DIR"
    run git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  else
    okk "Каталог программы уже существует: $INSTALL_DIR (не перезаписывается)"
  fi
  [ "$DRY" -eq 0 ] || exit 0
  args=(--bootstrapped --profile "${PROFILE:-}" --dir "$INSTALL_DIR" --data "${DATA_ROOT:-}" --config "$CONFIG_DIR"
    --project "$PROJECT" --port "${PORT:-}" --url "${PUBLIC_URL:-}" --repo "$REPO_URL")
  [ "$YES" -eq 1 ] && args+=(--yes)
  [ "$ALLOW_UNRELEASED" -eq 1 ] && args+=(--allow-unreleased)
  exec "$INSTALL_DIR/install.sh" "${args[@]}"
fi

# ------------------------------------------------------------------ далее — из каталога программы
REPO_ROOT="$HERE"
# shellcheck source=scripts/lib/common.sh
. "$REPO_ROOT/scripts/lib/common.sh"
INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"
[ "$(cd "$INSTALL_DIR" && pwd)" = "$REPO_ROOT" ] || bail "Каталог программы ($INSTALL_DIR) не совпадает с расположением установщика ($REPO_ROOT)"
DATA_ROOT="${DATA_ROOT:-/var/lib/arklock}"
ENV_FILE="$CONFIG_DIR/arklock.env"
ARKLOCK_ENV="$ENV_FILE"

# ------------------------------------------------------------------ 3. Профиль
OTHER_CONTAINERS=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  OTHER_CONTAINERS="$(docker ps -q --filter "label=com.docker.compose.project" | wc -l)"
  # собственные контейнеры при повторной установке чужими не считаются
  OWN="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l)"
  OTHER_CONTAINERS=$(( OTHER_CONTAINERS - OWN ))
fi
WEB_SERVERS=""
for svc in nginx apache2 httpd caddy; do systemctl is-active --quiet "$svc" 2>/dev/null && WEB_SERVERS="$WEB_SERVERS $svc"; done
SUGGEST="standalone"
if [ "$OTHER_CONTAINERS" -gt 0 ] || [ -n "$WEB_SERVERS" ]; then SUGGEST="shared-host"; fi
if [ -z "$PROFILE" ]; then
  if [ "$YES" -eq 0 ] && [ -t 0 ]; then
    echo "Обнаружено: чужих compose-контейнеров — $OTHER_CONTAINERS; веб-серверы:${WEB_SERVERS:- нет}."
    read -r -p "Профиль установки [standalone/shared-host] (рекомендуется: $SUGGEST): " PROFILE
    PROFILE="${PROFILE:-$SUGGEST}"
  else
    PROFILE="$SUGGEST"
  fi
fi
case "$PROFILE" in standalone|shared-host) ;; *) bail "Некорректный профиль: $PROFILE" ;; esac
okk "Профиль: $PROFILE"
if [ "$PROFILE" = "standalone" ] && { [ "$OTHER_CONTAINERS" -gt 0 ] || [ -n "$WEB_SERVERS" ]; }; then
  warnn "На сервере уже работают другие сервисы. Профиль standalone допускает установку пакетов; выберите shared-host, если менять систему нельзя."
fi

# ------------------------------------------------------------------ 4. Зависимости
SYS_PKGS=(curl ca-certificates gnupg openssl git util-linux iproute2)
missing=()
for c in curl gpg openssl git flock ss; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$PROFILE" = "shared-host" ]; then
    bail "Не хватает системных утилит: ${missing[*]}. В профиле shared-host установщик не меняет систему — установите их сами (apt install ${SYS_PKGS[*]}) и повторите запуск."
  fi
  say "Установка системных пакетов: ${SYS_PKGS[*]}"
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${SYS_PKGS[@]}"
fi

install_docker() {
  say "Установка Docker Engine и Compose Plugin из официального репозитория Docker"
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  ARCH="$(dpkg --print-architecture)"
  if [ "$DRY" -eq 0 ]; then
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  fi
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
}
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "$PROFILE" = "shared-host" ]; then
    bail "Docker Engine с плагином Compose не найден. В профиле shared-host установщик не устанавливает Docker — установите его самостоятельно и повторите запуск."
  fi
  install_docker
fi
if [ "$DRY" -eq 0 ]; then
  docker info >/dev/null 2>&1 || bail "Docker установлен, но демон недоступен (systemctl status docker)"
  okk "Docker: $(docker --version | cut -d, -f1); $(docker compose version | head -n 1)"
fi

# ------------------------------------------------------------------ 5. Порты и место
pick_port() {
  local p="$1"
  while port_in_use "$p"; do p=$((p + 1)); done
  echo "$p"
}
EXISTING_PORT=""
[ -f "$ENV_FILE" ] && EXISTING_PORT="$(env_get "$ENV_FILE" APP_PORT)"
if [ -z "$PORT" ]; then
  if [ -n "$EXISTING_PORT" ]; then PORT="$EXISTING_PORT"; else PORT="$(pick_port 8080)"; fi
fi
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || bail "Некорректный порт: $PORT"
if [ "$PORT" != "$EXISTING_PORT" ] && port_in_use "$PORT"; then bail "Порт $PORT уже занят другим сервисом. Укажите другой: --port ПОРТ"; fi
okk "Порт приложения: 127.0.0.1:$PORT"

FREE="$(free_gib "$DATA_ROOT")"
[ "${FREE:-0}" -ge 3 ] || bail "Мало свободного места в ${DATA_ROOT}: ${FREE} ГиБ (нужно не менее 3)"
okk "Свободное место для данных: ${FREE} ГиБ"

# ------------------------------------------------------------------ 6. Каталоги, конфигурация, секреты
say "Каталоги: $CONFIG_DIR, $DATA_ROOT"
run install -d -m 0750 "$CONFIG_DIR"
run install -d -m 0750 "$DATA_ROOT"
for d in backups state updater logs tmp blobs; do run install -d -m 0750 "$DATA_ROOT/$d"; done
# Каталог обмена с помощником обновлений: контейнер приложения (непривилегированный) должен писать в него запросы.
run chmod 1777 "$DATA_ROOT/updater"
# Вложения пишет непривилегированный пользователь контейнера (node, uid 1000).
run chown 1000:1000 "$DATA_ROOT/blobs"

if [ "$DRY" -eq 1 ]; then
  say "[dry-run] создание $ENV_FILE, ключа резервного шифрования, запуск контейнеров и проверок"
  exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 /dev/null "$ENV_FILE"
fi
set_default() { # задаёт параметр, только если его ещё нет (повторный запуск не меняет секреты)
  [ -n "$(env_get "$ENV_FILE" "$1")" ] || env_set "$ENV_FILE" "$1" "$2"
}
set_default COMPOSE_PROJECT_NAME "$PROJECT"
set_default INSTALL_PROFILE "$PROFILE"
set_default INSTALL_DIR "$REPO_ROOT"
set_default DATA_ROOT "$DATA_ROOT"
set_default POSTGRES_PASSWORD "$(rand_secret 24)"
set_default APP_SECRET "$(rand_secret 48)"
set_default BOOTSTRAP_TOKEN "$(rand_secret 24)"
set_default ARKLOCK_IMAGE "${PROJECT}-app:local"
set_default TRUSTED_PROXY_HOPS 1
set_default UPDATE_CHANNEL stable
set_default LOG_LEVEL info
env_set "$ENV_FILE" APP_PORT "$PORT"
[ -z "$PUBLIC_URL" ] || env_set "$ENV_FILE" APP_PUBLIC_URL "$PUBLIC_URL"
chmod 600 "$ENV_FILE"
okk "Конфигурация: $ENV_FILE (права 600)"

KEY_FILE="$CONFIG_DIR/backup.key"
if [ ! -f "$KEY_FILE" ]; then
  ( umask 077; rand_secret 48 > "$KEY_FILE" )
  chmod 600 "$KEY_FILE"
  okk "Создан ключ шифрования резервных копий: $KEY_FILE"
  warn_key=1
else
  warn_key=0
fi
set_default BACKUP_KEY_FILE "$KEY_FILE"

# ------------------------------------------------------------------ 7. Сборка и запуск
init_instance
acquire_lock
export_build_info
if fetch_release_image "$(app_version)" "$(git_commit)"; then
  say "Запуск контейнеров (проект «$COMPOSE_PROJECT_NAME»): загружен готовый образ релиза"
  build_flag=--no-build
else
  say "Сборка образа и запуск контейнеров (проект «$COMPOSE_PROJECT_NAME»)"
  build_flag=--build
fi
dc up -d "$build_flag" --wait --wait-timeout 300 || { fail "Контейнеры не стали готовыми. Журналы: scripts/logs.sh"; dc ps || true; exit 1; }
wait_ready 120 || bail "API не отвечает на проверку готовности"
state_set install installed_at "$(date -u +%FT%TZ)"
state_set install version "$(app_version)"
state_set install commit "$(git_commit)"
okk "Arklock запущен"

# ------------------------------------------------------------------ 8. Проверка
if "$REPO_ROOT/scripts/verify.sh" --env "$ENV_FILE"; then okk "Проверка установки пройдена"; else fail "Проверка установки нашла проблемы (см. выше)"; exit 1; fi

# ------------------------------------------------------------------ 8а. Помощник обновлений
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if "$REPO_ROOT/scripts/updater.sh" install --env "$ENV_FILE"; then HELPER_STATE="работает (служба arklock-updater-$COMPOSE_PROJECT_NAME)"; else HELPER_STATE="НЕ ЗАПУЩЕН — выполните scripts/updater.sh repair"; fi
else
  HELPER_STATE="не установлен: systemd не обнаружен (обновление из веб-интерфейса недоступно)"
fi

# ------------------------------------------------------------------ 8б. HTTPS и Nginx
PROXY_STATE="не настраивался (--https letsencrypt|self-signed|existing --domain ИМЯ или scripts/proxy.sh)"
if [ -n "$HTTPS_MODE" ]; then
  if [ "$PROFILE" = shared-host ]; then
    "$REPO_ROOT/scripts/proxy.sh" print --env "$ENV_FILE" --domain "$DOMAIN" > "$CONFIG_DIR/nginx-arklock.conf.example" 2>/dev/null || true
    PROXY_STATE="shared-host: Nginx не изменён; пример конфигурации — $CONFIG_DIR/nginx-arklock.conf.example"
  else
    proxy_args=(setup --env "$ENV_FILE" --domain "$DOMAIN" --mode "$HTTPS_MODE")
    [ -z "$ACME_EMAIL" ] || proxy_args+=(--email "$ACME_EMAIL")
    [ -z "$TLS_CERT" ] || proxy_args+=(--cert "$TLS_CERT" --key "$TLS_KEY")
    if "$REPO_ROOT/scripts/proxy.sh" "${proxy_args[@]}"; then PROXY_STATE="HTTPS включён: https://$DOMAIN"; else PROXY_STATE="НЕ НАСТРОЕН — исправьте причину (см. выше) и выполните scripts/proxy.sh setup"; fi
    APP_PUBLIC_URL="$(env_get "$ENV_FILE" APP_PUBLIC_URL)"
  fi
fi

# ------------------------------------------------------------------ 9. Итог
URL="${APP_PUBLIC_URL:-$(app_url_local)}"
TOKEN="$(env_get "$ENV_FILE" BOOTSTRAP_TOKEN)"
cat <<EOF

================ УСТАНОВКА ЗАВЕРШЕНА ================
 Профиль:          $PROFILE
 Версия:           $(app_version) ($(git_commit | cut -c1-12))
 Адрес (локально): $(app_url_local)
 Адрес (публичный): ${APP_PUBLIC_URL:-не задан — настройте reverse proxy с HTTPS на 127.0.0.1:$PORT}
 Помощник обновлений: $HELPER_STATE
 HTTPS / Nginx:    $PROXY_STATE
 Конфигурация:     $ENV_FILE
 Данные:           $DATA_ROOT

 Первый вход:
   1. Откройте $URL
   2. Создайте первую учётную запись — она станет администратором.
   3. Введите одноразовый код настройки: $TOKEN
      (код хранится в $ENV_FILE и нужен только для первой записи)
   4. Сохраните показанный ключ восстановления.

 Обслуживание:  scripts/status.sh   scripts/backup.sh   scripts/diag.sh   scripts/logs.sh
EOF
if [ "$warn_key" -eq 1 ]; then
  cat <<EOF

 ВАЖНО: ключ шифрования резервных копий $KEY_FILE хранится ОТДЕЛЬНО от копий.
 Скопируйте его в надёжное место вне этого сервера. Без него резервные копии не расшифровать.
EOF
fi
echo "======================================================"
