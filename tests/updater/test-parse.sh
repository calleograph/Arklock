#!/usr/bin/env bash
# Проверка разбора запросов помощника обновлений: допустимые запросы принимаются, всё остальное отвергается.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ARKLOCK_UPDATER_LIB_ONLY=1
# shellcheck source=/dev/null
. "$HERE/../../scripts/updater.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILS=0
ID='123e4567-e89b-42d3-a456-426614174000'
case_ok() { # case_ok ОПИСАНИЕ СОДЕРЖИМОЕ
  printf '%b' "$2" > "$TMP/req"
  if parse_request "$TMP/req"; then echo "ok   $1"; else echo "FAIL $1 (отвергнут: $REQ_ERR)"; FAILS=$((FAILS + 1)); fi
}
case_bad() {
  printf '%b' "$2" > "$TMP/req"
  if parse_request "$TMP/req"; then echo "FAIL $1 (принят)"; FAILS=$((FAILS + 1)); else echo "ok   $1 -> $REQ_ERR"; fi
}
case_ok "check" "request_id=$ID\naction=check\nby=$ID\nat=2026-10-11T10:00:00Z\n"
case_ok "update с версией" "request_id=$ID\naction=update\nversion=v1.2.3\nby=$ID\n"
case_ok "rollback с восстановлением" "request_id=$ID\naction=rollback\nwith_restore=1\n"
case_ok "backup с меткой" "request_id=$ID
action=backup
label=manual
by=$ID
"
case_ok "backup_verify" "request_id=$ID
action=backup_verify
file=arklock-20261012T010203Z-v0.1.0.bak.gpg
"
case_ok "backup_delete" "request_id=$ID
action=backup_delete
file=arklock-20261012T010203Z-v0.1.0-auto.bak.gpg
"
case_ok "restore" "request_id=$ID
action=restore
file=arklock-20261012T010203Z-v0.1.0.bak.gpg
"
case_ok "logs" "request_id=$ID
action=logs
service=app
lines=200
"
case_ok "schedule" "request_id=$ID
action=schedule
schedule_enabled=1
schedule_hour=3
schedule_keep=14
"
case_bad "копия: выход из каталога" "request_id=$ID
action=backup_delete
file=../../etc/passwd.bak.gpg
"
case_bad "копия: подкаталог" "request_id=$ID
action=backup_delete
file=sub/a.bak.gpg
"
case_bad "копия: двойная точка" "request_id=$ID
action=backup_verify
file=a..b.bak.gpg
"
case_bad "копия: чужое расширение" "request_id=$ID
action=backup_verify
file=a.tar
"
case_bad "копия: внедрение команды" "request_id=$ID
action=backup_delete
file=a;id.bak.gpg
"
case_bad "delete без файла" "request_id=$ID
action=backup_delete
"
case_bad "метка с разделителем" "request_id=$ID
action=backup
label=a;b
"
case_bad "logs: чужая служба" "request_id=$ID
action=logs
service=other
lines=100
"
case_bad "logs: слишком много строк" "request_id=$ID
action=logs
service=app
lines=99999
"
case_bad "logs без параметров" "request_id=$ID
action=logs
"
case_bad "schedule: час 25" "request_id=$ID
action=schedule
schedule_enabled=1
schedule_hour=25
schedule_keep=14
"
case_bad "schedule: неполный" "request_id=$ID
action=schedule
schedule_enabled=1
"
case_bad "неизвестное действие" "request_id=$ID\naction=shell\n"
case_bad "внедрение команды в версию" "request_id=$ID\naction=update\nversion=v1.2.3;id\n"
case_bad "версия без v" "request_id=$ID\naction=update\nversion=1.2.3\n"
case_bad "update без версии" "request_id=$ID\naction=update\n"
case_bad "лишний параметр" "request_id=$ID\naction=check\nimage=evil/image\n"
case_bad "путь в параметре" "request_id=$ID\naction=check\npath=/etc/passwd\n"
case_bad "строка без равенства" "request_id=$ID\naction=check\nrm -rf /\n"
case_bad "неверный request_id" "request_id=abc\naction=check\n"
case_bad "нет request_id" "action=check\n"
case_bad "with_restore=2" "request_id=$ID\naction=rollback\nwith_restore=2\n"
head -c 5000 /dev/zero | tr '\0' 'a' > "$TMP/big"
if parse_request "$TMP/big"; then echo "FAIL большой файл принят"; FAILS=$((FAILS + 1)); else echo "ok   большой файл -> $REQ_ERR"; fi
ln -s "$TMP/req" "$TMP/link" 2>/dev/null
if [ -L "$TMP/link" ]; then
  if parse_request "$TMP/link"; then echo "FAIL символическая ссылка принята"; FAILS=$((FAILS + 1)); else echo "ok   символическая ссылка -> $REQ_ERR"; fi
fi
[ "$FAILS" -eq 0 ] || { echo "Не пройдено: $FAILS"; exit 1; }
echo "Все проверки разбора запросов пройдены"
