#!/usr/bin/env bash
# remote.sh — удалённое хранилище резервных копий Arklock: S3-совместимое (AWS S3, MinIO, Ceph, Yandex Object Storage…)
# и SMB/CIFS. Копии уже зашифрованы (GnuPG, AES-256) до отправки; сюда уходит только шифртекст.
#   scripts/remote.sh [--env ФАЙЛ] КОМАНДА…   (файл окружения нужен, чтобы найти remote.conf и имя проекта)
#   scripts/remote.sh configure [--from-env]  записать параметры (интерактивно или из переменных ARKLOCK_REMOTE_*)
#   scripts/remote.sh show                    показать настройку без секретов
#   scripts/remote.sh import ФАЙЛ             принять настройку из веб-интерфейса (файл удаляется; пустой секрет — прежний)
#   scripts/remote.sh test                    проверить соединение: запись, чтение, сверка и удаление пробного объекта
#   scripts/remote.sh push ФАЙЛ               отправить копию (и её описание), проверить размер и SHA-256
#   scripts/remote.sh list                    перечислить копии на удалённом хранилище
#   scripts/remote.sh verify ИМЯ              скачать потоком и сверить SHA-256 с описанием
#   scripts/remote.sh pull ИМЯ [КАТАЛОГ]      скачать копию в каталог (по умолчанию — каталог копий), сверить SHA-256
#   scripts/remote.sh prune N                 оставить N последних копий проекта, остальные удалить
#   scripts/remote.sh delete ИМЯ              удалить копию и её описание
#   scripts/remote.sh clear                   стереть настройку (секреты) с этого сервера
#
# Настройка хранится в remote.conf рядом с файлом окружения (по умолчанию /etc/arklock/remote.conf; права 600, root): значения в base64, файл не исполняется.
# Секреты не попадают в командную строку процессов, в журналы и в базу данных Arklock.
# Восстановление на другом сервере: install.sh → ключ шифрования копий → remote.sh configure → restore.sh --remote ИМЯ.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

