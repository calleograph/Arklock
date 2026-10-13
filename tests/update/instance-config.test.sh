#!/usr/bin/env bash
# Проверка переноса адреса публикации из изменённого compose.yaml в APP_BIND (scripts/lib/instance-config.sh).
# Работает на временном git-репозитории: Docker не нужен. Запуск: bash tests/update/instance-config.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# shellcheck source=../../scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=../../scripts/lib/instance-config.sh
. "$ROOT/scripts/lib/instance-config.sh"

PASS=0; FAILS=0
check() { # check ОПИСАНИЕ КОМАНДА… — команда должна вернуть 0
  local desc="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); else FAILS=$((FAILS + 1)); echo "FAIL: $desc"; fi
}
refuse() { # refuse ОПИСАНИЕ КОМАНДА… — команда должна вернуть ненулевой код
  local desc="$1"; shift
  if "$@"; then FAILS=$((FAILS + 1)); echo "FAIL: $desc (ожидался отказ)"; else PASS=$((PASS + 1)); fi
}
same() { cmp -s "$1" "$2"; }

SECRET_MARK="SECRET-MARK-7731"
# Версия 1.0.0: адрес публикации зашит в compose.yaml; 1.0.1+: адрес берётся из APP_BIND.
make_repo() { # make_repo КАТАЛОГ СТРОКА_ПУБЛИКАЦИИ
  local dir="$1" line="$2"
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q
  # переводы строк как в Linux-установке, независимо от настроек git на машине, где запущен тест
  git -C "$dir" config core.autocrlf false
  git -C "$dir" config user.email test@example.invalid
  git -C "$dir" config user.name test
  printf '1.0.0\n' > "$dir/VERSION"
  printf 'services:\n  app:\n    ports:\n      - %s\n' "$line" > "$dir/compose.yaml"
  git -C "$dir" add -A
  git -C "$dir" commit -qm base
}
LEGACY_LINE="'127.0.0.1:\${APP_PORT:-8080}:8080'"
NEW_LINE="'\${APP_BIND:-127.0.0.1}:\${APP_PORT:-8080}:8080'"
# вручную изменённая строка (как у администратора тестовой установки)
edit_publish() { # edit_publish КАТАЛОГ АДРЕС [ПОРТ]
  local f="$1/compose.yaml" port="${3:-\${APP_PORT:-8080\}}"
  sed -i "s#^      - '127.0.0.1:.*#      - '$2:$port:8080'#" "$f"
}
make_env() { # make_env ФАЙЛ [дополнительные строки…]
  local f="$1"; shift
  printf 'APP_SECRET=%s\nBOOTSTRAP_TOKEN=%s\n' "$SECRET_MARK" "$SECRET_MARK" > "$f"
  local l; for l in "$@"; do printf '%s\n' "$l" >> "$f"; done
}

# ---------------------------------------------------------------- сценарий 1: нет изменений — ничего не делается
R="$WORK/clean"; make_repo "$R" "$LEGACY_LINE"
E="$WORK/clean.env"; make_env "$E"; cp "$E" "$E.orig"
check "без изменений миграция ничего не делает" ic_migrate_bind "$R" "$E" "$WORK/copies-clean" 1
check "без изменений файл окружения не меняется" same "$E" "$E.orig"

# ---------------------------------------------------------------- сценарий 2: адрес LAN, вписанный вручную (1.0.0)
R="$WORK/lan"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.94
E="$WORK/lan.env"; make_env "$E"
C="$WORK/copies-lan"
OUT="$(ic_migrate_bind "$R" "$E" "$C" 1 2>&1)"; RC=$?
check "перенос адреса LAN выполняется" [ "$RC" -eq 0 ]
check "APP_BIND получает адрес из compose.yaml" [ "$(env_get "$E" APP_BIND)" = 198.51.100.94 ]
check "compose.yaml возвращён к версии релиза" [ -z "$(ic_modified_files "$R")" ]
check "копия прежнего compose.yaml сохранена" bash -c "ls '$C'/compose.yaml.* >/dev/null 2>&1"
check "секреты не попадают в журнал переноса" bash -c "! printf '%s' \"\$1\" | grep -q '$SECRET_MARK'" _ "$OUT"
check "APP_SECRET сохранён без изменений" grep -q "^APP_SECRET=$SECRET_MARK\$" "$E"

# ---------------------------------------------------------------- сценарий 2б: повторный запуск безопасен
check "повторный перенос без изменений — успешный no-op" ic_migrate_bind "$R" "$E" "$C" 1
check "повторный перенос не меняет APP_BIND" [ "$(env_get "$E" APP_BIND)" = 198.51.100.94 ]

# ---------------------------------------------------------------- сценарий 4: нестандартный порт
R="$WORK/port"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.5 9090
E="$WORK/port.env"; make_env "$E"
check "нестандартный порт переносится" ic_migrate_bind "$R" "$E" "$WORK/copies-port" 1
check "APP_PORT получает порт из compose.yaml" [ "$(env_get "$E" APP_PORT)" = 9090 ]
check "APP_BIND получает адрес при нестандартном порте" [ "$(env_get "$E" APP_BIND)" = 198.51.100.5 ]

# ---------------------------------------------------------------- режим проверки: файлы не меняются
R="$WORK/dry"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.94
E="$WORK/dry.env"; make_env "$E"; cp "$E" "$E.orig"
check "проверка (dry-run) успешна" ic_migrate_bind "$R" "$E" "$WORK/copies-dry" 0
check "проверка не меняет окружение" same "$E" "$E.orig"
check "проверка оставляет compose.yaml изменённым" [ -n "$(ic_modified_files "$R")" ]

