#!/usr/bin/env bash
# Общая логика обновления и отката. Используется update.sh, rollback.sh и (позднее) помощником обновлений:
# CLI и веб-интерфейс обязаны выполнять один и тот же проверенный механизм.
# shellcheck shell=bash

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
UPDATE_LOG_FILE=""

upd_log() { # журнал обновлений (отдельный файл) + вывод
  local msg="$*"
  [ -n "$UPDATE_LOG_FILE" ] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$msg" >> "$UPDATE_LOG_FILE"
  info "$msg"
}

upd_init() {
  mkdir -p "$DATA_ROOT/logs" "$STATE_DIR"
  UPDATE_LOG_FILE="$DATA_ROOT/logs/updates.log"
  touch "$UPDATE_LOG_FILE"; chmod 640 "$UPDATE_LOG_FILE"
}

# Число миграций в журнале кода на указанной ревизии git.
upd_migrations_at() { # upd_migrations_at REV
  git -C "$REPO_ROOT" show "$1:apps/api/drizzle/meta/_journal.json" 2>/dev/null | grep -c '"tag"' || echo 0
}
# Число применённых миграций в работающей БД.
upd_migrations_applied() {
  dc exec -T db psql -U arklock -d arklock -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]'
}

upd_current_tag() { git -C "$REPO_ROOT" describe --tags --exact-match HEAD 2>/dev/null || true; }

# Последний релизный тег из удалённого репозитория.
upd_latest_tag() {
  git -C "$REPO_ROOT" tag --list 'v*' | grep -E "$TAG_RE" | sort -V | tail -n 1
}

upd_fetch() { # получает теги; сетевой сбой не меняет ничего
  local i
  for i in 1 2 3; do
    git -C "$REPO_ROOT" fetch --tags --prune --quiet origin 2>/dev/null && return 0
    sleep $((i * 3))
  done
  return 1
}

upd_ver_gt() { # upd_ver_gt A B — A новее B (по SemVer)
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | tail -n 1)" = "${1#v}" ]
}

upd_image_base() { printf '%s' "${ARKLOCK_IMAGE%:*}"; }

# Ожидание готовности после запуска; 0 — приложение готово и отвечает.
upd_wait_app() {
  dc up -d --no-build --wait --wait-timeout "${1:-180}" app >/dev/null 2>&1 || return 1
  wait_ready 60
}

# Тег ARKLOCK_IMAGE из файла окружения должен всегда указывать на РАБОТАЮЩУЮ версию (иначе следующее обновление сохранит не тот образ).
upd_retag_current() { # upd_retag_current ОБРАЗ_РАБОТАЮЩЕЙ_ВЕРСИИ
  local main_tag
  main_tag="$(env_get "$ENV_FILE" ARKLOCK_IMAGE)"
  [ -z "$main_tag" ] || docker tag "$1" "$main_tag"
}

# Возврат кода и образа к сохранённому состоянию (без изменения БД).
upd_revert_code() { # upd_revert_code COMMIT IMAGE
  git -C "$REPO_ROOT" checkout --quiet --detach "$1" || return 1
  ARKLOCK_IMAGE="$2" upd_wait_app 180
}