# Файл окружения экземпляра задаётся первым параметром: remote.sh --env ФАЙЛ команда… (помощник и restore.sh вызывают так)
if [ "${1:-}" = "--env" ]; then ENV_FILE="${2:-}"; export ENV_FILE; shift 2; fi
# Файл настройки лежит рядом с файлом окружения экземпляра (несколько экземпляров на одном хосте не делят секреты).
if [ -n "${ARKLOCK_REMOTE_CONF:-}" ]; then CONF="$ARKLOCK_REMOTE_CONF"
elif [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; then CONF="$(dirname "$ENV_FILE")/remote.conf"
else CONF="$DEFAULT_CONFIG_DIR/remote.conf"; fi
PART_MIB="${ARKLOCK_REMOTE_PART_MIB:-64}"      # размер части многочастной загрузки S3 (S3 требует не менее 5 МиБ, кроме последней)
SINGLE_MAX_MIB="${ARKLOCK_REMOTE_SINGLE_MAX_MIB:-100}"  # до этого размера — один запрос
CURL_TIMEOUT="${ARKLOCK_REMOTE_TIMEOUT:-3600}"

# ------------------------------------------------------------------ настройка
declare -A R=()
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
unb64() { printf '%s' "$1" | base64 -d 2>/dev/null; }

conf_load() {
  [ -r "$CONF" ] || die "Удалённое хранилище не настроено ($CONF). Выполните: scripts/remote.sh configure"
  local line k v
  R=()
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [[ "$k" =~ ^[a-z][a-z0-9_]*$ ]] || continue
    R[$k]="$(unb64 "$v")"
  done < "$CONF"
  [ -n "${R[type]:-}" ] || die "В $CONF не указан тип хранилища"
}

conf_write() { # conf_write — записывает массив R атомарно с правами 600
  local tmp k
  mkdir -p "$(dirname "$CONF")"
  tmp="$(mktemp "$CONF.XXXXXX")"; chmod 600 "$tmp"
  for k in "${!R[@]}"; do printf '%s=%s\n' "$k" "$(b64 "${R[$k]}")" >> "$tmp"; done
  mv -f "$tmp" "$CONF"
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$ ]]; }
safe_prefix() { # префикс каталога: сегменты из безопасных знаков, без «..»
  [[ -z "$1" || "$1" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] && [[ "$1" != *..* ]]
}

cmd_configure() {
  local from_env=0; [ "${1:-}" = "--from-env" ] && from_env=1
  need_cmd base64
  R=()
  [ -r "$CONF" ] && [ "$from_env" -eq 0 ] && { conf_load; }
  local ask
  if [ "$from_env" -eq 1 ]; then
    R[type]="${ARKLOCK_REMOTE_TYPE:-}"
    case "${R[type]}" in
      s3)
        R[endpoint]="${ARKLOCK_REMOTE_S3_ENDPOINT:-}"; R[region]="${ARKLOCK_REMOTE_S3_REGION:-us-east-1}"
        R[bucket]="${ARKLOCK_REMOTE_S3_BUCKET:-}"; R[prefix]="${ARKLOCK_REMOTE_PREFIX:-}"
        R[access_key]="${ARKLOCK_REMOTE_S3_ACCESS_KEY:-}"; R[secret_key]="${ARKLOCK_REMOTE_S3_SECRET_KEY:-}"
        R[path_style]="${ARKLOCK_REMOTE_S3_PATH_STYLE:-1}"; R[ca_pem]="${ARKLOCK_REMOTE_CA_PEM:-}"
        R[insecure_tls]="${ARKLOCK_REMOTE_INSECURE_TLS:-0}"; R[allow_http]="${ARKLOCK_REMOTE_ALLOW_HTTP:-0}" ;;
      smb)
        R[host]="${ARKLOCK_REMOTE_SMB_HOST:-}"; R[port]="${ARKLOCK_REMOTE_SMB_PORT:-445}"
        R[share]="${ARKLOCK_REMOTE_SMB_SHARE:-}"; R[prefix]="${ARKLOCK_REMOTE_PREFIX:-}"
        R[user]="${ARKLOCK_REMOTE_SMB_USER:-}"; R[password]="${ARKLOCK_REMOTE_SMB_PASSWORD:-}"
        R[domain]="${ARKLOCK_REMOTE_SMB_DOMAIN:-}"; R[encrypt]="${ARKLOCK_REMOTE_SMB_ENCRYPT:-1}" ;;
      *) die "ARKLOCK_REMOTE_TYPE: s3 или smb" ;;
    esac
    R[auto]="${ARKLOCK_REMOTE_AUTO:-1}"; R[keep]="${ARKLOCK_REMOTE_KEEP:-14}"
  else
    [ -t 0 ] || die "Интерактивная настройка требует терминала; для сценариев используйте --from-env"
    read -r -p "Тип хранилища (s3/smb) [${R[type]:-s3}]: " ask; R[type]="${ask:-${R[type]:-s3}}"
    if [ "${R[type]}" = s3 ]; then
      read -r -p "Адрес S3 (https://…) [${R[endpoint]:-}]: " ask; R[endpoint]="${ask:-${R[endpoint]:-}}"
      read -r -p "Регион [${R[region]:-us-east-1}]: " ask; R[region]="${ask:-${R[region]:-us-east-1}}"
      read -r -p "Корзина (bucket) [${R[bucket]:-}]: " ask; R[bucket]="${ask:-${R[bucket]:-}}"
      read -r -p "Каталог внутри корзины [${R[prefix]:-}]: " ask; R[prefix]="${ask:-${R[prefix]:-}}"
      read -r -p "Ключ доступа [${R[access_key]:-}]: " ask; R[access_key]="${ask:-${R[access_key]:-}}"
      read -r -s -p "Секретный ключ (пусто — оставить прежний): " ask; echo; [ -z "$ask" ] || R[secret_key]="$ask"
      R[path_style]="${R[path_style]:-1}"; R[insecure_tls]="${R[insecure_tls]:-0}"
    else
      read -r -p "Сервер SMB [${R[host]:-}]: " ask; R[host]="${ask:-${R[host]:-}}"
      read -r -p "Порт [${R[port]:-445}]: " ask; R[port]="${ask:-${R[port]:-445}}"
      read -r -p "Общая папка [${R[share]:-}]: " ask; R[share]="${ask:-${R[share]:-}}"
      read -r -p "Каталог внутри папки [${R[prefix]:-}]: " ask; R[prefix]="${ask:-${R[prefix]:-}}"
      read -r -p "Пользователь [${R[user]:-}]: " ask; R[user]="${ask:-${R[user]:-}}"
      read -r -s -p "Пароль (пусто — оставить прежний): " ask; echo; [ -z "$ask" ] || R[password]="$ask"
      read -r -p "Домен [${R[domain]:-}]: " ask; R[domain]="${ask:-${R[domain]:-}}"
      R[encrypt]="${R[encrypt]:-1}"
    fi
  fi
  conf_check
  conf_write
  ok "Настройка сохранена: $CONF (права 600)"
}

