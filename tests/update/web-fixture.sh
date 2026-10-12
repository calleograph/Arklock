#!/usr/bin/env bash
# Локальный «удалённый» репозиторий с двумя исправными релизами v0.0.1 и v0.0.2 (для проверки обновления через браузер).
#   tests/update/web-fixture.sh ИСТОЧНИК ЦЕЛЬ.git
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
echo 0.0.1 > VERSION; git add -A; git commit -q -m "release 0.0.1"; git tag v0.0.1
idx="$(grep -c '"tag"' "$J")"
printf 'CREATE TABLE update_probe (id integer);\n' > "apps/api/drizzle/${idx}_probe.sql"
node -e "
  const fs=require('fs');const j=JSON.parse(fs.readFileSync('$J','utf8'));
  j.entries.push({idx:$idx,version:'7',when:Date.now()+$idx*1000,tag:'${idx}_probe',breakpoints:true});
  fs.writeFileSync('$J',JSON.stringify(j,null,2)+'\n');"
echo 0.0.2 > VERSION; git add -A; git commit -q -m "release 0.0.2"; git tag v0.0.2
git init -q --bare "$DEST"
git push -q "$DEST" --tags
rm -rf "$WORK"
echo "Фикстура создана: $DEST (теги v0.0.1, v0.0.2)"
