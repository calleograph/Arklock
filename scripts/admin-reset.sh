#!/usr/bin/env bash
# admin-reset.sh — восстановление административного доступа оператором сервера (когда вход в веб-интерфейс невозможен).
#   scripts/admin-reset.sh list                       перечислить администраторов и состояние их учётных записей
#   scripts/admin-reset.sh reset-mfa ПОЧТА            снять второй фактор (TOTP, резервные коды, ключи доступа)
#   scripts/admin-reset.sh end-sessions ПОЧТА         завершить все сеансы пользователя
#   scripts/admin-reset.sh enable ПОЧТА               включить отключённую учётную запись
#   scripts/admin-reset.sh promote ПОЧТА              сделать пользователя администратором
#   scripts/admin-reset.sh chief ПОЧТА                назначить главного администратора (если прежний недоступен)
#   scripts/admin-reset.sh new-setup-token            выпустить новый код первой настройки (пока в системе нет ни одного пользователя)
#   [--env ФАЙЛ] [--yes]
#
# Что скрипт НЕ может: сбросить мастер-пароль или прочитать данные. Мастер-пароль нельзя восстановить на сервере —
# данные зашифрованы им на клиенте; доступ возвращается кодом восстановления («Забыли пароль?» на странице входа).
# Каждое действие записывается в журнал событий (исполнитель «operator»), а владелец учётной записи получает уведомление
# почтой при включённых уведомлениях безопасности (если почта настроена).
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CMD="${1:-}"; [ $# -gt 0 ] && shift
TARGET=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) export ENV_FILE="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Неизвестный параметр: $1" ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$CMD" ] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
init_instance
need_cmd docker

