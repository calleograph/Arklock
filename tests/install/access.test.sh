#!/usr/bin/env bash
# Проверки логики доступа и первого входа (scripts/lib/access.sh) и разбора параметров установщика.
# Не требует Docker и root: сеть — только управляемый локальный сервер (HTTPS с собственным сертификатом).
#   bash tests/install/access.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=../../scripts/lib/access.sh
. "$ROOT/scripts/lib/access.sh"
# цветовые коды отключены, чтобы сравнивать текст (используются подключёнными библиотеками)
export C_RED="" C_GRN="" C_YEL="" C_BLU="" C_OFF=""

TMP="$(mktemp -d)"
MOCK_PID=0
trap '[ "$MOCK_PID" -gt 0 ] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
PASS=0; FAILN=0
check() { # check ИМЯ КОМАНДА… — команда должна завершиться кодом 0
  local name="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); else FAILN=$((FAILN + 1)); echo "НЕ ПРОШЛО: $name" >&2; fi
}
eq() { [ "$1" = "$2" ] || { echo "  ожидалось «$2», получено «$1»" >&2; return 1; }; }
has() { case "$1" in *"$2"*) return 0 ;; *) echo "  в выводе нет «$2»:" >&2; printf '%s\n' "$1" | sed 's/^/    /' >&2; return 1 ;; esac; }
lacks() { case "$1" in *"$2"*) echo "  в выводе не должно быть «$2»" >&2; return 1 ;; *) return 0 ;; esac; }

# ---------------------------------------------------------------- вид адреса
for row in "https://arklock.example.com:https" "https://arklock.example.com/:https" "http://localhost:8080:localhost" "http://127.0.0.1:localhost" \
           "http://192.0.2.10:8080:http" "arklock.example.com:invalid" "https://:invalid" "ftp://x.example:invalid" "http://bad host:invalid"; do
  url="${row%:*}"; want="${row##*:}"
  # адрес с портом содержит двоеточие: разделитель — последнее
  check "вид адреса $url" eq "$(acc_url_kind "$url")" "$want"
done

