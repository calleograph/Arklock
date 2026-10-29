#!/usr/bin/env bash
# Доступ к Arklock и готовность к первому входу. Подключается через `source` после common.sh, сама ничего не выполняет.
#
# Почему это отдельная тема: контейнеры могут работать исправно, а создать первую учётную запись нельзя — браузер даёт
# шифровать мастер-пароль только по HTTPS или на localhost. Здесь «технически запущено» и «готово к первому входу»
# различаются явно, а недостающее называется вместе с командой, которая это исправляет (scripts/access.sh).
#
# Состояния (acc_state):
#   https        задан публичный адрес https://… (HTTPS на этом сервере или внешний прокси/WAF)
#   local        приложение слушает только 127.0.0.1, публичного адреса нет: вход на самом сервере или через SSH-туннель
#   incomplete   приложение доступно по сети (APP_BIND не loopback), а HTTPS-адреса нет: вход по http://IP не заработает
#   invalid      публичный адрес задан без HTTPS (кроме localhost)

# shellcheck shell=bash

acc_url_kind() { # acc_url_kind URL → https | localhost | http | invalid
  local u="$1" host
  case "$u" in
    https://*) host="${u#https://}" ;;
    http://*) host="${u#http://}" ;;
    *) echo invalid; return 0 ;;
  esac
  host="${host%%/*}"
  [ -n "$host" ] || { echo invalid; return 0; }
  host="${host%%:*}"
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo invalid; return 0; }
  case "$u" in
    https://*) echo https ;;
    *) case "$host" in localhost|127.0.0.1) echo localhost ;; *) echo http ;; esac ;;
  esac
}

acc_state() { # acc_state ФАЙЛ_ОКРУЖЕНИЯ
  local env="$1" url bind
  url="$(env_get "$env" APP_PUBLIC_URL)"
  bind="$(env_get "$env" APP_BIND)"; bind="${bind:-127.0.0.1}"
  if [ -n "$url" ]; then
    case "$(acc_url_kind "$url")" in
      https) echo https; return 0 ;;
      localhost) echo local; return 0 ;;
      *) echo invalid; return 0 ;;
    esac
  fi
  if [ "$bind" = 127.0.0.1 ]; then echo local; else echo incomplete; fi
}

# Хост и порт для сообщений о туннеле: приложение слушает loopback (или конкретный адрес сервера).
acc_local_port() { local p; p="$(env_get "$1" APP_PORT)"; echo "${p:-8080}"; }

acc_tunnel_hint() { # acc_tunnel_hint ФАЙЛ [ИМЯ_СЕРВЕРА]
  local env="$1" host="${2:-<адрес-сервера>}" port
  port="$(acc_local_port "$env")"
  cat <<EOF
   На своём компьютере выполните:  ssh -L ${port}:127.0.0.1:${port} <пользователь>@${host}
   и откройте в браузере:          http://localhost:${port}
   (localhost для браузера — защищённый контекст: учётная запись создаётся без HTTPS и без домена)
EOF
}

# Что нужно сделать на стороне прокси или WAF. Печатается и при установке, и по `scripts/access.sh proxy-help`.
acc_proxy_help() { # acc_proxy_help ФАЙЛ [IP_СЕРВЕРА]
  local env="$1" lan="${2:-}" url bind port hops upstream where
  url="$(env_get "$env" APP_PUBLIC_URL)"
  bind="$(env_get "$env" APP_BIND)"; bind="${bind:-127.0.0.1}"
  port="$(acc_local_port "$env")"
  hops="$(env_get "$env" TRUSTED_PROXY_HOPS)"; hops="${hops:-1}"
  case "$bind" in
    127.0.0.1) upstream="127.0.0.1:${port}"; where="прокси должен работать на ЭТОМ же сервере (приложение слушает только 127.0.0.1)" ;;
    0.0.0.0) upstream="${lan:-<адрес-этого-сервера>}:${port}"; where="приложение слушает все адреса сервера: ограничьте порт ${port} фаерволом, пропуская только прокси" ;;
    *) upstream="${bind}:${port}"; where="прокси может быть на другом сервере локальной сети; порт ${port} откройте только для него" ;;
  esac
  cat <<EOF
   Адрес для пользователей:   ${url:-<https://имя-сервера — задайте: scripts/access.sh set proxy --url …>}
   Куда направлять запросы:   http://${upstream}   (${where})
   Что должен делать прокси:
     1. принимать HTTPS на публичном имени и передавать запросы приложению по http (путь не менять);
     2. передавать заголовки  Host (исходный), X-Forwarded-For (адрес клиента, а не прежнее значение заголовка),
        X-Forwarded-Proto (https) — по ним приложение узнаёт адрес клиента и защищённое соединение;
     3. разрешить тела запросов до 32 МБ (вложения передаются частями) и ответы без буферизации, таймаут чтения от 10 минут;
     4. не кэшировать /api/ и не перенаправлять /api/v1/… на другой путь.
   В приложении:              TRUSTED_PROXY_HOPS=${hops} (число прокси между клиентом и Arklock; менять: scripts/access.sh set proxy --hops N)
   Проверка с сервера:        scripts/access.sh check
EOF
}

