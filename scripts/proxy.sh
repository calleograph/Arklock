#!/usr/bin/env bash
# proxy.sh — HTTPS и Nginx для Arklock: установка, настройка, сертификаты, продление.
#   scripts/proxy.sh setup --domain ДОМЕН [--mode letsencrypt|self-signed|existing] [--email АДРЕС]
#                          [--cert ФАЙЛ --key ФАЙЛ] [--staging] [--env ФАЙЛ]
#   scripts/proxy.sh print  --domain ДОМЕН [--env ФАЙЛ]   вывести конфигурацию Nginx, ничего не меняя (общий сервер)
#   scripts/proxy.sh status [--env ФАЙЛ]                  состояние: конфигурация, сертификат, срок, продление
#   scripts/proxy.sh renew  [--env ФАЙЛ]                  продлить сертификат сейчас (и перезагрузить Nginx)
#   scripts/proxy.sh remove [--env ФАЙЛ]                  убрать конфигурацию Arklock из Nginx (сертификаты остаются)
#
# Режимы сертификата:
#   letsencrypt  бесплатный сертификат Let's Encrypt (certbot, проверка по HTTP на порту 80); продление — таймером certbot
#                с перезагрузкой Nginx. Нужны публичное DNS-имя, указывающее на этот сервер, и открытые порты 80 и 443.
#   self-signed  самоподписанный сертификат (закрытые сети, проверки): создаётся openssl, срок 825 дней; браузер предупредит,
#                если сертификат не добавлен в доверенные; `renew` выпускает новый.
#   existing     ваш сертификат и ключ (--cert, --key): проверяется, что ключ подходит к сертификату.
#
# Что делает setup: ставит Nginx (и certbot) пакетами apt, если их нет (только Debian/Ubuntu и только если Nginx ещё не
# обслуживает другие сайты — иначе используйте `print`), пишет /etc/nginx/conf.d/arklock-<проект>.conf, проверяет `nginx -t`
# (при ошибке возвращает прежнюю конфигурацию), записывает APP_PUBLIC_URL и TRUSTED_PROXY_HOPS=1 в файл окружения,
# перезапускает приложение. Прокси передаёт реальный адрес клиента (X-Forwarded-For перезаписывается, а не дополняется:
# подделать его нельзя), включает HSTS, перенаправляет http → https, отключает буферизацию больших ответов.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CMD="${1:-}"; [ $# -gt 0 ] && shift
DOMAIN=""; MODE="letsencrypt"; EMAIL=""; CERT=""; KEY=""; STAGING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --staging) STAGING=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done
[ -n "$CMD" ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

NGINX_CONF_DIR="${ARKLOCK_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
ACME_ROOT="${ARKLOCK_ACME_ROOT:-/var/www/arklock-acme}"
LE_LIVE="${ARKLOCK_LE_LIVE:-/etc/letsencrypt/live}"

valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] && [ "${#1}" -le 253 ]; }