conf_check() {
  [[ "${R[auto]:-1}" =~ ^[01]$ ]] || die "auto: 0 или 1"
  [[ "${R[keep]:-14}" =~ ^[0-9]{1,3}$ ]] && [ "${R[keep]:-14}" -ge 1 ] && [ "${R[keep]:-14}" -le 365 ] || die "keep: число от 1 до 365"
  safe_prefix "${R[prefix]:-}" || die "Каталог: допустимы буквы, цифры, '.', '_', '-' и '/' (без '..')"
  case "${R[type]}" in
    s3)
      [[ "${R[endpoint]:-}" =~ ^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] || die "Адрес S3 указан неверно"
      [[ "${R[region]:-}" =~ ^[a-z0-9-]{2,40}$ ]] || die "Регион указан неверно"
      [[ "${R[bucket]:-}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "Имя корзины указано неверно"
      [ -n "${R[access_key]:-}" ] && [ -n "${R[secret_key]:-}" ] || die "Нужны ключ доступа и секретный ключ"
      [[ "${R[access_key]}" =~ ^[A-Za-z0-9/+=._-]{3,128}$ ]] || die "Ключ доступа содержит недопустимые знаки"
      case "${R[endpoint]}" in http://*) [ "${R[allow_http]:-0}" = 1 ] || die "Адрес http:// допустим только с явным разрешением (allow_http)";; esac ;;
    smb)
      [[ "${R[host]:-}" =~ ^[A-Za-z0-9._-]{1,253}$ ]] || die "Сервер SMB указан неверно"
      [[ "${R[port]:-445}" =~ ^[0-9]{1,5}$ ]] || die "Порт указан неверно"
      [[ "${R[share]:-}" =~ ^[A-Za-z0-9._\$-]{1,80}$ ]] || die "Имя общей папки указано неверно"
      [ -n "${R[user]:-}" ] && [ -n "${R[password]:-}" ] || die "Нужны пользователь и пароль"
      [[ "${R[user]}" =~ ^[A-Za-z0-9._@\\-]{1,128}$ ]] || die "Имя пользователя содержит недопустимые знаки"
      [[ "${R[domain]:-}" =~ ^[A-Za-z0-9._-]{0,128}$ ]] || die "Домен указан неверно" ;;
    *) die "Неизвестный тип хранилища" ;;
  esac
}

cmd_show() {
  conf_load
  local k
  for k in type endpoint region bucket prefix access_key host port share user domain path_style encrypt insecure_tls allow_http auto keep; do
    [ -n "${R[$k]:-}" ] && printf '%s=%s\n' "$k" "${R[$k]}"
  done
  [ -n "${R[secret_key]:-}${R[password]:-}" ] && echo "секрет=задан (скрыт)"
  return 0
}

ALLOWED_KEYS=" type endpoint region bucket prefix access_key secret_key path_style ca_pem insecure_tls allow_http host port share user password domain encrypt auto keep "
cmd_import() {
  local in="${1:-}" line k v
  [ -f "$in" ] && [ ! -L "$in" ] || die "Нет файла настройки"
  [ "$(stat -c '%s' "$in")" -le 65536 ] || die "Файл настройки слишком велик"
  declare -A OLD=()
  if [ -r "$CONF" ]; then conf_load; local kk; for kk in "${!R[@]}"; do OLD[$kk]="${R[$kk]}"; done; fi
  R=()
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [[ "$ALLOWED_KEYS" == *" $k "* ]] || die "Неизвестный параметр настройки"
    R[$k]="$(unb64 "$v")"
  done < "$in"
  # пустой секрет означает «оставить прежний» (только для того же типа и адреса)
  if [ "${OLD[type]:-}" = "${R[type]:-}" ]; then
    [ -n "${R[secret_key]:-}" ] || R[secret_key]="${OLD[secret_key]:-}"
    [ -n "${R[password]:-}" ] || R[password]="${OLD[password]:-}"
    [ -n "${R[ca_pem]:-}" ] || [ "${R[type]}" != s3 ] || R[ca_pem]="${OLD[ca_pem]:-}"
  fi
  conf_check
  conf_write
  shred -u "$in" 2>/dev/null || rm -f "$in"
  ok "Настройка принята (права 600)"
}

cmd_clear() { shred -u "$CONF" 2>/dev/null || rm -f "$CONF"; ok "Настройка удалена"; }