# ---------------------------------------------------------------- сценарий 7: посторонние изменения — отказ
R="$WORK/other"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.94
printf 'extra\n' >> "$R/VERSION"
E="$WORK/other.env"; make_env "$E"; cp "$E" "$E.orig"
refuse "посторонний файл останавливает перенос" ic_migrate_bind "$R" "$E" "$WORK/copies-other" 1
check "при отказе окружение не меняется" same "$E" "$E.orig"
check "при отказе изменения файлов сохраняются" [ "$(ic_modified_files "$R" | tr '\n' ' ')" = "VERSION compose.yaml " ]

R="$WORK/extra-line"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.94
printf '      - %s\n' "'127.0.0.1:8443:8443'" >> "$R/compose.yaml"
E="$WORK/extra-line.env"; make_env "$E"; cp "$E" "$E.orig"
refuse "лишняя строка в compose.yaml останавливает перенос" ic_migrate_bind "$R" "$E" "$WORK/copies-extra" 1
check "при отказе из-за лишней строки окружение не меняется" same "$E" "$E.orig"

# ---------------------------------------------------------------- конфликт: разные адреса в APP_BIND и compose.yaml
R="$WORK/conflict"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 198.51.100.94
E="$WORK/conflict.env"; make_env "$E" "APP_BIND=198.51.100.9"; cp "$E" "$E.orig"
refuse "разные адреса не переносятся молча" ic_migrate_bind "$R" "$E" "$WORK/copies-conflict" 1
check "при конфликте окружение не меняется" same "$E" "$E.orig"
check "при конфликте compose.yaml не возвращён" [ -n "$(ic_modified_files "$R")" ]

# ---------------------------------------------------------------- некорректный адрес
R="$WORK/badip"; make_repo "$R" "$LEGACY_LINE"; edit_publish "$R" 999.1.1.1
E="$WORK/badip.env"; make_env "$E"
refuse "некорректный IPv4 не переносится" ic_migrate_bind "$R" "$E" "$WORK/copies-badip" 1
check "некорректный адрес не попадает в APP_BIND" [ -z "$(env_get "$E" APP_BIND)" ]

# ---------------------------------------------------------------- сценарий 8: откат на версию без APP_BIND
R="$WORK/revert"; make_repo "$R" "$LEGACY_LINE"
E="$WORK/revert.env"; make_env "$E" "APP_BIND=198.51.100.94"
check "откат на 1.0.0 применяет сохранённый адрес" ic_apply_legacy_bind "$R" "$E"
check "после отката публикация идёт на прежний адрес" grep -q "'198.51.100.94:" "$R/compose.yaml"
check "следующее обновление снова переносит адрес без потерь" ic_migrate_bind "$R" "$E" "$WORK/copies-revert" 1
check "после повторного переноса файл чистый" [ -z "$(ic_modified_files "$R")" ]
check "адрес в APP_BIND не потерян" [ "$(env_get "$E" APP_BIND)" = 198.51.100.94 ]

# версия с APP_BIND: откат ничего не меняет
R="$WORK/revert-new"; make_repo "$R" "$NEW_LINE"
E="$WORK/revert-new.env"; make_env "$E" "APP_BIND=198.51.100.94"
check "версия с APP_BIND не меняется при откате" ic_apply_legacy_bind "$R" "$E"
check "строка публикации версии с APP_BIND сохранена" [ -z "$(ic_modified_files "$R")" ]

# ---------------------------------------------------------------- восстановление APP_BIND у работающего приложения
# Заглушка Docker: контейнер приложения опубликован на STUB_ADDR:STUB_PORT (или не запущен, если STUB_CID пуст).
STUB_CID="cid-app"; STUB_ADDR=""; STUB_PORT=""
docker() {
  if [ "$1" = ps ]; then [ -n "$STUB_CID" ] && echo "$STUB_CID"; return 0; fi
  if [ "$1" = inspect ]; then
    case "$*" in *HostIp*) echo "$STUB_ADDR" ;; *HostPort*) echo "$STUB_PORT" ;; esac
    return 0
  fi
  return 0
}
E="$WORK/restore.env"; make_env "$E"; STUB_ADDR=198.51.100.94; STUB_PORT=9090
check "потерянный APP_BIND восстанавливается из работающего приложения" ic_restore_bind_from_running "$E" arklock
check "адрес восстановлен из Docker" [ "$(env_get "$E" APP_BIND)" = 198.51.100.94 ]
check "нестандартный порт восстановлен из Docker" [ "$(env_get "$E" APP_PORT)" = 9090 ]
check "секреты окружения не изменены" grep -q "^APP_SECRET=$SECRET_MARK\$" "$E"

E="$WORK/restore-set.env"; make_env "$E" "APP_BIND=198.51.100.7"; STUB_ADDR=198.51.100.94; STUB_PORT=8080
check "заданный APP_BIND не перезаписывается" ic_restore_bind_from_running "$E" arklock
check "заданный APP_BIND сохранён" [ "$(env_get "$E" APP_BIND)" = 198.51.100.7 ]

E="$WORK/restore-none.env"; make_env "$E"; STUB_CID=""
check "без работающего приложения ничего не записывается" ic_restore_bind_from_running "$E" arklock
check "без работающего приложения APP_BIND пуст" [ -z "$(env_get "$E" APP_BIND)" ]
STUB_CID="cid-app"

E="$WORK/restore-all.env"; make_env "$E"; STUB_ADDR=0.0.0.0; STUB_PORT=8080
check "адрес 0.0.0.0 (все интерфейсы) сохраняется как выбор администратора" ic_restore_bind_from_running "$E" arklock
check "0.0.0.0 записан в APP_BIND" [ "$(env_get "$E" APP_BIND)" = 0.0.0.0 ]
unset -f docker

echo "instance-config: пройдено $PASS, не пройдено $FAILS"
[ "$FAILS" -eq 0 ]
