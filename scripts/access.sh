#!/usr/bin/env bash
# access.sh — как пользователи открывают Arklock и готов ли первый вход.
#
#   scripts/access.sh [status]                       состояние и что осталось сделать (только чтение)
#   scripts/access.sh check                          проверки публичного адреса и прокси (только чтение)
#   scripts/access.sh proxy-help                     что настроить на внешнем прокси или WAF (только чтение)
#   scripts/access.sh set local                      только этот сервер (127.0.0.1): вход на сервере или через SSH-туннель
#   scripts/access.sh set proxy --url https://ИМЯ [--bind local|lan|all|АДРЕС] [--port ПОРТ] [--hops N]
#                                                    внешний reverse proxy или WAF уже есть (или будет настроен вами)
#   scripts/access.sh set https --domain ИМЯ [--mode letsencrypt|self-signed|existing] [--email АДРЕС] [--cert Ф --key Ф]
#                                                    HTTPS на этом сервере: Nginx и сертификат настраивает scripts/proxy.sh
#   --yes                                            не спрашивать подтверждение замены уже заданных параметров
#   --env ФАЙЛ                                       файл окружения экземпляра
#
# Изменения безопасны: данные, секреты и тома не затрагиваются, прежний файл настроек копируется в
# $DATA_ROOT/config-backups, приложение перезапускается только если параметры действительно изменились.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/access.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/access.sh"

CMD="status"; SUB=""; URL=""; BIND=""; PORT=""; HOPS=""; DOMAIN=""; MODE=""; EMAIL=""; CERT=""; KEY=""; YES=0

server_name() { hostname -f 2>/dev/null || hostname; }
lan_ip_of_host() {
  local dev
  dev="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
  [ -n "$dev" ] && ip -4 -o addr show dev "$dev" 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }'
}

cmd_status() {
  local st
  st="$(acc_state "$ENV_FILE")"
  echo "== Доступ к Arklock ($COMPOSE_PROJECT_NAME)"
  echo " Приложение слушает:   ${APP_BIND:-127.0.0.1}:${APP_PORT:-8080}"
  echo " Публичный адрес:      ${APP_PUBLIC_URL:-не задан}"
  echo " Доверенных прокси:    ${TRUSTED_PROXY_HOPS:-1}"
  if curl -fsS --max-time 5 "$(app_url_local)/api/v1/ready" >/dev/null 2>&1; then echo " Технически:           ГОТОВ (приложение отвечает)"
  else echo " Технически:           НЕ ГОТОВ (приложение не отвечает: scripts/logs.sh)"; fi
  acc_first_login "$ENV_FILE" "$(server_name)"; local ready=$?
  if [ "$st" = https ]; then
    echo
    echo " Что проверить на прокси или у сертификата: scripts/access.sh check"
  fi
  return "$ready"
}

cmd_check() {
  echo "== Проверка доступа"
  if curl -fsS --max-time 5 "$(app_url_local)/api/v1/ready" >/dev/null 2>&1; then ok "Приложение отвечает на $(app_url_local)"; else fail "Приложение не отвечает на $(app_url_local)"; return 1; fi
  acc_check_public "$ENV_FILE"; local rc=$?
  case "$rc" in
    0) ok "Доступ настроен и подтверждён." ;;
    2) warn "Часть проверок выполнить не удалось из этой сети: это не ошибка настройки. Повторите изнутри сети организации." ;;
    *) fail "Найдены ошибки настройки доступа: исправьте их и повторите scripts/access.sh check" ;;
  esac
  return "$rc"
}

backup_env() {
  local dir="$DATA_ROOT/config-backups" f
  mkdir -p "$dir" && chmod 700 "$dir"
  f="$dir/arklock.env.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$ENV_FILE" "$f" && echo "$f"
}

confirm_change() { # confirm_change ПАРАМЕТР СТАРОЕ НОВОЕ — не перезаписывает заданное молча
  local name="$1" old="$2" new="$3"
  [ -z "$old" ] || [ "$old" = "$new" ] && return 0
  [ "$YES" -eq 1 ] && return 0
  if [ -t 0 ] || (exec </dev/tty) 2>/dev/null; then
    local a; read -r -p "Заменить $name: «$old» → «$new»? [y/N] " a </dev/tty 2>/dev/null || a=""
    case "$a" in y|Y|д|Д) return 0 ;; esac
  fi
  die "$name уже задан («$old»). Чтобы заменить на «$new», повторите с --yes."
}

apply_env() { # apply_env — перезапуск приложения, если файл изменился
  local before="$1"
  if cmp -s "$before" "$ENV_FILE"; then ok "Параметры не изменились: перезапуск не нужен."; return 0; fi
  info "Применяю: пересоздание контейнера приложения (база данных и данные не затрагиваются)"
  load_env "$ENV_FILE"
  export_build_info
  dc up -d --no-build --wait --wait-timeout 180 app || { fail "Приложение не стало готовым. Прежние параметры: $2. Восстановить: cp $2 $ENV_FILE && scripts/repair.sh"; return 1; }
  wait_ready 120 || { fail "API не отвечает после перезапуска. Прежние параметры: $2"; return 1; }
  ok "Приложение перезапущено с новыми параметрами"
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
resolve_bind() { # local|lan|all|АДРЕС → IPv4
  case "$1" in
    local) echo 127.0.0.1 ;;
    lan) lan_ip_of_host || return 1 ;;
    all) echo 0.0.0.0 ;;
    *) [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && echo "$1" || return 1 ;;
  esac
}

