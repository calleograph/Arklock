# shellcheck shell=bash
# Настройки экземпляра, которые администраторы версии 1.0.x вносили в отслеживаемый compose.yaml вручную
# (адрес публикации для доступа из локальной сети). Начиная с 1.0.1 адрес хранится в APP_BIND файла окружения.
#   ic_migrate_bind        — переносит адрес из изменённого compose.yaml в APP_BIND и возвращает файл к релизу;
#   ic_apply_legacy_bind   — для версий без APP_BIND (после отката) применяет адрес из APP_BIND к их compose.yaml.
# Любые другие изменения файлов программы не трогаются: они по-прежнему останавливают обновление.
# Подключается из scripts/lib/updatelib.sh, scripts/update.sh, scripts/rollback.sh и install.sh; нужен common.sh.

IC_IPV4_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
# строка публикации порта приложения: '<адрес>:<порт>:8080'
IC_PUBLISH_RE="^[[:space:]]*-[[:space:]]+'([^:']+):([^']+):8080'[[:space:]]*\$"
IC_PORT_DEFAULT='${APP_PORT:-8080}'

ic_valid_ipv4() { # ic_valid_ipv4 АДРЕС
  local o IFS=.
  [[ "$1" =~ $IC_IPV4_RE ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}

# Отслеживаемые файлы, отличающиеся от HEAD (без неотслеживаемых: их обновление не затрагивает).
ic_modified_files() { # ic_modified_files КАТАЛОГ
  git -C "$1" diff --name-only HEAD -- 2>/dev/null
}

# Разбирает единственное изменение compose.yaml: строку публикации порта заменили на другой адрес.
# Печатает «АДРЕС ПОРТ» (ПОРТ — либо литерал, либо ${APP_PORT:-8080}) или возвращает 1.
ic_parse_publish_change() { # ic_parse_publish_change КАТАЛОГ
  local repo="$1" changes old new addr port
  changes="$(git -C "$repo" diff -U0 HEAD -- compose.yaml 2>/dev/null | grep -E '^[-+][^-+]')" || return 1
  [ "$(printf '%s\n' "$changes" | grep -c .)" -eq 2 ] || return 1
  old="$(printf '%s\n' "$changes" | sed -n 1p)"
  new="$(printf '%s\n' "$changes" | sed -n 2p)"
  [[ "$old" == -* && "$new" == +* ]] || return 1
  old="${old:1}"; new="${new:1}"
  [[ "$old" =~ $IC_PUBLISH_RE ]] || return 1
  [[ "$new" =~ $IC_PUBLISH_RE ]] || return 1
  addr="${BASH_REMATCH[1]}"; port="${BASH_REMATCH[2]}"
  ic_valid_ipv4 "$addr" || return 1
  if [ "$port" != "$IC_PORT_DEFAULT" ]; then
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 1
  fi
  printf '%s %s\n' "$addr" "$port"
}

# Перенос адреса публикации в APP_BIND (и порта в APP_PORT, если он не стандартный).
# ПРИМЕНИТЬ=0 — только проверка, ничего не меняется. Возвращает 0, если изменений нет или перенос выполнен,
# и 1 при отказе; при отказе файлы не меняются. Значения адреса и порта — не секреты, их можно выводить.
ic_migrate_bind() { # ic_migrate_bind КАТАЛОГ ФАЙЛ_ОКРУЖЕНИЯ КАТАЛОГ_КОПИЙ ПРИМЕНИТЬ
  local repo="$1" env_file="$2" copies="$3" apply="${4:-1}" files parsed addr port cur ts
  files="$(ic_modified_files "$repo")"
  [ -n "$files" ] || return 0
  if [ "$files" != "compose.yaml" ]; then
    fail "Изменены файлы программы: $(printf '%s' "$files" | tr '\n' ' ')"
    fail "Автоматически переносится только адрес публикации в compose.yaml. Остальные изменения верните к версии релиза вручную (docs/TROUBLESHOOTING.md)."
    return 1
  fi
  parsed="$(ic_parse_publish_change "$repo")" || {
    fail "В compose.yaml изменено больше строки публикации порта. Перенос не выполнен (docs/TROUBLESHOOTING.md)."
    return 1
  }
  read -r addr port <<<"$parsed"
  cur="$(env_get "$env_file" APP_BIND)"
  if [ -n "$cur" ] && [ "$cur" != "$addr" ]; then
    fail "Адрес в APP_BIND ($cur) не совпадает с адресом в compose.yaml ($addr). Выберите нужный и приведите файлы к одному значению."
    return 1
  fi
  if [ "$port" != "$IC_PORT_DEFAULT" ]; then
    cur="$(env_get "$env_file" APP_PORT)"
    if [ -n "$cur" ] && [ "$cur" != "$port" ]; then
      fail "Порт в APP_PORT ($cur) не совпадает с портом в compose.yaml ($port). Приведите значения к одному."
      return 1
    fi
  fi
  if [ "$apply" -ne 1 ]; then
    ok "[проверка] адрес публикации $addr будет перенесён в APP_BIND; compose.yaml вернётся к версии релиза"
    return 0
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$copies" && chmod 700 "$copies" || { fail "Не удалось создать каталог копий: $copies"; return 1; }
  cp -p "$repo/compose.yaml" "$copies/compose.yaml.$ts" || { fail "Не удалось сохранить копию compose.yaml"; return 1; }
  [ "$port" = "$IC_PORT_DEFAULT" ] || env_set "$env_file" APP_PORT "$port"
  env_set "$env_file" APP_BIND "$addr"
  export APP_BIND="$addr"
  [ "$port" = "$IC_PORT_DEFAULT" ] || export APP_PORT="$port"
  git -C "$repo" checkout --quiet -- compose.yaml || { fail "Не удалось вернуть compose.yaml к версии релиза"; return 1; }
  ok "Адрес публикации $addr перенесён в APP_BIND; compose.yaml возвращён к версии релиза (копия: $copies/compose.yaml.$ts)"
}

# Версии без APP_BIND (1.0.x) публикуют порт на 127.0.0.1 жёстко. После возврата на такую версию (откат,
# восстановление) применяем адрес из APP_BIND к строке публикации. Меняется только эта строка.
ic_apply_legacy_bind() { # ic_apply_legacy_bind КАТАЛОГ ФАЙЛ_ОКРУЖЕНИЯ
  local repo="$1" env_file="$2" addr
  grep -q 'APP_BIND' "$repo/compose.yaml" && return 0
  addr="$(env_get "$env_file" APP_BIND)"
  [ -n "$addr" ] && [ "$addr" != 127.0.0.1 ] || return 0
  ic_valid_ipv4 "$addr" || return 0
  sed -i -E "s/^([[:space:]]*-[[:space:]]+')127\.0\.0\.1(:[^']*:8080')/\1${addr}\2/" "$repo/compose.yaml"
  grep -q "'${addr}:" "$repo/compose.yaml" || { fail "Не удалось применить адрес $addr к compose.yaml этой версии"; return 1; }
  ok "Адрес публикации $addr применён к compose.yaml этой версии"
}

# Адрес публикации работающего приложения по данным Docker: печатает «АДРЕС ПОРТ» или ничего.
ic_running_publish() { # ic_running_publish ПРОЕКТ
  local project="$1" cid host port
  cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=app" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || return 0
  host="$(docker inspect -f '{{with index .NetworkSettings.Ports "8080/tcp"}}{{with index . 0}}{{.HostIp}}{{end}}{{end}}' "$cid" 2>/dev/null)"
  port="$(docker inspect -f '{{with index .NetworkSettings.Ports "8080/tcp"}}{{with index . 0}}{{.HostPort}}{{end}}{{end}}' "$cid" 2>/dev/null)"
  [ -n "$host" ] && [ -n "$port" ] && printf '%s %s\n' "$host" "$port"
  return 0
}

# Если APP_BIND потерян (например, при прошлом обновлении), адрес и порт берём у работающего приложения.
# Пока APP_BIND задан, ничего не меняется. Адрес, который Docker не подтверждает, не записывается.
ic_restore_bind_from_running() { # ic_restore_bind_from_running ФАЙЛ_ОКРУЖЕНИЯ ПРОЕКТ
  local env_file="$1" project="$2" parsed addr port
  [ -z "$(env_get "$env_file" APP_BIND)" ] || return 0
  parsed="$(ic_running_publish "$project")"
  if [ -z "$parsed" ]; then
    warn "APP_BIND не задан, а работающее приложение не найдено: адрес публикации будет 127.0.0.1. Проверьте доступ и задайте APP_BIND."
    return 0
  fi
  read -r addr port <<<"$parsed"
  ic_valid_ipv4 "$addr" || return 0
  env_set "$env_file" APP_BIND "$addr"
  export APP_BIND="$addr"
  if [ -z "$(env_get "$env_file" APP_PORT)" ] && [[ "$port" =~ ^[0-9]{1,5}$ ]]; then env_set "$env_file" APP_PORT "$port"; fi
  export APP_PORT="$(env_get "$env_file" APP_PORT)"
  ok "Адрес публикации $addr:$port взят у работающего приложения и сохранён в APP_BIND"
}
