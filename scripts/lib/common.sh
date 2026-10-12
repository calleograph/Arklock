#!/usr/bin/env bash
# Общая библиотека сценариев Arklock. Подключается через `source`, сама ничего не выполняет.
# Правила: конфигурация читается разбором строк KEY=VALUE (файл окружения НЕ исполняется как shell);
# секреты не печатаются; операции над данными выполняются только для compose-проекта Arklock.

# shellcheck shell=bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${ARKLOCK_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

DEFAULT_CONFIG_DIR="/etc/arklock"
DEFAULT_ENV_FILE="$DEFAULT_CONFIG_DIR/arklock.env"

# ------------------------------------------------------------------ вывод
if [ -t 1 ]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_BLU=$'\e[36m'; C_OFF=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_OFF=""
fi
info() { printf '%s[..]%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
fail() { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
die()  { fail "$*"; exit 1; }

# ------------------------------------------------------------------ окружение
# Безопасное чтение файла окружения: только строки KEY=VALUE, без подстановок и выполнения.
load_env() {
  local file="${1:-$ENV_FILE}" line key val
  [ -r "$file" ] || die "Не удаётся прочитать файл окружения: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    # значения в кавычках допускаются, остальные символы читаются буквально
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done < "$file"
}

# Устанавливает KEY=VALUE в файле окружения (атомарно, права 600).
env_set() {
  local file="$1" key="$2" val="$3" tmp
  [[ "$key" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]] || die "Недопустимое имя параметра: $key"
  case "$val" in *$'\n'*) die "Значение $key содержит перевод строки" ;; esac
  # Идемпотентность: если значение не меняется, файл не трогаем (порядок строк и время изменения сохраняются).
  if [ -f "$file" ] && grep -q -E "^${key}=" "$file" && [ "$(env_get "$file" "$key")" = "$val" ]; then return 0; fi
  tmp="$(mktemp "${file}.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then grep -v -E "^${key}=" "$file" > "$tmp" || true; fi
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv -f "$tmp" "$file"
}

env_get() { # env_get FILE KEY
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

rand_secret() { # rand_secret БАЙТ -> URL-безопасная строка
  openssl rand -base64 "${1:-32}" | tr '+/' '-_' | tr -d '=\r\n'
}

validate_project_name() {
  [[ "${COMPOSE_PROJECT_NAME:-}" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] \
    || die "COMPOSE_PROJECT_NAME должен состоять из строчных латинских букв, цифр, '-' и '_'"
}

require_vars() {
  local v
  for v in "$@"; do [ -n "${!v:-}" ] || die "В файле окружения не задан параметр $v"; done
}

# Привязка к экземпляру: файл окружения ищется в порядке --env, $ARKLOCK_ENV, /etc/arklock/arklock.env, $REPO_ROOT/.env.
ENV_FILE="${ENV_FILE:-${ARKLOCK_ENV:-}}"
resolve_env_file() {
  if [ -z "${ENV_FILE:-}" ]; then
    if [ -f "$DEFAULT_ENV_FILE" ]; then ENV_FILE="$DEFAULT_ENV_FILE"
    elif [ -f "$REPO_ROOT/.env" ]; then ENV_FILE="$REPO_ROOT/.env"
    fi
  fi
  [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ] || die "Файл окружения не найден. Укажите --env ФАЙЛ или выполните install.sh."
}

# Загрузка конфигурации экземпляра для рабочих сценариев.
init_instance() {
  resolve_env_file
  load_env "$ENV_FILE"
  # Явное указание образа (откат, восстановление после неудачного обновления) важнее значения в файле окружения.
  [ -z "${ARKLOCK_IMAGE_OVERRIDE:-}" ] || export ARKLOCK_IMAGE="$ARKLOCK_IMAGE_OVERRIDE"
  validate_project_name
  require_vars DATA_ROOT
  DATA_ROOT="${DATA_ROOT%/}"
  STATE_DIR="$DATA_ROOT/state"
  BACKUP_DIR="${BACKUP_DIR:-$DATA_ROOT/backups}"
  BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-$DEFAULT_CONFIG_DIR/backup.key}"
  INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"
  # GnuPG не должен зависеть от домашнего каталога пользователя (у служб он может быть недоступен для записи).
  export GNUPGHOME="${GNUPGHOME:-$STATE_DIR/gnupg}"
  if [ ! -d "$GNUPGHOME" ]; then mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"; fi
}

# docker compose строго для проекта Arklock: другие проекты и контейнеры не затрагиваются.
dc() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --project-directory "$REPO_ROOT" \
    --env-file "$ENV_FILE" -f "$REPO_ROOT/compose.yaml" "$@"
}

# Адрес для проверок на этом сервере: при привязке к конкретному адресу — он, иначе loopback.
app_url_local() {
  local host="${APP_BIND:-127.0.0.1}"
  [ "$host" != 0.0.0.0 ] || host=127.0.0.1
  printf 'http://%s:%s' "$host" "${APP_PORT:-8080}"
}

# ------------------------------------------------------------------ версии
app_version() { tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || echo 0.0.0; }
git_commit()  { git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown; }

# Метаданные сборки передаются в образ (compose build args) и отображаются в интерфейсе.
export_build_info() {
  export APP_VERSION APP_GIT_COMMIT APP_BUILT_AT
  APP_VERSION="$(app_version)"
  APP_GIT_COMMIT="$(git_commit)"
  APP_BUILT_AT="$(date -u +%FT%TZ)"
}

# Готовый образ релиза из реестра ускоряет установку и обновление. Принимается только образ, собранный из ТОЧНО этого
# коммита (метка org.opencontainers.image.revision); при любой неудаче (нет сети, нет образа, другой коммит) вызывающий
# сценарий собирает образ из исходников. ARKLOCK_PULL_RELEASE_IMAGE=0 отключает загрузку.
fetch_release_image() { # fetch_release_image ВЕРСИЯ КОММИТ → 0: образ загружен и помечен тегом $ARKLOCK_IMAGE
  local ver="$1" commit="$2" ref rev
  [ "${ARKLOCK_PULL_RELEASE_IMAGE:-1}" = 1 ] || return 1
  [ -n "$commit" ] && [ "$commit" != unknown ] || return 1
  ref="${ARKLOCK_REGISTRY_IMAGE:-ghcr.io/calleograph/arklock}:$ver"
  timeout 900 docker pull --quiet "$ref" >/dev/null 2>&1 || return 1
  rev="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref" 2>/dev/null)"
  [ "$rev" = "$commit" ] || return 1
  docker tag "$ref" "$ARKLOCK_IMAGE"
}

