#!/usr/bin/env bash
# Добавляет в «удалённый» репозиторий новый тестовый релиз поверх самого нового тега.
#   tests/update/publish-release.sh ORIGIN.git ВЕРСИЯ ВИД
# ВИД: good — безопасная миграция; broken-migration — миграция с ошибкой; broken-build — ошибка сборки образа.
set -euo pipefail
ORIGIN="$1"; VERSION="$2"; KIND="$3"
WORK="$(mktemp -d)"
git clone -q --no-hardlinks "$ORIGIN" "$WORK/w"
cd "$WORK/w"
git config user.name ci; git config user.email ci@example.com
LATEST="$(git tag --list 'v*' | sort -V | tail -n 1)"
git checkout -q --detach "$LATEST"
J=apps/api/drizzle/meta/_journal.json
add_migration() {
  local idx; idx="$(grep -c '"tag"' "$J")"
  printf '%s\n' "$2" > "apps/api/drizzle/${idx}_$1.sql"
  node -e "
    const fs=require('fs');const j=JSON.parse(fs.readFileSync('$J','utf8'));
    j.entries.push({idx:$idx,version:'7',when:Date.now()+$idx*1000,tag:'${idx}_$1',breakpoints:true});
    fs.writeFileSync('$J',JSON.stringify(j,null,2)+'\n');"
}
case "$KIND" in
  good) add_migration "good_${VERSION//./_}" "CREATE TABLE good_${VERSION//./_} (id integer);" ;;
  broken-migration) add_migration broken "SELECT 1/0;" ;;
  broken-build) printf '\nRUN exit 1\n' >> Dockerfile ;;
  *) echo "неизвестный вид: $KIND" >&2; exit 2 ;;
esac
echo "$VERSION" > VERSION
git add -A; git commit -q -m "release $VERSION ($KIND)"; git tag "v$VERSION"
git push -q "$ORIGIN" "v$VERSION"
rm -rf "$WORK"
echo "Опубликован v$VERSION ($KIND)"
