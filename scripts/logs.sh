#!/usr/bin/env bash
# logs.sh — журналы контейнеров Arklock с маскированием токенов и паролей.
#   scripts/logs.sh [app|db] [-f] [-n СТРОК]
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
SVC=""; FOLLOW=""; N=200
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    -f) FOLLOW="-f"; shift ;;
    -n) N="$2"; shift 2 ;;
    app|db) SVC="$1"; shift ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
[[ "$N" =~ ^[0-9]+$ ]] || die "-n: целое число"
init_instance
# shellcheck disable=SC2086
dc logs --no-color --tail "$N" $FOLLOW $SVC 2>&1 | mask_text_stream