# ---------------------------------------------------------------- состояние по файлу окружения
env_file() { printf '%s\n' "$@" > "$TMP/env"; echo "$TMP/env"; }
check "https по адресу" eq "$(acc_state "$(env_file APP_PUBLIC_URL=https://arklock.example.com APP_BIND=0.0.0.0)")" https
check "local по умолчанию" eq "$(acc_state "$(env_file APP_PORT=8080)")" local
check "local при loopback" eq "$(acc_state "$(env_file APP_BIND=127.0.0.1)")" local
check "incomplete: сеть без HTTPS" eq "$(acc_state "$(env_file APP_BIND=192.0.2.10)")" incomplete
check "incomplete: все адреса" eq "$(acc_state "$(env_file APP_BIND=0.0.0.0)")" incomplete
check "invalid: http-адрес" eq "$(acc_state "$(env_file APP_PUBLIC_URL=http://arklock.example.com)")" invalid
check "локальный адрес не считается публичным" eq "$(acc_state "$(env_file APP_PUBLIC_URL=http://localhost:8080)")" local

# ---------------------------------------------------------------- удаление параметра из файла окружения
f="$(env_file APP_PUBLIC_URL=https://arklock.example.com APP_PORT=8080 BOOTSTRAP_TOKEN=synthetic-token)"
env_unset "$f" APP_PUBLIC_URL
check "env_unset: параметр удалён" eq "$(env_get "$f" APP_PUBLIC_URL)" ""
check "env_unset: остальное цело" eq "$(env_get "$f" APP_PORT)$(env_get "$f" BOOTSTRAP_TOKEN)" "8080synthetic-token"
check "env_unset: права 600" eq "$(stat -c '%a' "$f")" 600
env_unset "$f" NO_SUCH_KEY; check "env_unset: нет параметра — не ошибка" eq "$?" 0
check "после удаления адреса: local" eq "$(acc_state "$f")" local

# ---------------------------------------------------------------- итог первого входа
out="$(acc_first_login "$(env_file APP_PUBLIC_URL=https://arklock.example.com)")"; rc=$?
check "https: готов" eq "$rc" 0; check "https: текст" has "$out" "ГОТОВ — откройте https://arklock.example.com"
out="$(acc_first_login "$(env_file APP_BIND=127.0.0.1 APP_PORT=18080)" arklock-srv)"; rc=$?
check "local: готов" eq "$rc" 0
check "local: адрес" has "$out" "http://localhost:18080"
check "local: туннель" has "$out" "ssh -L 18080:127.0.0.1:18080 <пользователь>@arklock-srv"
out="$(acc_first_login "$(env_file APP_BIND=192.0.2.10 APP_PORT=8080)")"; rc=$?
check "incomplete: не готов" eq "$rc" 1
check "incomplete: объяснение" has "$out" "НЕ ГОТОВ"
check "incomplete: причина" has "$out" "HTTPS или на localhost"
for hint in "set https --domain" "set proxy --url https://" "set local"; do check "incomplete: подсказка $hint" has "$out" "$hint"; done
out="$(acc_first_login "$(env_file APP_PUBLIC_URL=http://arklock.example.com)")"; rc=$?
check "invalid: не готов" eq "$rc" 1; check "invalid: текст" has "$out" "задан без HTTPS"

# ---------------------------------------------------------------- что настроить на прокси
out="$(acc_proxy_help "$(env_file APP_PUBLIC_URL=https://arklock.example.com APP_BIND=127.0.0.1 APP_PORT=8080 TRUSTED_PROXY_HOPS=1)")"
check "прокси: loopback" has "$out" "http://127.0.0.1:8080"; check "прокси: на этом сервере" has "$out" "ЭТОМ же сервере"
for header in "Host" "X-Forwarded-For" "X-Forwarded-Proto"; do check "прокси: заголовок $header" has "$out" "$header"; done
check "прокси: размер тела" has "$out" "32 МБ"; check "прокси: число прокси" has "$out" "TRUSTED_PROXY_HOPS=1"
out="$(acc_proxy_help "$(env_file APP_PUBLIC_URL=https://arklock.example.com APP_BIND=192.0.2.10 APP_PORT=9090 TRUSTED_PROXY_HOPS=2)")"
check "прокси: адрес сети" has "$out" "http://192.0.2.10:9090"; check "прокси: другой сервер" has "$out" "на другом сервере"
check "прокси: два звена" has "$out" "TRUSTED_PROXY_HOPS=2"
out="$(acc_proxy_help "$(env_file APP_PUBLIC_URL=https://arklock.example.com APP_BIND=0.0.0.0 APP_PORT=8080)" 192.0.2.77)"
check "прокси: все адреса" has "$out" "http://192.0.2.77:8080"; check "прокси: фаервол" has "$out" "фаерволом"

# ---------------------------------------------------------------- проверки публичного адреса
chk() { acc_check_public "$1" 2>&1; }
out="$(chk "$(env_file APP_PORT=8080)")"; rc=0; acc_check_public "$TMP/env" >/dev/null 2>&1 || rc=$?
check "без адреса: проверять нечего" eq "$rc" 0
rc=0; out="$(chk "$(env_file APP_PUBLIC_URL=http://arklock.example.com)")"; acc_check_public "$TMP/env" >/dev/null 2>&1 || rc=$?
check "http-адрес: ошибка" eq "$rc" 1; check "http-адрес: текст" has "$out" "не HTTPS"
rc=0; env_file APP_PUBLIC_URL=https://no-such-name.invalid >/dev/null; out="$(acc_check_public "$TMP/env" 2>&1)" || true; acc_check_public "$TMP/env" >/dev/null 2>&1 || rc=$?
check "имя не найдено: не ошибка настройки" eq "$rc" 2; check "имя не найдено: объяснение" has "$out" "доступен только из внутренней сети"

if command -v openssl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && getent hosts localhost >/dev/null 2>&1; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1
  # свободные порты
  free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
  SC_RC=0; SC_OUT=""
  scenario() { # scenario СЦЕНАРИЙ [С_ДОВЕРИЕМ] → вывод проверки в SC_OUT, код — в SC_RC (без подоболочки)
    local name="$1" trust="${2:-yes}" hp lp
    hp="$(free_port)"; lp="$(free_port)"
    MOCK_SCENARIO="$name" python3 "$ROOT/tests/install/mock-public.py" "$hp" "$lp" "$TMP/cert.pem" "$TMP/key.pem" > "$TMP/mock.out" 2>&1 &
    MOCK_PID=$!
    for _ in $(seq 1 50); do grep -q ready "$TMP/mock.out" 2>/dev/null && break; sleep 0.1; done
    env_file "APP_PUBLIC_URL=https://localhost:$hp" "APP_PORT=$lp" "APP_BIND=127.0.0.1" >/dev/null
    if [ "$trust" = yes ]; then CURL_CA_BUNDLE="$TMP/cert.pem" acc_check_public "$TMP/env" > "$TMP/check.out" 2>&1; SC_RC=$?
    else acc_check_public "$TMP/env" > "$TMP/check.out" 2>&1; SC_RC=$?; fi
    kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=0
    SC_OUT="$(cat "$TMP/check.out")"
  }
  scenario good; out="$SC_OUT"; check "good: код 0" eq "$SC_RC" 0
  check "good: https виден" has "$out" "приложение видит защищённое соединение"; check "good: адрес совпал" has "$out" "совпадает с APP_PUBLIC_URL"
  check "good: первая запись" has "$out" "Первая учётная запись ещё не создана"; check "good: тот же экземпляр" has "$out" "ведёт на этот экземпляр"
  scenario no-proto; out="$SC_OUT"; check "no-proto: ошибка" eq "$SC_RC" 1
  check "no-proto: причина" has "$out" "не передаёт заголовок X-Forwarded-Proto"; check "no-proto: что сделать" has "$out" 'proxy_set_header X-Forwarded-Proto'
  scenario hops0; out="$SC_OUT"; check "hops0: ошибка" eq "$SC_RC" 1
  check "hops0: причина" has "$out" "не доверяет прокси (TRUSTED_PROXY_HOPS=0)"; check "hops0: исправление" has "$out" "set proxy --url"
  scenario host; out="$SC_OUT"; check "host: ошибка" eq "$SC_RC" 1; check "host: причина" has "$out" "не совпадает с APP_PUBLIC_URL"
  check "host: Host" has "$out" 'proxy_set_header Host'; check "host: уже создана" has "$out" "Первая учётная запись уже создана"
  scenario html; out="$SC_OUT"; check "html: ошибка" eq "$SC_RC" 1; check "html: не Arklock" has "$out" "это не Arklock"
  scenario other; out="$SC_OUT"; check "other: другой экземпляр" has "$out" "другой экземпляр или другую версию"
  scenario good no; out="$SC_OUT"; check "сертификат не доверен: ошибка" eq "$SC_RC" 1; check "сертификат: текст" has "$out" "Сертификат или TLS"
  # закрытый порт: адрес может быть доступен только из другой сети — не ошибка настройки
  closed="$(free_port)"; env_file "APP_PUBLIC_URL=https://localhost:$closed" "APP_PORT=1" >/dev/null
  out="$(acc_check_public "$TMP/env" 2>&1)"; rc=0; acc_check_public "$TMP/env" >/dev/null 2>&1 || rc=$?
  check "порт закрыт: не ошибка настройки" eq "$rc" 2; check "порт закрыт: объяснение" has "$out" "не отвечает с этого сервера"
else
  echo "Пропущено: нет openssl, python3, curl или имени localhost — сетевые проверки не выполнялись" >&2
fi

# ---------------------------------------------------------------- scripts/access.sh: смена доступа без переустановки
# Docker заменён заглушкой, «приложение» — управляемый локальный сервер; настоящие контейнеры в CI проверяет задача установки.
if command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  mkdir -p "$TMP/bin" "$TMP/data"
  printf '#!/bin/sh\necho "docker $*" >> "%s/docker.log"\nexit 0\n' "$TMP" > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
  lp="$(free_port)"; hp="$(free_port)"
  [ -f "$TMP/cert.pem" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=localhost" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1
  MOCK_SCENARIO=good python3 "$ROOT/tests/install/mock-public.py" "$hp" "$lp" "$TMP/cert.pem" "$TMP/key.pem" > "$TMP/mock2.out" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 50); do grep -q ready "$TMP/mock2.out" 2>/dev/null && break; sleep 0.1; done
  AENV="$TMP/arklock.env"
  printf '%s\n' "COMPOSE_PROJECT_NAME=accesstest" "DATA_ROOT=$TMP/data" "APP_PORT=$lp" "APP_BIND=127.0.0.1" "BOOTSTRAP_TOKEN=synthetic-token" "ARKLOCK_IMAGE=accesstest-app:local" > "$AENV"
  chmod 600 "$AENV"
  # shellcheck source=../../scripts/access.sh
  . "$ROOT/scripts/access.sh"
  need_root() { :; }
  # запуск в подоболочке: die завершает её, а не тест; код возврата — результат команды
  acc() { ( PATH="$TMP/bin:$PATH" main "$@" ) 2>&1; }
  run() { ACC_OUT="$(acc "$@" </dev/null)"; ACC_RC=$?; } # run АРГУМЕНТЫ… — вывод в ACC_OUT, код в ACC_RC; без подоболочки для кода

  run status --env "$AENV"
  check "status: локально, код 0" eq "$ACC_RC" 0; check "status: текст" has "$ACC_OUT" "ГОТОВ ЛОКАЛЬНО"; check "status: технически" has "$ACC_OUT" "Технически:           ГОТОВ"

  run set proxy --env "$AENV" --url http://arklock.example.com --yes
  check "set proxy: http отклонён" eq "$ACC_RC" 1; check "set proxy: http, причина" has "$ACC_OUT" "должен начинаться с https://"
  run set proxy --env "$AENV" --yes
  check "set proxy: без адреса" has "$ACC_OUT" "требует --url"
  run set proxy --env "$AENV" --url https://arklock.example.com --hops 9 --yes
  check "set proxy: звенья вне границ" has "$ACC_OUT" "число прокси от 0 до 5"
  check "ошибки не меняют файл" eq "$(env_get "$AENV" APP_PUBLIC_URL)" ""

  run set proxy --env "$AENV" --url https://arklock.example.com/ --yes
  check "set proxy: успех" eq "$ACC_RC" 0
  check "set proxy: адрес без слэша" eq "$(env_get "$AENV" APP_PUBLIC_URL)" "https://arklock.example.com"
  check "set proxy: звено по умолчанию" eq "$(env_get "$AENV" TRUSTED_PROXY_HOPS)" 1
  check "set proxy: данные и секреты на месте" eq "$(env_get "$AENV" BOOTSTRAP_TOKEN)" synthetic-token
  check "set proxy: подсказка для прокси" has "$ACC_OUT" "X-Forwarded-Proto"
  check "set proxy: перезапуск только приложения" has "$(cat "$TMP/docker.log")" "up -d --no-build --wait --wait-timeout 180 app"
  set -- "$TMP"/data/config-backups/arklock.env.*
  check "set proxy: копия настроек" eq "$#" 1
  check "set proxy: права копии" eq "$(stat -c '%a' "$1")" 600
  : > "$TMP/docker.log"
  run set proxy --env "$AENV" --url https://arklock.example.com --yes
  check "повтор без изменений: перезапуска нет" eq "$(wc -c < "$TMP/docker.log" | tr -d ' ')" 0
  check "повтор: сообщение" has "$ACC_OUT" "перезапуск не нужен"

  # заданный адрес не заменяется молча
  run set proxy --env "$AENV" --url https://other.example.com
  check "замена без подтверждения отклонена" eq "$ACC_RC" 1; check "замена: объяснение" has "$ACC_OUT" "уже задан"
  check "замена: адрес прежний" eq "$(env_get "$AENV" APP_PUBLIC_URL)" "https://arklock.example.com"
  # явное подтверждение заменяет адрес; «приложение» в тесте слушает только 127.0.0.1, поэтому --bind local
  run set proxy --env "$AENV" --url https://other.example.com --bind local --yes
  check "замена с --yes" eq "$ACC_RC" 0; check "замена: новый адрес" eq "$(env_get "$AENV" APP_PUBLIC_URL)" "https://other.example.com"
  run set proxy --env "$AENV" --url https://other.example.com --bind 192.0.2.250 --yes
  check "чужой адрес сервера отклонён" has "$ACC_OUT" "не назначен этому серверу"

  run status --env "$AENV"
  check "status: https, код 0" eq "$ACC_RC" 0; check "status: https, текст" has "$ACC_OUT" "ГОТОВ — откройте https://other.example.com"

  # набор в состоянии incomplete: сеть без HTTPS
  env_unset "$AENV" APP_PUBLIC_URL; env_set "$AENV" APP_BIND 0.0.0.0
  run status --env "$AENV"
  check "status: не готов, код 1" eq "$ACC_RC" 1; check "status: не готов, текст" has "$ACC_OUT" "НЕ ГОТОВ"
  run set local --env "$AENV" --yes
  check "set local: успех" eq "$ACC_RC" 0; check "set local: loopback" eq "$(env_get "$AENV" APP_BIND)" 127.0.0.1
  check "set local: готов" has "$ACC_OUT" "ГОТОВ ЛОКАЛЬНО"
  run set proxy --env "$AENV" --url https://arklock.example.com --yes
  check "возврат к proxy" eq "$ACC_RC" 0
  run set local --env "$AENV"
  check "set local: публичный адрес без подтверждения не стирается" eq "$ACC_RC" 1
  run set local --env "$AENV" --yes
  check "set local --yes: адрес снят" eq "$(env_get "$AENV" APP_PUBLIC_URL)" ""
  run proxy-help --env "$AENV"
  check "proxy-help: печатает" has "$ACC_OUT" "Что должен делать прокси"
  run frobnicate --env "$AENV"
  check "неизвестная команда" has "$ACC_OUT" "Неизвестная команда"
  kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=0
else
  echo "Пропущено: нет python3 или curl — сценарии scripts/access.sh не выполнялись" >&2
fi

# ---------------------------------------------------------------- параметры установщика (разбор до любых изменений)
inst() { bash "$ROOT/install.sh" "$@" --dry-run >/dev/null 2>"$TMP/inst.err"; local rc=$?; cat "$TMP/inst.err"; echo "rc=$rc"; }
out="$(inst --access nope)"; check "access: неизвестный режим" has "$out" "rc=2"
out="$(inst --access proxy)"; check "proxy без адреса" has "$out" "требует --url https://"
out="$(inst --access proxy --url http://arklock.example.com)"; check "proxy с http" has "$out" "должен начинаться с https://"
out="$(inst --access https)"; check "https без имени" has "$out" "требует --domain"
out="$(inst --access local --url https://arklock.example.com)"; check "local с адресом" has "$out" "не использует публичный адрес"
out="$(inst --access local --https self-signed --domain a.example)"; check "local с HTTPS" has "$out" "rc=2"
out="$(inst --access proxy --url https://a.example --https letsencrypt --domain a.example)"; check "proxy с HTTPS на сервере" has "$out" "не настраивает HTTPS на этом сервере"
out="$(inst --url http://192.0.2.10:8080)"; check "http-адрес по IP" has "$out" "должен начинаться с https://"
# допустимые сочетания доходят до проверки прав (rc=1 «запустите от root») — разбор параметров их принял
if [ "$(id -u)" -ne 0 ]; then
  for a in "--access local" "--access proxy --url https://arklock.example.com --bind lan" "--access https --domain a.example --https self-signed" "--url https://arklock.example.com" "--access local --url http://localhost:8080"; do
    # shellcheck disable=SC2086
    out="$(inst $a)"; check "принято: $a" has "$out" "rc=1"
  done
fi

echo "access.test.sh: прошло $PASS, не прошло $FAILN"
[ "$FAILN" -eq 0 ]