# ------------------------------------------------------------------ блокировка и состояние
# Одновременно выполняется только одна изменяющая операция (установка, обновление, восстановление…).
acquire_lock() {
  # Дочерний сценарий, запущенный из уже защищённой операции (например, backup.sh из restore.sh), блокировку наследует.
  [ "${ARKLOCK_LOCK_HELD:-}" = 1 ] && return 0
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/ops.lock"
  flock -n 9 || die "Уже выполняется другая операция (обновление, резервное копирование или восстановление). Повторите позже."
  export ARKLOCK_LOCK_HELD=1
}

state_set() { mkdir -p "$STATE_DIR"; env_set "$STATE_DIR/$1.state" "$2" "$3"; }
state_get() { env_get "$STATE_DIR/$1.state" "$2"; }

# ------------------------------------------------------------------ маскирование секретов (диагностика, журналы)
MASK_KEYS='PASSWORD|SECRET|TOKEN|KEY|PASSPHRASE|CREDENTIAL'
mask_env_stream() { # маскирует значения секретных параметров в потоке KEY=VALUE
  sed -E "s/^([A-Z0-9_]*($MASK_KEYS)[A-Z0-9_]*)=.*/\1=***скрыто***/"
}
mask_text_stream() { # маскирует токены и пароли в произвольном тексте журналов
  sed -E \
    -e 's#(aks_)[A-Za-z0-9_-]{20,}#\1***#g' \
    -e 's#(Bearer )[A-Za-z0-9._-]{16,}#\1***#g' \
    -e "s#(postgres(ql)?://[^:/@ ]+:)[^@ ]+@#\1***@#g" \
    -e "s#(($MASK_KEYS)[A-Za-z0-9_]*[=:] *)[^ ,;\"']+#\1***#Ig"
}

# ------------------------------------------------------------------ проверки
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Не найдена команда: $1"; }
need_root() { [ "$(id -u)" -eq 0 ] || die "Требуются права root (запустите через sudo)."; }

port_in_use() { # port_in_use ПОРТ — занят ли TCP-порт на этом хосте
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
}

free_gib() { # свободно ГиБ на разделе пути (путь может ещё не существовать)
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  # КиБ и округление вниз: «df -BG» округляет вверх, и 8 МиБ свободного места выглядели бы как 1 ГиБ
  df -P -k "$p" | awk 'NR==2 {print int($4 / 1048576)}'
}

wait_ready() { # wait_ready СЕК — ждёт готовности API
  local deadline=$(( $(date +%s) + ${1:-120} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 "$(app_url_local)/api/v1/ready" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