# Сведения для итогового сообщения. Печатает блок «Первый вход» и возвращает 0, если вход возможен сразу.
acc_first_login() { # acc_first_login ФАЙЛ [ИМЯ_СЕРВЕРА]
  local env="$1" host="${2:-}" st url port
  st="$(acc_state "$env")"; url="$(env_get "$env" APP_PUBLIC_URL)"; port="$(acc_local_port "$env")"
  case "$st" in
    https)
      echo " Первый вход:      ГОТОВ — откройте $url"
      return 0 ;;
    local)
      echo " Первый вход:      ГОТОВ ЛОКАЛЬНО — http://localhost:${port} на самом сервере либо через SSH-туннель:"
      acc_tunnel_hint "$env" "$host"
      echo "   Для остальных сотрудников нужен HTTPS: scripts/access.sh set https|proxy (без переустановки, данные сохраняются)."
      return 0 ;;
    incomplete)
      echo " Первый вход:      НЕ ГОТОВ — приложение запущено и доступно по сети, но браузер не даст создать учётную запись"
      echo "   по http://<адрес>:${port}: шифрование работает только по HTTPS или на localhost. Выберите один путь:"
      echo "     • HTTPS на этом сервере:     scripts/access.sh set https --domain ИМЯ [--mode letsencrypt|self-signed|existing]"
      echo "     • внешний прокси или WAF:    scripts/access.sh set proxy --url https://ИМЯ  (что настроить на прокси: scripts/access.sh proxy-help)"
      echo "     • только проверка локально:  scripts/access.sh set local  (потом SSH-туннель, см. scripts/access.sh status)"
      return 1 ;;
    *)
      echo " Первый вход:      НЕ ГОТОВ — публичный адрес «$url» задан без HTTPS"
      echo "   Укажите https://… : scripts/access.sh set proxy --url https://ИМЯ"
      return 1 ;;
  esac
}

# --- сетевые проверки публичного адреса -----------------------------------------------------------------------------
# Адрес организации часто доступен только из внутренней сети. Поэтому «не удалось проверить» — предупреждение с
# объяснением, а не ошибка: установка от этого не считается неудачной.

acc_http_json() { # acc_http_json URL → тело ответа (stdout) и код завершения curl
  curl -sS --max-time 10 --connect-timeout 5 -H 'Accept: application/json' "$1" 2>&1
}

acc_json_get() { # acc_json_get JSON КЛЮЧ → значение (простые строки, числа, true/false, null); пробелы вокруг «:» допускаются
  printf '%s' "$1" | grep -o "\"$2\": *\(\"[^\"]*\"\|[^,}]*\)" | head -n 1 | sed 's/^[^:]*: *//' | tr -d '"'
}