# ------------------------------------------------------------------ S3 (подпись AWS Signature V4 вручную: не зависит от версии curl)
export LC_COLLATE=C
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
sha256_hex() { local h; read -r h _ < <(sha256sum); printf '%s' "$h"; }
# hmac_into ПЕРЕМЕННАЯ КЛЮЧ_HEX ДАННЫЕ — HMAC-SHA256 в hex (вывод openssl: «HMAC-SHA2-256(stdin)= …»)
hmac_into() {
  local _x
  read -r _ _x < <(printf '%s' "$3" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$2")
  printf -v "$1" '%s' "${_x%$'\r'}"
}
hex_of() { # hex_of СТРОКА → REPLY (только ASCII)
  local str="$1" out="" i h
  for ((i = 0; i < ${#str}; i++)); do printf -v h '%02x' "'${str:i:1}"; out+="$h"; done
  REPLY="$out"
}
# uri_enc ПЕРЕМЕННАЯ СТРОКА [1] — кодирование по правилам AWS (RFC 3986); «/» сохраняется только при третьем параметре 1
uri_enc() {
  local str="$2" keep="${3:-0}" out="" c i h
  for ((i = 0; i < ${#str}; i++)); do
    c="${str:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      /) if [ "$keep" = 1 ]; then out+="/"; else out+="%2F"; fi ;;
      *) printf -v h '%%%02X' "'$c"; out+="$h" ;;
    esac
  done
  printf -v "$1" '%s' "$out"
}

S3_HOSTPORT=""; S3_BASEURL=""; S3_PATH=""
s3_target() { # s3_target КЛЮЧ_ОБЪЕКТА — задаёт URL и канонический путь
  local key="$1" ep="${R[endpoint]%/}" scheme hostport basepath
  scheme="${ep%%://*}"; hostport="${ep#*://}"; basepath=""
  if [[ "$hostport" == */* ]]; then basepath="/${hostport#*/}"; hostport="${hostport%%/*}"; fi
  if [ "${R[path_style]:-1}" = 1 ]; then
    S3_HOSTPORT="$hostport"
    S3_PATH="$basepath/${R[bucket]}${key:+/$key}"
  else
    S3_HOSTPORT="${R[bucket]}.$hostport"
    S3_PATH="$basepath/${key}"
  fi
  S3_BASEURL="$scheme://$S3_HOSTPORT"
}
s3_key() { # объектный ключ: префикс/имя
  local n="$1"; if [ -n "${R[prefix]:-}" ]; then printf '%s/%s' "${R[prefix]}" "$n"; else printf '%s' "$n"; fi
}

CURL_CA=()
curl_common() {
  CURL_CA=()
  if [ -n "${R[ca_pem]:-}" ]; then
    ca_file="$WORK/ca.pem"; printf '%s\n' "${R[ca_pem]}" > "$ca_file"; CURL_CA=(--cacert "$ca_file")
  fi
  [ "${R[insecure_tls]:-0}" = 1 ] && CURL_CA+=(-k)
  return 0
}

# s3_request МЕТОД КЛЮЧ ЗАПРОС_СТРОКА ТЕЛО_ФАЙЛ|- ВЫВОД_ФАЙЛ ЗАГОЛОВКИ_ВЫВОД [доп. заголовки x-amz-…]
# Подписывает запрос, отправляет через curl; секреты передаются через stdin (-K -), в командной строке их нет.
S3_STATUS=""; SIGN_DATE=""; SIGN_KEY=""
s3_request() {
  local method="$1" key="$2" query="$3" body="$4" out="$5" hdr_out="$6"; shift 6
  local extra=("$@") amzdate date payload_hash canon_query="" signed_headers canon_req scope sts sig auth e path_enc
  s3_target "$key"
  TZ=UTC printf -v amzdate '%(%Y%m%dT%H%M%SZ)T' -1; date="${amzdate%%T*}"
  if [ "$body" = "-" ]; then payload_hash="$EMPTY_SHA"; else payload_hash="$(sha256_hex < "$body")"; fi
  # канонический запрос: значения кодируются один раз, пары сортируются по имени
  if [ -n "$query" ]; then
    local pairs=() p n v enc=() i j t en ev
    IFS='&' read -r -a pairs <<< "$query"
    for p in "${pairs[@]}"; do
      n="${p%%=*}"; v=""; [[ "$p" == *=* ]] && v="${p#*=}"
      uri_enc en "$n"; uri_enc ev "$v"; enc+=("$en=$ev")
    done
    for ((i = 1; i < ${#enc[@]}; i++)); do
      t="${enc[i]}"; j=$((i - 1))
      while [ "$j" -ge 0 ] && [[ "${enc[j]}" > "$t" ]]; do enc[j + 1]="${enc[j]}"; j=$((j - 1)); done
      enc[j + 1]="$t"
    done
    canon_query="$(IFS='&'; printf '%s' "${enc[*]}")"
  fi
  # заголовки: host, x-amz-content-sha256, x-amz-date, затем дополнительные x-amz-* (уже в алфавитном порядке)
  signed_headers="host;x-amz-content-sha256;x-amz-date"
  local canon_headers="host:$S3_HOSTPORT"$'\n'"x-amz-content-sha256:$payload_hash"$'\n'"x-amz-date:$amzdate"$'\n'
  for e in "${extra[@]}"; do
    signed_headers+=";${e%%:*}"; canon_headers+="${e%%:*}:${e#*:}"$'\n'
  done
  uri_enc path_enc "$S3_PATH" 1
  canon_req="$method"$'\n'"$path_enc"$'\n'"$canon_query"$'\n'"$canon_headers"$'\n'"$signed_headers"$'\n'"$payload_hash"
  scope="$date/${R[region]}/s3/aws4_request"
  local creq_hash; creq_hash="$(printf '%s' "$canon_req" | sha256_hex)"
  sts="AWS4-HMAC-SHA256"$'\n'"$amzdate"$'\n'"$scope"$'\n'"$creq_hash"
  if [ "$SIGN_DATE" != "$date" ]; then # ключ подписи действует сутки: считается один раз
    local kd kr ks
    hex_of "AWS4${R[secret_key]}"
    hmac_into kd "$REPLY" "$date"; hmac_into kr "$kd" "${R[region]}"; hmac_into ks "$kr" s3; hmac_into SIGN_KEY "$ks" aws4_request
    SIGN_DATE="$date"
  fi
  hmac_into sig "$SIGN_KEY" "$sts"
  auth="AWS4-HMAC-SHA256 Credential=${R[access_key]}/$scope, SignedHeaders=$signed_headers, Signature=$sig"
  curl_common
  local url="$S3_BASEURL$path_enc${canon_query:+?$canon_query}"
  local cfg="$WORK/curl.cfg"; : > "$cfg"; chmod 600 "$cfg"
  {
    printf 'url = "%s"\n' "$url"
    printf 'header = "Authorization: %s"\n' "$auth"
    printf 'header = "x-amz-content-sha256: %s"\n' "$payload_hash"
    printf 'header = "x-amz-date: %s"\n' "$amzdate"
    for e in "${extra[@]}"; do printf 'header = "%s"\n' "$e"; done
  } > "$cfg"
  local args=(-sS --max-time "$CURL_TIMEOUT" --connect-timeout 20 -X "$method" -K "$cfg" -o "${out:-/dev/null}" -w '%{http_code}' "${CURL_CA[@]}")
  [ -n "$hdr_out" ] && args+=(-D "$hdr_out")
  if [ "$body" != "-" ]; then args+=(--data-binary "@$body" -H 'Expect:')
  elif [ "$method" = PUT ] || [ "$method" = POST ]; then args+=(-H 'Content-Length: 0'); fi
  [ "$method" = HEAD ] && args+=(-I)
  S3_STATUS="$(curl "${args[@]}" 2>"$WORK/curl.err")" || { S3_STATUS="000"; return 1; }
  rm -f "$cfg"
}
s3_ok() { [[ "$S3_STATUS" =~ ^2 ]]; }
s3_err() { # краткая причина без тела ответа с секретами
  local code; code="$(sed -n 's/.*<Code>\([^<]*\)<\/Code>.*/\1/p' "$WORK/resp.xml" 2>/dev/null | head -n1)"
  printf 'HTTP %s%s%s' "$S3_STATUS" "${code:+ ($code)}" "$([ "$S3_STATUS" = 000 ] && printf ' %s' "$(head -c 200 "$WORK/curl.err" 2>/dev/null)")"
}

s3_put_file() { # s3_put_file ФАЙЛ ИМЯ — одним запросом или многочастно; метаданные: sha256
  local f="$1" name="$2" key size sha
  key="$(s3_key "$name")"; size="$(stat -c '%s' "$f")"; sha="$(sha256_hex < "$f")"
  if [ "$size" -le $((SINGLE_MAX_MIB * 1024 * 1024)) ]; then
    s3_request PUT "$key" "" "$f" "$WORK/resp.xml" "" "x-amz-meta-sha256:$sha" || true
    s3_ok || { fail "S3: загрузка не удалась: $(s3_err)"; return 1; }
  else
    local uid parts=() n=0 off=0 part etag
    s3_request POST "$key" "uploads=" - "$WORK/resp.xml" "" "x-amz-meta-sha256:$sha" || true
    s3_ok || { fail "S3: не удалось начать загрузку: $(s3_err)"; return 1; }
    uid="$(sed -n 's/.*<UploadId>\([^<]*\)<\/UploadId>.*/\1/p' "$WORK/resp.xml" | head -n1)"
    [ -n "$uid" ] || { fail "S3: нет идентификатора загрузки"; return 1; }
    abort_upload() { s3_request DELETE "$key" "uploadId=$uid" - "$WORK/resp.xml" "" || true; }
    while [ "$off" -lt "$size" ]; do
      n=$((n + 1)); part="$WORK/part"
      dd if="$f" of="$part" bs=1M skip=$(( (n - 1) * PART_MIB )) count="$PART_MIB" status=none 2>/dev/null
      s3_request PUT "$key" "partNumber=$n&uploadId=$uid" "$part" "$WORK/resp.xml" "$WORK/h.txt" || true
      if ! s3_ok; then fail "S3: часть $n не принята: $(s3_err)"; abort_upload; return 1; fi
      etag="$(tr -d '\r' < "$WORK/h.txt" | sed -n 's/^[Ee][Tt]ag: *//p' | head -n1)"
      [ -n "$etag" ] || { fail "S3: нет ETag части $n"; abort_upload; return 1; }
      # ETag передаётся как получен (с кавычками): в тексте элемента XML кавычка допустима, а «&» в подстановке bash 5.2 означало бы найденный текст
      parts+=("<Part><PartNumber>$n</PartNumber><ETag>$etag</ETag></Part>")
      off=$((off + PART_MIB * 1024 * 1024))
    done
    printf '<CompleteMultipartUpload>%s</CompleteMultipartUpload>' "$(IFS=; echo "${parts[*]}")" > "$WORK/complete.xml"
    s3_request POST "$key" "uploadId=$uid" "$WORK/complete.xml" "$WORK/resp.xml" "" || true
    if ! s3_ok || grep -q '<Error>' "$WORK/resp.xml"; then fail "S3: не удалось завершить загрузку: $(s3_err)"; abort_upload; return 1; fi
  fi
  # проверка: размер на стороне хранилища
  s3_request HEAD "$key" "" - "" "$WORK/h.txt" || true
  s3_ok || { fail "S3: объект не найден после загрузки: $(s3_err)"; return 1; }
  local rsize; rsize="$(tr -d '\r' < "$WORK/h.txt" | sed -n 's/^[Cc]ontent-[Ll]ength: *//p' | tail -n1)"
  [ "$rsize" = "$size" ] || { fail "S3: размер на хранилище ($rsize) не совпал с отправленным ($size)"; return 1; }
  return 0
}

s3_get_to() { # s3_get_to ИМЯ ВЫВОД_ФАЙЛ
  s3_request GET "$(s3_key "$1")" "" - "$2" "" || true
  s3_ok || { fail "S3: чтение не удалось: $(s3_err)"; return 1; }
}
s3_list() { # печатает «имя размер дата» по строке
  local token="" out="$WORK/list.xml"
  while :; do
    local q="list-type=2&prefix=${R[prefix]:+${R[prefix]}/}"
    [ -z "$token" ] || q="$q&continuation-token=$token"
    s3_request GET "" "$q" - "$out" "" || true
    s3_ok || { fail "S3: список не получен: $(s3_err)"; return 1; }
    tr -d '\n' < "$out" | sed 's/<Contents>/\n<Contents>/g' | grep '^<Contents>' | while IFS= read -r c; do
      local k s d
      k="$(sed -n 's/.*<Key>\([^<]*\)<\/Key>.*/\1/p' <<< "$c")"; s="$(sed -n 's/.*<Size>\([0-9]*\)<\/Size>.*/\1/p' <<< "$c")"
      d="$(sed -n 's/.*<LastModified>\([^<]*\)<\/LastModified>.*/\1/p' <<< "$c")"
      printf '%s %s %s\n' "${k##*/}" "$s" "$d"
    done
    if grep -q '<IsTruncated>true</IsTruncated>' "$out"; then
      token="$(sed -n 's/.*<NextContinuationToken>\([^<]*\)<\/NextContinuationToken>.*/\1/p' "$out" | head -n1)"
      [ -n "$token" ] || break
    else break; fi
  done
}
s3_delete() { s3_request DELETE "$(s3_key "$1")" "" - "$WORK/resp.xml" "" || true; [[ "$S3_STATUS" =~ ^(2|404) ]] || { fail "S3: удаление не удалось: $(s3_err)"; return 1; }; }

# ------------------------------------------------------------------ SMB (smbclient; пароль — только в файле учётных данных 600)
SMB_AUTH=""
smb_prepare() {
  need_cmd smbclient
  SMB_AUTH="$WORK/smb.auth"; : > "$SMB_AUTH"; chmod 600 "$SMB_AUTH"
  { printf 'username = %s\n' "${R[user]}"; printf 'password = %s\n' "${R[password]}"
    [ -n "${R[domain]:-}" ] && printf 'domain = %s\n' "${R[domain]}"; } > "$SMB_AUTH"
}
smb_run() { # smb_run КОМАНДЫ — выполняет команды smbclient в общей папке; вывод — в stdout
  local enc=(); [ "${R[encrypt]:-1}" = 1 ] && enc=(-e)
  smbclient "//${R[host]}/${R[share]}" -A "$SMB_AUTH" -p "${R[port]:-445}" -m SMB3 "${enc[@]}" -c "$1" 2>&1
}
smb_dir() { printf '%s' "${R[prefix]:-}"; }
smb_ensure_dir() {
  local d="" seg
  [ -n "$(smb_dir)" ] || return 0
  IFS='/' read -r -a segs <<< "$(smb_dir)"
  for seg in "${segs[@]}"; do d="${d:+$d/}$seg"; smb_run "mkdir \"$d\"" >/dev/null 2>&1 || true; done
}
smb_path() { printf '%s' "${R[prefix]:+${R[prefix]}/}$1"; }
smb_put_file() { # ФАЙЛ ИМЯ
  smb_ensure_dir
  local out; out="$(smb_run "put \"$1\" \"$(smb_path "$2")\"")" || { fail "SMB: запись не удалась: $(printf '%s' "$out" | tail -n1)"; return 1; }
  grep -q 'NT_STATUS' <<< "$out" && { fail "SMB: запись не удалась: $(grep -m1 NT_STATUS <<< "$out")"; return 1; }
  local rsize; rsize="$(smb_run "ls \"$(smb_path "$2")\"" | awk -v n="$(basename "$2")" '$1==n {for(i=2;i<=NF;i++) if ($i ~ /^[0-9]+$/) {print $i; exit}}')"
  [ "$rsize" = "$(stat -c '%s' "$1")" ] || { fail "SMB: размер на хранилище (${rsize:-?}) не совпал с отправленным"; return 1; }
}
smb_get_to() { # ИМЯ ВЫВОД_ФАЙЛ
  local out; out="$(smb_run "get \"$(smb_path "$1")\" \"$2\"")" || { fail "SMB: чтение не удалось"; return 1; }
  grep -q 'NT_STATUS' <<< "$out" && { fail "SMB: чтение не удалось: $(grep -m1 NT_STATUS <<< "$out")"; return 1; }
  return 0
}
smb_list() { # «имя размер дата»
  smb_run "ls \"$(smb_path '*')\"" | awk 'NF>=6 && $1 ~ /\.bak\.gpg(\.json)?$/ && $2 ~ /^[A-Za-z]*$/ {sz=""; for(i=2;i<=NF;i++) if ($i ~ /^[0-9]+$/) {sz=$i; break}; print $1, sz, $(NF-4), $(NF-3), $(NF-2), $(NF-1), $NF}'
}
smb_delete() { smb_run "del \"$(smb_path "$1")\"" >/dev/null 2>&1 || true; }

# ------------------------------------------------------------------ общие операции
WORK=""
work_init() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/arklock-remote.XXXXXX")"; chmod 700 "$WORK"
  # shellcheck disable=SC2064
  trap "rm -rf '$WORK'" EXIT
}
backend_prepare() { conf_load; conf_check; [ "${R[type]}" = smb ] && smb_prepare; return 0; }

put_file() { if [ "${R[type]}" = s3 ]; then s3_put_file "$1" "$2"; else smb_put_file "$1" "$2"; fi; }
get_to()   { if [ "${R[type]}" = s3 ]; then s3_get_to "$1" "$2"; else smb_get_to "$1" "$2"; fi; }
del_obj()  { if [ "${R[type]}" = s3 ]; then s3_delete "$1"; else smb_delete "$1"; fi; }
list_all() { if [ "${R[type]}" = s3 ]; then s3_list; else smb_list; fi; }

cmd_test() {
  backend_prepare
  local probe f="$WORK/probe.bin" back="$WORK/probe.back"
  probe="arklock-probe-$(rand_secret 6).tmp"
  head -c 4096 /dev/urandom > "$f"
  info "Запись пробного объекта…"
  put_file "$f" "$probe" || die "Запись не удалась: проверьте адрес, учётные данные и права на запись"
  info "Чтение и сверка…"
  get_to "$probe" "$back" || { del_obj "$probe" || true; die "Чтение не удалось"; }
  cmp -s "$f" "$back" || { del_obj "$probe" || true; die "Прочитанное не совпало с записанным"; }
  info "Удаление пробного объекта…"
  del_obj "$probe" || die "Удаление не удалось: нужны права на удаление для ротации копий"
  ok "Соединение проверено: запись, чтение, сверка и удаление работают"
}

sidecar_of() { printf '%s.json' "$1"; }

cmd_push() {
  local f="${1:-}"; [ -f "$f" ] || die "Укажите существующий файл копии"
  local name; name="$(basename "$f")"
  [[ "$name" =~ \.bak\.gpg$ ]] && valid_name "$name" || die "Имя файла не похоже на копию Arklock"
  backend_prepare
  local want; want="$(sha256_hex < "$f")"
  info "Отправка $name ($(du -h "$f" | cut -f1))…"
  put_file "$f" "$name" || die "Отправка не удалась"
  if [ -f "$f.json" ]; then put_file "$f.json" "$(sidecar_of "$name")" || die "Описание копии не отправлено"; fi
  # контроль целостности: потоковое чтение и SHA-256
  verify_remote "$name" "$want" || die "Контроль целостности после отправки не пройден"
  ok "Копия на удалённом хранилище, SHA-256 совпал: ${want:0:16}…"
}

verify_remote() { # ИМЯ [ОЖИДАЕМЫЙ_SHA]
  local name="$1" want="${2:-}" back="$WORK/verify.bin" got
  if [ -z "$want" ]; then
    get_to "$(sidecar_of "$name")" "$WORK/side.json" 2>/dev/null || { fail "На хранилище нет описания копии — сверять не с чем"; return 1; }
    want="$(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$WORK/side.json")"
    [ -n "$want" ] || { fail "В описании копии нет SHA-256"; return 1; }
  fi
  get_to "$name" "$back" || return 1
  got="$(sha256_hex < "$back")"; rm -f "$back"
  [ "$got" = "$want" ] || { fail "SHA-256 не совпал: на хранилище $got, ожидалось $want"; return 1; }
  return 0
}

cmd_verify() {
  valid_name "${1:-}" || die "Укажите имя копии"
  backend_prepare
  verify_remote "$1" && ok "Копия $1 на хранилище цела (SHA-256 совпал с описанием)"
}

cmd_list() {
  backend_prepare
  list_all | awk '$1 ~ /\.bak\.gpg$/' | LC_ALL=C sort -r
}

cmd_pull() {
  local name="${1:-}" dest="${2:-}"
  valid_name "$name" && [[ "$name" =~ \.bak\.gpg$ ]] || die "Укажите имя копии (*.bak.gpg)"
  if [ -z "$dest" ]; then
    resolve_env_file >/dev/null 2>&1 && load_env "$ENV_FILE" 2>/dev/null || true
    dest="${BACKUP_DIR:-${DATA_ROOT:+$DATA_ROOT/backups}}"
    [ -n "$dest" ] || die "Укажите каталог назначения"
  fi
  mkdir -p "$dest"; chmod 700 "$dest" 2>/dev/null || true
  backend_prepare
  info "Загрузка $name…"
  local part="$dest/$name.part"
  get_to "$name" "$part" || { rm -f "$part"; die "Загрузка не удалась"; }
  get_to "$(sidecar_of "$name")" "$dest/$name.json.part" 2>/dev/null && mv -f "$dest/$name.json.part" "$dest/$name.json" || rm -f "$dest/$name.json.part"
  if [ -f "$dest/$name.json" ]; then
    local want got
    want="$(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$dest/$name.json")"; got="$(sha256_hex < "$part")"
    [ -z "$want" ] || [ "$want" = "$got" ] || { rm -f "$part"; die "SHA-256 не совпал: копия повреждена при хранении или передаче"; }
  else
    warn "Описания копии на хранилище нет: целостность можно проверить только расшифровкой"
  fi
  mv -f "$part" "$dest/$name"
  ok "Копия сохранена: $dest/$name"
  printf '%s\n' "$dest/$name"
}

cmd_prune() {
  local keep="${1:-}"; [[ "$keep" =~ ^[0-9]+$ ]] && [ "$keep" -ge 1 ] || die "Укажите число копий ≥ 1"
  backend_prepare
  local project="${COMPOSE_PROJECT_NAME:-}"
  if [ -z "$project" ] && resolve_env_file >/dev/null 2>&1; then load_env "$ENV_FILE" 2>/dev/null || true; project="${COMPOSE_PROJECT_NAME:-}"; fi
  local names n=0
  mapfile -t names < <(list_all | awk '$1 ~ /\.bak\.gpg$/ {print $1}' | { if [ -n "$project" ]; then grep "^${project}-" || true; else cat; fi; } | LC_ALL=C sort -r)
  for nm in "${names[@]}"; do
    n=$((n + 1))
    [ "$n" -le "$keep" ] && continue
    del_obj "$nm" && del_obj "$(sidecar_of "$nm")" && info "удалена старая копия на хранилище: $nm"
  done
  ok "На хранилище оставлено копий: $(( n < keep ? n : keep ))"
}

cmd_delete() {
  valid_name "${1:-}" || die "Укажите имя копии"
  backend_prepare
  del_obj "$1"; del_obj "$(sidecar_of "$1")"
  ok "Удалено: $1"
}

main() {
  local c="${1:-}"; [ $# -gt 0 ] && shift
  case "$c" in
    configure) cmd_configure "$@" ;;
    import) cmd_import "$@" ;;
    show) cmd_show ;;
    clear) cmd_clear ;;
    test|push|list|verify|pull|prune|delete) work_init; "cmd_$c" "$@" ;;
    -h|--help|"") sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) die "Неизвестная команда: $c" ;;
  esac
}
main "$@"
