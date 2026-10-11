#!/usr/bin/env bash
# backup.sh — зашифрованная резервная копия экземпляра Arklock.
#   scripts/backup.sh [--env ФАЙЛ] [--keep N] [--label МЕТКА]
#   scripts/backup.sh --verify ФАЙЛ        проверить существующую копию (расшифровка, целостность, читаемость дампа)
#
# В копию входят: дамп PostgreSQL (зашифрованные клиентом записи, ключи пользователей, настройки, журнал),
# файл конфигурации и манифест версии. Всё упаковывается и шифруется (GnuPG, AES-256, симметричный ключ из
# BACKUP_KEY_FILE). Ключ хранится ОТДЕЛЬНО от копий (по умолчанию /etc/arklock/backup.key) — без него копию не расшифровать.
#
# Важно для менеджера паролей: данные пользователей зашифрованы их мастер-паролями на клиенте; дамп БД содержит
# всё необходимое, поэтому после восстановления пользователи входят прежними паролями и получают доступ к секретам.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

KEEP=14; LABEL=""; VERIFY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --label) LABEL="-$2"; shift 2 ;;
    --verify) VERIFY="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
init_instance
need_cmd gpg; need_cmd tar; need_cmd sha256sum
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || die "--keep: целое число ≥ 1"
[[ "$LABEL" =~ ^(-[A-Za-z0-9_.-]+)?$ ]] || die "--label: допустимы буквы, цифры, '.', '_', '-'"
[ -r "$BACKUP_KEY_FILE" ] || die "Нет ключа резервного шифрования: $BACKUP_KEY_FILE"

decrypt_to() { # decrypt_to ФАЙЛ КАТАЛОГ — расшифровывает и распаковывает копию
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" -d "$1" | tar -x -C "$2"
}

verify_bundle() { # verify_bundle ФАЙЛ — полная проверка копии; печатает версию и число миграций
  local f="$1" tmp
  [ -s "$f" ] || { fail "Файл копии пуст или отсутствует: $f"; return 1; }
  if [ -f "$f.json" ]; then
    local want got
    want="$(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$f.json")"
    got="$(sha256sum "$f" | cut -d' ' -f1)"
    [ -z "$want" ] || [ "$want" = "$got" ] || { fail "Контрольная сумма не совпадает (файл повреждён)"; return 1; }
  fi
  tmp="$(mktemp -d "$DATA_ROOT/tmp/verify.XXXXXX")"
  chmod 700 "$tmp"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  decrypt_to "$f" "$tmp" 2>/dev/null || { fail "Не удалось расшифровать копию (неверный ключ или файл повреждён)"; return 1; }
  [ -s "$tmp/db.dump" ] && [ -s "$tmp/manifest.json" ] && [ -s "$tmp/arklock.env" ] || { fail "В копии нет обязательных частей"; return 1; }
  dc exec -T db pg_restore -l < "$tmp/db.dump" >/dev/null 2>&1 || { fail "Дамп БД нечитаем (pg_restore -l)"; return 1; }
  local ver mig
  ver="$(sed -n 's/.*"appVersion": *"\([^"]*\)".*/\1/p' "$tmp/manifest.json")"
  mig="$(sed -n 's/.*"migrations": *\([0-9]*\).*/\1/p' "$tmp/manifest.json")"
  ok "Копия корректна: версия приложения $ver, миграций $mig"
  return 0
}

if [ -n "$VERIFY" ]; then
  mkdir -p "$DATA_ROOT/tmp"
  verify_bundle "$VERIFY"
  exit $?
fi

acquire_lock
mkdir -p "$BACKUP_DIR" "$DATA_ROOT/tmp"; chmod 700 "$BACKUP_DIR" 2>/dev/null || true
dc ps -q db | grep -q . || die "Контейнер базы данных не запущен"
free="$(free_gib "$BACKUP_DIR")"
[ "${free:-0}" -ge 1 ] || die "Недостаточно места для копии в $BACKUP_DIR (${free} ГиБ)"

umask 077
tmp="$(mktemp -d "$DATA_ROOT/tmp/backup.XXXXXX")"
trap 'rm -rf "$tmp"; rm -f "${OUT:-}.part"' EXIT
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/${COMPOSE_PROJECT_NAME}-${TS}-v$(app_version)${LABEL}.bak.gpg"

info "Дамп PostgreSQL…"
dc exec -T db pg_dump -U arklock -d arklock -Fc > "$tmp/db.dump" || die "pg_dump завершился с ошибкой"
[ -s "$tmp/db.dump" ] || die "Дамп БД пуст"
cp "$ENV_FILE" "$tmp/arklock.env"
migrations="$(dc exec -T db psql -U arklock -d arklock -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')"
printf '{\n  "format": 1,\n  "createdAt": "%s",\n  "appVersion": "%s",\n  "commit": "%s",\n  "project": "%s",\n  "migrations": %s,\n  "dumpSha256": "%s"\n}\n' \
  "$(date -u +%FT%TZ)" "$(app_version)" "$(git_commit)" "$COMPOSE_PROJECT_NAME" "${migrations:-0}" "$(sha256sum "$tmp/db.dump" | cut -d' ' -f1)" > "$tmp/manifest.json"

info "Шифрование (AES-256)…"
tar -C "$tmp" -cf - db.dump arklock.env manifest.json \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" \
        --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
        -o "$OUT.part"
[ -s "$OUT.part" ] || die "Шифрование не создало файл"
mv "$OUT.part" "$OUT"
size="$(stat -c '%s' "$OUT")"
printf '{\n  "file": "%s",\n  "size": %s,\n  "sha256": "%s",\n  "appVersion": "%s",\n  "migrations": %s,\n  "createdAt": "%s"\n}\n' \
  "$(basename "$OUT")" "$size" "$(sha256sum "$OUT" | cut -d' ' -f1)" "$(app_version)" "${migrations:-0}" "$(date -u +%FT%TZ)" > "$OUT.json"

info "Проверка созданной копии…"
verify_bundle "$OUT" || { rm -f "$OUT" "$OUT.json"; die "Созданная копия не прошла проверку и удалена"; }

# Ротация: только копии этого проекта, самые старые удаляются.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR/${COMPOSE_PROJECT_NAME}"-*.bak.gpg 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${OLD[@]}"; do [ -n "$f" ] && { rm -f -- "$f" "$f.json"; info "удалена старая копия: $(basename "$f")"; }; done

state_set backup last_file "$(basename "$OUT")"
state_set backup last_at "$(date -u +%FT%TZ)"
state_set backup last_size "$size"
ok "Резервная копия: $OUT ($(du -h "$OUT" | cut -f1))"
