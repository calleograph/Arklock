#!/usr/bin/env bash
# Общая логика обновления и отката. Используется update.sh, rollback.sh и (позднее) помощником обновлений:
# CLI и веб-интерфейс обязаны выполнять один и тот же проверенный механизм.
# shellcheck shell=bash

# shellcheck source=instance-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/instance-config.sh"

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
UPDATE_LOG_FILE=""

upd_log() { # журнал обновлений (отдельный файл) + вывод
  local msg="$*"
  [ -n "$UPDATE_LOG_FILE" ] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$msg" >> "$UPDATE_LOG_FILE"
  info "$msg"
}

# Машиночитаемая отметка этапа для помощника обновлений (выводится только при ARKLOCK_PROGRESS=1).
upd_step() { # upd_step НОМЕР ВСЕГО НАЗВАНИЕ
  [ "${ARKLOCK_PROGRESS:-}" = 1 ] && printf 'ARKLOCK_STEP %s %s %s
' "$1" "$2" "$3"
  return 0
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
  ic_apply_legacy_bind "$REPO_ROOT" "$ENV_FILE" || return 1
  ARKLOCK_IMAGE="$2" upd_wait_app 180
}

# ------------------------------------------------------------------ место на диске и очистка образов

kib_free() { df -P -k "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
same_fs() { [ "$(stat -c %d "$1" 2>/dev/null)" = "$(stat -c %d "$2" 2>/dev/null)" ]; }
docker_root() { docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker; }
int_or_0() { [[ "${1:-}" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf 0; }

# Хватит ли места на новый образ, копию перед обновлением, миграции и восстановление при откате.
# Оценка по фактическим размерам: образ ×2 (загрузка или сборка), база ×2 в томе Docker (миграции, восстановление),
# база и вложения ×2 в каталоге данных (копия и её распаковка при откате) — плюс запас.
upd_space_check() {
  local root img db blobs need_docker need_data free_docker free_data mb=1024
  root="$(docker_root)"
  img="$(int_or_0 "$(docker image inspect -f '{{.Size}}' "$(docker inspect -f '{{.Image}}' "$(dc ps -q app | head -n 1)" 2>/dev/null)" 2>/dev/null)")"
  db="$(int_or_0 "$(dc exec -T db psql -U arklock -d arklock -tAc "select pg_database_size('arklock')" 2>/dev/null | tr -d '[:space:]')")"
  blobs="$(int_or_0 "$(du -sk "$DATA_ROOT/blobs" 2>/dev/null | cut -f1)")"
  img=$((img / 1024)); db=$((db / 1024))
  need_docker=$((2 * img + 2 * db + 512 * mb))
  need_data=$((2 * db + 2 * blobs + 256 * mb))
  free_docker="$(int_or_0 "$(kib_free "$root")")"; free_data="$(int_or_0 "$(kib_free "$DATA_ROOT")")"
  upd_log "Место для обновления: образ $((img / mb)) МБ, база $((db / mb)) МБ, вложения $((blobs / mb)) МБ"
  if same_fs "$root" "$DATA_ROOT"; then
    [ "$free_docker" -ge $((need_docker + need_data)) ] && return 0
    fail "Недостаточно места: нужно ≈ $(((need_docker + need_data) / mb)) МБ, свободно $((free_docker / mb)) МБ ($root и $DATA_ROOT на одном диске)"
    return 1
  fi
  [ "$free_docker" -ge "$need_docker" ] || { fail "Недостаточно места для образа и базы в $root: нужно ≈ $((need_docker / mb)) МБ, свободно $((free_docker / mb)) МБ"; return 1; }
  [ "$free_data" -ge "$need_data" ] || { fail "Недостаточно места для резервной копии в $DATA_ROOT: нужно ≈ $((need_data / mb)) МБ, свободно $((free_data / mb)) МБ"; return 1; }
}

# Образы этого экземпляра: локальная сборка (ARKLOCK_IMAGE без тега) и загруженные выпуски.
upd_own_images() { # → строки «ССЫЛКА ID»
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' "$(upd_image_base)" 2>/dev/null
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' "${ARKLOCK_REGISTRY_IMAGE:-ghcr.io/calleograph/arklock}" 2>/dev/null
}

# Все контейнеры сервера принадлежат этому экземпляру: только тогда общий кэш сборки можно чистить.
upd_host_is_ours() { ! docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -vqx "$COMPOSE_PROJECT_NAME"; }

upd_cleanup_result() { # upd_cleanup_result ИТОГ УДАЛЕНО ОСВОБОЖДЕНО_КиБ СООБЩЕНИЕ
  state_set cleanup at "$(date -u +%FT%TZ)"; state_set cleanup result "$1"
  state_set cleanup removed "$2"; state_set cleanup freed_kib "$3"; state_set cleanup message "$4"
  upd_log "Очистка образов: $4"
}

# После успешного обновления остаются только образ работающей версии и образ для отката; кэш сборки убирается.
# Ничего не удаляется, если новая версия не отвечает или образа для отката нет.
upd_cleanup() { # upd_cleanup ОБРАЗ_ДЛЯ_ОТКАТА
  local prev="$1" main cur back root before after freed ref id removed=0 cache
  main="$(env_get "$ENV_FILE" ARKLOCK_IMAGE)"; main="${main:-$ARKLOCK_IMAGE}"
  cur="$(docker inspect -f '{{.Image}}' "$(dc ps -q app | head -n 1)" 2>/dev/null)"
  back="$(docker image inspect -f '{{.Id}}' "$prev" 2>/dev/null)"
  if [ -z "$cur" ] || [ -z "$back" ] || ! wait_ready 30; then
    upd_cleanup_result skipped 0 0 "пропущена: нет работающей версии или образа для отката"
    return 0
  fi
  root="$(docker_root)"; before="$(int_or_0 "$(kib_free "$root")")"
  while read -r ref id; do
    [ -n "$ref" ] && [ "$ref" != "$main" ] && [ "$ref" != "$prev" ] || continue
    # образ, на котором есть хоть один контейнер (работающая версия, остановленный), не трогаем
    [ -z "$(docker ps -aq --filter "ancestor=$id" 2>/dev/null)" ] || continue
    docker rmi "$ref" >/dev/null 2>&1 && removed=$((removed + 1))
  done < <(upd_own_images)
  # безымянные остатки прежних сборок этого продукта (метка из Dockerfile)
  docker image prune -f --filter label=org.opencontainers.image.title=Arklock >/dev/null 2>&1 || true
  if upd_host_is_ours; then
    # записи кэша, которые сейчас использует идущая сборка, BuildKit не удаляет — параллельная сборка не ломается
    docker builder prune -af >/dev/null 2>&1 || true
    cache="кэш сборки очищен"
  else
    cache="кэш сборки не тронут: на сервере есть контейнеры других проектов"
  fi
  after="$(int_or_0 "$(kib_free "$root")")"; freed=$((after > before ? after - before : 0))
  upd_cleanup_result ok "$removed" "$freed" "снято тегов: $removed, осталось образов: $(upd_own_images | awk '{print $2}' | sort -u | grep -c .), освобождено ≈ $((freed / 1024)) МБ; $cache"
}