cmd_set() {
  need_root
  local before bak new_bind
  before="$(mktemp)"; cp -p "$ENV_FILE" "$before"
  case "$SUB" in
    local)
      [ -z "$URL$DOMAIN" ] || die "set local не принимает --url и --domain: для публичного адреса используйте set proxy или set https"
      bak="$(backup_env)" || die "Не удалось сохранить копию настроек"
      confirm_change APP_BIND "${APP_BIND:-}" 127.0.0.1
      # «только этот сервер» означает и отсутствие публичного адреса; прежний адрес сохранён в копии настроек
      confirm_change APP_PUBLIC_URL "${APP_PUBLIC_URL:-}" "(не задан)"
      env_set "$ENV_FILE" APP_BIND 127.0.0.1
      env_unset "$ENV_FILE" APP_PUBLIC_URL
      [ -z "$PORT" ] || { valid_port "$PORT" || die "Некорректный порт: $PORT"; env_set "$ENV_FILE" APP_PORT "$PORT"; }
      apply_env "$before" "$bak" || return 1
      ;;
    proxy)
      [ -n "$URL" ] || die "set proxy требует --url https://ИМЯ (публичный адрес, по которому пользователи откроют Arklock)"
      [ "$(acc_url_kind "$URL")" = https ] || die "Публичный адрес должен начинаться с https:// (получено: $URL). Браузер не разрешает шифрование на http, кроме localhost."
      URL="${URL%/}"
      [ -z "$HOPS" ] || { [[ "$HOPS" =~ ^[0-5]$ ]] || die "--hops: число прокси от 0 до 5"; }
      [ -z "$PORT" ] || valid_port "$PORT" || die "Некорректный порт: $PORT"
      if [ -n "$BIND" ]; then new_bind="$(resolve_bind "$BIND")" || die "Некорректный --bind: $BIND (local, lan, all или IPv4-адрес сервера)"
        if [ "$new_bind" != 0.0.0.0 ] && [ "$new_bind" != 127.0.0.1 ] && ! ip -4 addr show | grep -qw "$new_bind"; then die "Адрес $new_bind не назначен этому серверу"; fi
      fi
      bak="$(backup_env)" || die "Не удалось сохранить копию настроек"
      confirm_change APP_PUBLIC_URL "${APP_PUBLIC_URL:-}" "$URL"
      env_set "$ENV_FILE" APP_PUBLIC_URL "$URL"
      if [ -n "$BIND" ]; then confirm_change APP_BIND "${APP_BIND:-}" "$new_bind"; env_set "$ENV_FILE" APP_BIND "$new_bind"; fi
      [ -z "$PORT" ] || env_set "$ENV_FILE" APP_PORT "$PORT"
      [ -z "$HOPS" ] || env_set "$ENV_FILE" TRUSTED_PROXY_HOPS "$HOPS"
      [ -n "$(env_get "$ENV_FILE" TRUSTED_PROXY_HOPS)" ] || env_set "$ENV_FILE" TRUSTED_PROXY_HOPS 1
      apply_env "$before" "$bak" || return 1
      load_env "$ENV_FILE"
      echo
      echo "Что настроить на стороне прокси или WAF:"
      acc_proxy_help "$ENV_FILE" "$(lan_ip_of_host)"
      ;;
    https)
      [ -n "$DOMAIN" ] || die "set https требует --domain ИМЯ"
      [ -x "$REPO_ROOT/scripts/proxy.sh" ] || die "Не найден scripts/proxy.sh"
      bak="$(backup_env)" || die "Не удалось сохранить копию настроек"
      confirm_change APP_PUBLIC_URL "${APP_PUBLIC_URL:-}" "https://$DOMAIN"
      local args=(setup --env "$ENV_FILE" --domain "$DOMAIN" --mode "${MODE:-letsencrypt}")
      [ -z "$EMAIL" ] || args+=(--email "$EMAIL")
      [ -z "$CERT" ] || args+=(--cert "$CERT" --key "$KEY")
      "$REPO_ROOT/scripts/proxy.sh" "${args[@]}" || { fail "HTTPS не настроен. Прежние параметры: $bak"; return 1; }
      ;;
    *) die "set: укажите local, proxy или https (см. --help)" ;;
  esac
  rm -f "$before"
  load_env "$ENV_FILE"
  echo
  cmd_status
}

main() {
CMD="status"; SUB=""; URL=""; BIND=""; PORT=""; HOPS=""; DOMAIN=""; MODE=""; EMAIL=""; CERT=""; KEY=""; YES=0
if [ $# -gt 0 ]; then case "$1" in -*) ;; *) CMD="$1"; shift ;; esac; fi
if [ "$CMD" = set ]; then SUB="${1:-}"; [ $# -gt 0 ] && shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --bind) BIND="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --hops) HOPS="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --cert) CERT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1 (см. --help)" ;;
  esac
done
init_instance
case "$CMD" in
  status) cmd_status ;;
  check) cmd_check ;;
  proxy-help) acc_proxy_help "$ENV_FILE" "$(lan_ip_of_host)" ;;
  set) cmd_set ;;
  *) die "Неизвестная команда: $CMD (status, check, proxy-help, set; см. --help)" ;;
esac
}

# запуск только при прямом вызове: тесты подключают файл и вызывают main сами
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
