#!/usr/bin/env bash
# Создаёт локальный «удалённый» репозиторий с набором тестовых релизов для проверки обновления и отката.
#   tests/update/make-fixture.sh ИСТОЧНИК ЦЕЛЬ.git
# v0.0.1 — исходное состояние;  v0.0.2 — безопасная новая миграция;  v0.0.3 — миграция с ошибкой (обновление должно откатиться);
# v0.0.4 — ошибка сборки образа (обновление не должно затронуть работающую версию).
set -euo pipefail
SRC="$1"; DEST="$2"
WORK="$(mktemp -d)"
git clone -q --no-hardlinks "$SRC" "$WORK/w"
cd "$WORK/w"
git config user.name ci; git config user.email ci@example.com
git checkout -q --detach HEAD
# Теги рабочей копии (например, опубликованный v1.0.0) не должны попасть во фикстуру: updater выбирает наибольший тег.
git tag -l | xargs -r git tag -d >/dev/null
J=apps/api/drizzle/meta/_journal.json

release() { # release ВЕРСИЯ
  echo "$1" > VERSION
  git add -A; git commit -q -m "release $1"; git tag "v$1"
}
add_migration() { # add_migration ИМЯ SQL
  local idx; idx="$(grep -c '"tag"' "$J")"
  printf '%s\n' "$2" > "apps/api/drizzle/${idx}_$1.sql"
  node -e "
    const fs=require('fs');const j=JSON.parse(fs.readFileSync('$J','utf8'));
    j.entries.push({idx:$idx,version:'7',when:Date.now()+$idx*1000,tag:'${idx}_$1',breakpoints:true});
    fs.writeFileSync('$J',JSON.stringify(j,null,2)+'\n');"
}

release 0.0.1
add_migration probe 'CREATE TABLE update_probe (id integer);'
release 0.0.2
add_migration broken 'SELECT 1/0;'
release 0.0.3
git checkout -q v0.0.2
printf '\nRUN exit 1\n' >> Dockerfile
release 0.0.4

git init -q --bare "$DEST"
git push -q "$DEST" --tags
rm -rf "$WORK"
echo "Фикстура создана: $DEST (теги v0.0.1 … v0.0.4)"