# acc_check_public ФАЙЛ — печатает результат каждой проверки; код 0 — всё подтверждено, 2 — часть проверок
# выполнить не удалось (нет доступа из этой сети), 1 — найдена ошибка настройки.
acc_check_public() {
  local env="$1" url host out rc code body bad=0 unknown=0 local_json commit_local commit_remote
  url="$(env_get "$env" APP_PUBLIC_URL)"
  local_json="$(curl -fsS --max-time 5 "http://127.0.0.1:$(acc_local_port "$env")/api/v1/version" 2>/dev/null || true)"
  if [ -z "$url" ]; then
    echo "[--] Публичный адрес не задан: проверять нечего (режим локального доступа)."
    return 0
  fi
  if [ "$(acc_url_kind "$url")" != https ]; then
    echo "[FAIL] Публичный адрес «$url» не HTTPS: задайте https://… (scripts/access.sh set proxy --url …)"
    return 1
  fi
  host="${url#https://}"; host="${host%%/*}"; host="${host%%:*}"
  if ! getent hosts "$host" >/dev/null 2>&1; then
    echo "[--] Имя $host не разрешается с этого сервера. Если адрес доступен только из внутренней сети или из другой сети, это нормально:"
    echo "     выполните scripts/access.sh check с компьютера или сервера внутри этой сети. Здесь HTTPS проверить нельзя."
    return 2
  fi
  out="$(acc_http_json "${url%/}/api/v1/access")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$rc" in
      60|51|35|58|59|77|83) echo "[FAIL] Сертификат или TLS на $url не прошли проверку: ${out##*curl: }"
        echo "       Установите действительный сертификат на прокси (или добавьте корневой сертификат организации в доверенные на этом сервере)."; bad=1 ;;
      28|7|6) echo "[--] $url не отвечает с этого сервера (${out##*curl: }). Адрес может быть доступен только из другой сети или прокси ещё не настроен."
        echo "     Проверьте на прокси: публичное имя → http://$(env_get "$env" APP_BIND || true):$(acc_local_port "$env"); затем повторите scripts/access.sh check."; unknown=1 ;;
      *) echo "[--] Не удалось проверить $url: ${out##*curl: }"; unknown=1 ;;
    esac
  else
    code="$(printf '%s' "$out" | head -c 1)"
    if [ "$code" != "{" ]; then
      echo "[FAIL] $url отвечает, но это не Arklock (получен не JSON): прокси направляет запросы не на это приложение или меняет путь /api/v1/…"; bad=1
    else
      body="$out"
      commit_local="$(acc_json_get "$local_json" commit)"
      commit_remote=""
      if [ "$(acc_json_get "$body" protocol)" = https ] && [ "$(acc_json_get "$body" secure)" = true ]; then
        echo "[ok] $url открывается по HTTPS, приложение видит защищённое соединение."
      else
        bad=1
        if [ "$(acc_json_get "$body" trustedProxyHops)" = 0 ] && [ -n "$(acc_json_get "$body" forwardedProto)" ] && [ "$(acc_json_get "$body" forwardedProto)" != null ]; then
          echo "[FAIL] Прокси передаёт X-Forwarded-Proto, но приложение не доверяет прокси (TRUSTED_PROXY_HOPS=0)."
          echo "       Исправление: scripts/access.sh set proxy --url $url --hops 1"
        else
          echo "[FAIL] Приложение видит соединение как http: прокси не передаёт заголовок X-Forwarded-Proto: https (или перед Arklock больше прокси, чем указано в TRUSTED_PROXY_HOPS)."
          echo "       Добавьте на прокси  proxy_set_header X-Forwarded-Proto \$scheme;  (scripts/access.sh proxy-help)."
        fi
      fi
      if [ "$(acc_json_get "$body" publicMatches)" = true ]; then
        echo "[ok] Адрес в запросе совпадает с APP_PUBLIC_URL ($url)."
      else
        bad=1
        echo "[FAIL] Узел в запросе ($(acc_json_get "$body" host)) не совпадает с APP_PUBLIC_URL ($url): прокси должен передавать исходный Host."
        echo "       Добавьте  proxy_set_header Host \$host;  либо исправьте адрес: scripts/access.sh set proxy --url …"
      fi
      if [ "$(acc_json_get "$body" firstUser)" = true ]; then
        echo "[..] Первая учётная запись ещё не создана: откройте $url и введите одноразовый код настройки (BOOTSTRAP_TOKEN в $env)."
      else
        echo "[ok] Первая учётная запись уже создана."
      fi
      remote_ver="$(curl -sS --max-time 10 "${url%/}/api/v1/version" 2>/dev/null || true)"
      commit_remote="$(acc_json_get "$remote_ver" commit)"
      if [ -n "$commit_local" ] && [ -n "$commit_remote" ]; then
        if [ "$commit_local" = "$commit_remote" ]; then echo "[ok] Адрес ведёт на этот экземпляр (совпадает сборка ${commit_local:0:12})."
        else bad=1; echo "[FAIL] Адрес ведёт на другой экземпляр или другую версию (${commit_remote:0:12}, здесь ${commit_local:0:12})."; fi
      fi
    fi
  fi
  [ "$bad" -eq 0 ] || return 1
  [ "$unknown" -eq 0 ] || return 2
  return 0
}