# Запрос к базе данных. Адрес передаётся переменной psql и подставляется как литерал (:'email'), а не склеивается в текст;
# запрос подаётся через стандартный ввод, потому что psql не подставляет переменные в строку параметра -c.
sql() { # sql ПОЧТА ЗАПРОС
  printf '%s
' "$2" | dc exec -T db psql -U arklock -d arklock -v ON_ERROR_STOP=1 -qtA -v "email=$1" -f -
}
valid_email() { [[ "$1" =~ ^[^[:space:]@\'\"\\\;]+@[^[:space:]@\'\"\\\;]+\.[^[:space:]@\'\"\\\;]+$ ]]; }
need_user() { # need_user ПОЧТА → печатает идентификатор или завершает
  valid_email "$1" || die "Укажите адрес почты пользователя"
  local id; id="$(sql "$1" "select id from users where lower(email) = lower(:'email')" | head -n1 | tr -d '[:space:]')"
  [ -n "$id" ] || die "Пользователь не найден"
  printf '%s' "$id"
}
audit_op() { # audit_op ДЕЙСТВИЕ ИДЕНТИФИКАТОР
  sql "$3" "insert into ledger (actor, action, target, detail) values ('operator', '$1', 'user:$2', '{\"via\":\"scripts/admin-reset.sh\"}')" >/dev/null
}
confirm() {
  [ "$YES" -eq 1 ] && return 0
  read -r -p "$1 Введите «да» для подтверждения: " a
  [ "$a" = "да" ] || die "Отменено"
}

case "$CMD" in
  list)
    dc ps -q db | grep -q . || die "Контейнер базы данных не запущен"
    printf '%-40s %-8s %-9s %-9s %s\n' "ПОЧТА" "РОЛЬ" "ГЛАВНЫЙ" "ВКЛЮЧЁН" "ВТОРОЙ ФАКТОР"
    sql "" "select email || '|' || role || '|' || chief || '|' || (disabled_at is null) || '|' || (exists(select 1 from mfa_factors f where f.user_id = u.id) or exists(select 1 from webauthn_credentials w where w.user_id = u.id)) from users u where role = 'admin' or admin_role_id is not null order by email" \
      | while IFS='|' read -r email role chief enabled mfa; do
          printf '%-40s %-8s %-9s %-9s %s\n' "$email" "$role" "$([ "$chief" = true ] && echo да || echo нет)" "$([ "$enabled" = true ] && echo да || echo нет)" "$([ "$mfa" = true ] && echo да || echo нет)"
        done
    ;;
  reset-mfa)
    uid="$(need_user "$TARGET")"
    confirm "Будет снят второй фактор пользователя $TARGET (вход станет возможен только по паролю, пока он не настроит фактор заново)."
    sql "$TARGET" "delete from mfa_factors where user_id = '$uid'; delete from mfa_backup_codes where user_id = '$uid'; delete from webauthn_credentials where user_id = '$uid'; update sessions set revoked_at = now() where user_id = '$uid' and revoked_at is null" >/dev/null
    audit_op admin.mfa.reset "$uid" "$TARGET"
    ok "Второй фактор снят, сеансы пользователя завершены"
    ;;
  end-sessions)
    uid="$(need_user "$TARGET")"
    n="$(sql "$TARGET" "with r as (update sessions set revoked_at = now() where user_id = '$uid' and revoked_at is null returning 1) select count(*) from r" | tr -d '[:space:]')"
    audit_op admin.sessions.end "$uid" "$TARGET"
    ok "Завершено сеансов: ${n:-0}"
    ;;
  enable)
    uid="$(need_user "$TARGET")"
    sql "$TARGET" "update users set disabled_at = null where id = '$uid'" >/dev/null
    audit_op admin.user.enable "$uid" "$TARGET"
    ok "Учётная запись включена"
    ;;
  promote)
    uid="$(need_user "$TARGET")"
    confirm "Пользователь $TARGET получит полные права администратора."
    sql "$TARGET" "update users set role = 'admin' where id = '$uid'; update sessions set revoked_at = now() where user_id = '$uid' and revoked_at is null" >/dev/null
    audit_op admin.user.promote "$uid" "$TARGET"
    ok "Пользователь назначен администратором (его сеансы завершены — нужен новый вход)"
    ;;
  chief)
    # главный администратор отключён каталогом или недоступен: роль назначает оператор сервера
    uid="$(need_user "$TARGET")"
    [ "$(sql "$TARGET" "select disabled_at is null from users where id = '$uid'" | tr -d '[:space:]')" = t ] \
      || die "Учётная запись $TARGET отключена: сначала включите её (enable) или выберите другого сотрудника"
    confirm "Пользователь $TARGET станет главным администратором; прежний главный (если есть) останется полным администратором."
    sql "$TARGET" "begin; update users set chief = false where chief and id <> '$uid'; update users set chief = true, role = 'admin', admin_role_id = null where id = '$uid'; delete from settings where key = 'chief.transfer'; update sessions set revoked_at = now() where user_id = '$uid' and revoked_at is null; commit" >/dev/null
    audit_op admin.chief.assign "$uid" "$TARGET"
    ok "Пользователь назначен главным администратором (его сеансы завершены — нужен новый вход)"
    ;;
  new-setup-token)
    n="$(sql "" "select count(*) from users" | tr -d '[:space:]')"
    [ "${n:-1}" = 0 ] || die "В системе уже есть пользователи ($n): код первой настройки больше не используется. Для доступа к существующей учётной записи используйте reset-mfa, promote или код восстановления."
    token="$(rand_secret 24)"
    env_set "$ENV_FILE" BOOTSTRAP_TOKEN "$token"
    info "Перезапуск приложения для применения нового кода…"
    export_build_info
    dc up -d --no-build --wait --wait-timeout 120 app >/dev/null || die "Приложение не перезапустилось (scripts/logs.sh)"
    ok "Новый код первой настройки записан в $ENV_FILE (параметр BOOTSTRAP_TOKEN)"
    ;;
  *) die "Неизвестная команда: $CMD" ;;
esac