# Конфигурация Nginx. Аргументы: домен порт_приложения сертификат ключ [только_http]
render_conf() {
  local domain="$1" port="$2" cert="$3" key="$4" http_only="${5:-0}" v6_80="" v6_443="" upstream
  # приложение слушает APP_BIND (по умолчанию loopback); при 0.0.0.0 подключаемся к loopback
  upstream="${APP_BIND:-127.0.0.1}"
  [ "$upstream" != 0.0.0.0 ] || upstream=127.0.0.1
  # IPv6 включается только там, где он есть: иначе Nginx не запустится
  if [ -s /proc/net/if_inet6 ]; then v6_80=$'    listen [::]:80;
'; v6_443=$'    listen [::]:443 ssl http2;
'; fi
  cat <<EOF
# Создано scripts/proxy.sh для Arklock («$COMPOSE_PROJECT_NAME»). Изменения вручную сохраняются до следующего запуска setup.
server {
    listen 80;
${v6_80}    server_name $domain;

    # проверка домена Let's Encrypt
    location /.well-known/acme-challenge/ {
        root $ACME_ROOT;
    }
EOF
  if [ "$http_only" = 1 ]; then
    cat <<EOF
    location / { return 404; }
}
EOF
    return
  fi
  cat <<EOF
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
${v6_443}    server_name $domain;

    ssl_certificate     $cert;
    ssl_certificate_key $key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:arklock_tls:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    server_tokens off;

    # вложения передаются частями до нескольких МиБ; JSON-запросы малы
    client_max_body_size 32m;
    client_body_timeout 120s;

    location / {
        proxy_pass http://$upstream:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        # реальный адрес клиента: заголовок перезаписывается, а не дополняется (приложение доверяет одному прокси)
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        # большие файлы идут потоком, без промежуточных файлов Nginx
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
}

conf_path() { printf '%s/arklock-%s.conf' "$NGINX_CONF_DIR" "$COMPOSE_PROJECT_NAME"; }
tls_dir() { printf '%s/tls' "$(dirname "$ENV_FILE")"; }

cert_fingerprint_matches() { # сертификат и ключ — одна пара
  local a b
  a="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl sha256 | awk '{print $NF}')"
  b="$(openssl pkey -in "$2" -pubout 2>/dev/null | openssl sha256 | awk '{print $NF}')"
  [ -n "$a" ] && [ "$a" = "$b" ]
}

make_self_signed() { # make_self_signed ДОМЕН ЦЕЛЕВОЙ_КАТАЛОГ
  local domain="$1" dir="$2" san
  install -d -m 0700 "$dir"
  if [[ "$domain" =~ ^[0-9.]+$ ]]; then san="IP:$domain"; else san="DNS:$domain"; fi
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 825 -subj "/CN=$domain" -addext "subjectAltName=$san" \
    -keyout "$dir/privkey.pem" -out "$dir/fullchain.pem" >/dev/null 2>&1 || die "openssl не создал сертификат"
  chmod 600 "$dir/privkey.pem"; chmod 644 "$dir/fullchain.pem"
}

need_pkgs() { # need_pkgs ПАКЕТ… — ставит недостающие через apt (Debian/Ubuntu)
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ "${#missing[@]}" -eq 0 ] && return 0
  command -v apt-get >/dev/null 2>&1 || die "Не найден apt-get: установите вручную пакеты: ${missing[*]}"
  info "Установка пакетов: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null || die "Пакеты не установлены: ${missing[*]}"
}

reload_nginx() {
  nginx -t >/dev/null 2>&1 || return 1
  if systemctl is-active --quiet nginx 2>/dev/null; then systemctl reload nginx; else systemctl enable --now nginx >/dev/null 2>&1 || nginx; fi
}

# Записывает конфигурацию; при неудаче проверки возвращает прежнюю.
install_conf() { # install_conf ТЕКСТ_ФАЙЛ
  local target prev=""; target="$(conf_path)"
  install -d -m 0755 "$NGINX_CONF_DIR"
  if [ -f "$target" ]; then prev="$(mktemp)"; cp -f "$target" "$prev"; fi
  cp -f "$1" "$target"; chmod 644 "$target"
  if ! reload_nginx; then
    if [ -n "$prev" ]; then cp -f "$prev" "$target"; else rm -f "$target"; fi
    reload_nginx || true
    [ -z "$prev" ] || rm -f "$prev"
    nginx -t 2>&1 | tail -n 5 >&2 || true
    die "Nginx отклонил конфигурацию; прежнее состояние возвращено"
  fi
  [ -z "$prev" ] || rm -f "$prev"
}

other_sites_present() { # обслуживает ли Nginx что-то кроме Arklock
  [ -d "$NGINX_CONF_DIR" ] || return 1
  local f
  for f in "$NGINX_CONF_DIR"/*.conf /etc/nginx/sites-enabled/*; do
    [ -e "$f" ] || continue
    [ "$(basename "$f")" = "arklock-${COMPOSE_PROJECT_NAME}.conf" ] && continue
    [ "$(basename "$f")" = "default" ] && continue
    return 0
  done
  return 1
}

apply_app_env() { # apply_app_env ДОМЕН
  env_set "$ENV_FILE" APP_PUBLIC_URL "https://$1"
  env_set "$ENV_FILE" TRUSTED_PROXY_HOPS 1
  if dc ps -q app 2>/dev/null | grep -q .; then
    info "Перезапуск приложения с новым публичным адресом…"
    export_build_info
    dc up -d --no-build --wait --wait-timeout 180 app >/dev/null || die "Приложение не стало готовым после смены адреса (scripts/logs.sh)"
  fi
}

cmd_print() {
  valid_domain "$DOMAIN" || die "Укажите --domain (имя сервера)"
  render_conf "$DOMAIN" "${APP_PORT:-8080}" "${CERT:-/etc/ssl/arklock/fullchain.pem}" "${KEY:-/etc/ssl/arklock/privkey.pem}"
}

cmd_setup() {
  need_root
  valid_domain "$DOMAIN" || die "Укажите корректное имя сервера: --domain arklock.example.com"
  case "$MODE" in letsencrypt|self-signed|existing) ;; *) die "--mode: letsencrypt, self-signed или existing" ;; esac
  [ "$MODE" != letsencrypt ] || [[ "$EMAIL" =~ ^[^@\ ]+@[^@\ ]+\.[^@\ ]+$ ]] || die "Для Let's Encrypt нужен --email (уведомления об истечении)"
  if [ "$MODE" = existing ]; then
    [ -r "$CERT" ] && [ -r "$KEY" ] || die "Укажите читаемые --cert и --key"
    cert_fingerprint_matches "$CERT" "$KEY" || die "Ключ не соответствует сертификату"
    openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null || die "Срок действия сертификата истёк"
  fi
  need_cmd openssl
  if command -v nginx >/dev/null 2>&1 && other_sites_present && [ "${ARKLOCK_PROXY_FORCE:-0}" != 1 ]; then
    die "Nginx уже обслуживает другие сайты. Автоматическая настройка их не затрагивает только через вывод конфигурации: scripts/proxy.sh print --domain $DOMAIN (подключите результат сами). Для принудительного режима: ARKLOCK_PROXY_FORCE=1."
  fi
  need_pkgs nginx
  [ "$MODE" != letsencrypt ] || need_pkgs certbot
  command -v nginx >/dev/null 2>&1 || die "Nginx не установлен"
  local port="${APP_PORT:-8080}" tmp cert key
  # переменная глобальная: ловушка выхода срабатывает уже после выхода из функции
  PROXY_TMP="$(mktemp)"; tmp="$PROXY_TMP"
  trap 'rm -f "${PROXY_TMP:-}"' EXIT

  case "$MODE" in
    self-signed)
      local d; d="$(tls_dir)/$DOMAIN"
      [ -s "$d/fullchain.pem" ] && openssl x509 -in "$d/fullchain.pem" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 || make_self_signed "$DOMAIN" "$d"
      cert="$d/fullchain.pem"; key="$d/privkey.pem" ;;
    existing)
      cert="$CERT"; key="$KEY" ;;
    letsencrypt)
      install -d -m 0755 "$ACME_ROOT"
      cert="$LE_LIVE/$DOMAIN/fullchain.pem"; key="$LE_LIVE/$DOMAIN/privkey.pem"
      if [ ! -s "$cert" ]; then
        # сначала только порт 80, чтобы Let's Encrypt мог проверить домен
        render_conf "$DOMAIN" "$port" "$cert" "$key" 1 > "$tmp"
        install_conf "$tmp"
        info "Получение сертификата Let's Encrypt для $DOMAIN…"
        local args=(certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring)
        [ "$STAGING" -eq 0 ] || args+=(--staging)
        certbot "${args[@]}" || die "Сертификат не получен. Проверьте: имя $DOMAIN указывает на этот сервер, порт 80 открыт извне."
      fi
      # продление: перезагрузка Nginx после выпуска нового сертификата
      install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
      printf '#!/bin/sh\n# Arklock: подхватить продлённый сертификат\nnginx -t >/dev/null 2>&1 && systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/arklock-reload.sh
      chmod 755 /etc/letsencrypt/renewal-hooks/deploy/arklock-reload.sh
      systemctl enable --now certbot.timer >/dev/null 2>&1 || warn "Таймер продления certbot не включён: настройте продление вручную (certbot renew)" ;;
  esac

  render_conf "$DOMAIN" "$port" "$cert" "$key" > "$tmp"
  install_conf "$tmp"
  ok "Nginx настроен: https://$DOMAIN → 127.0.0.1:$port ($(conf_path))"
  apply_app_env "$DOMAIN"
  state_set proxy domain "$DOMAIN"; state_set proxy mode "$MODE"; state_set proxy configured_at "$(date -u +%FT%TZ)"
  ok "Готово: $(env_get "$ENV_FILE" APP_PUBLIC_URL)"
}

cmd_status() {
  local conf rc=0 domain mode
  conf="$(conf_path)"; domain="$(state_get proxy domain)"; mode="$(state_get proxy mode)"
  if [ -f "$conf" ]; then ok "Конфигурация Nginx: $conf"; else fail "Конфигурации Nginx нет ($conf)"; rc=1; fi
  if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then ok "nginx -t: без ошибок"; else fail "nginx -t сообщает об ошибках или Nginx не установлен"; rc=1; fi
  if systemctl is-active --quiet nginx 2>/dev/null; then ok "Nginx работает"; else fail "Nginx не запущен"; rc=1; fi
  if [ -n "$domain" ]; then
    local cert
    case "$mode" in
      letsencrypt) cert="$LE_LIVE/$domain/fullchain.pem" ;;
      self-signed) cert="$(tls_dir)/$domain/fullchain.pem" ;;
      *) cert="$(sed -n 's/^ *ssl_certificate  *\([^;]*\);.*/\1/p' "$conf" 2>/dev/null | head -n1)" ;;
    esac
    if [ -n "${cert:-}" ] && [ -r "$cert" ]; then
      local end; end="$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2)"
      if openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then
        if openssl x509 -in "$cert" -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then ok "Сертификат $domain действует до $end"
        else warn "Сертификат $domain истекает $end (меньше 14 дней)"; fi
      else fail "Сертификат $domain ИСТЁК ($end)"; rc=1; fi
    else fail "Файл сертификата не найден"; rc=1; fi
    if [ "$mode" = letsencrypt ]; then
      if systemctl is-active --quiet certbot.timer 2>/dev/null; then ok "Автоматическое продление включено (certbot.timer)"; else warn "Таймер продления certbot не активен"; fi
    fi
  else
    info "Прокси ещё не настраивался этим сценарием"
  fi
  return "$rc"
}

cmd_renew() {
  need_root
  local domain mode; domain="$(state_get proxy domain)"; mode="$(state_get proxy mode)"
  [ -n "$domain" ] || die "Прокси не настроен (scripts/proxy.sh setup)"
  case "$mode" in
    letsencrypt) certbot renew --non-interactive && reload_nginx && ok "Сертификат проверен/продлён" ;;
    self-signed) make_self_signed "$domain" "$(tls_dir)/$domain"; reload_nginx && ok "Выпущен новый самоподписанный сертификат" ;;
    *) die "Сертификат режима «$mode» продлевается вами" ;;
  esac
}

cmd_remove() {
  need_root
  rm -f "$(conf_path)"
  reload_nginx || true
  state_set proxy domain ""; state_set proxy mode ""
  ok "Конфигурация Arklock удалена из Nginx (сертификаты и пакеты не затронуты)"
}

case "$CMD" in
  print) init_instance; cmd_print ;;
  setup) init_instance; cmd_setup ;;
  status) init_instance; cmd_status ;;
  renew) init_instance; cmd_renew ;;
  remove) init_instance; cmd_remove ;;
  *) die "Неизвестная команда: $CMD" ;;
esac
