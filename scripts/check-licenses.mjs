#!/usr/bin/env node
/**
 * Инвентаризация лицензий продуктивных зависимостей (то, что попадает в образ и в веб-клиент).
 * Код возврата 1, если найдена лицензия, требующая отдельного решения (copyleft, неизвестная, несвободная).
 * Запуск: node scripts/check-licenses.mjs [--list] [--write-notices]  (последнее обновляет THIRD-PARTY-NOTICES.md)
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|BlueOak-1\.0\.0|0BSD|CC0-1\.0|Unlicense|Python-2\.0|OFL-1\.1 \(font\))$/;
const tree = JSON.parse(
  execSync('npm ls --omit=dev --all --json', { maxBuffer: 1 << 28 }).toString(),
);

const found = new Map();
(function walk(deps) {
  for (const [name, dep] of Object.entries(deps ?? {})) {
    if (dep.version && !name.startsWith('@arklock/')) found.set(name, dep.version);
    walk(dep.dependencies);
  }
})(tree.dependencies);

const byLicense = new Map();
const rows = [];
for (const name of found.keys()) {
  const file = path.join('node_modules', name, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  let lic = pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
  if (typeof lic === 'object') lic = lic.type;
  // Шрифты под OFL-1.1 допустимы: это свободная лицензия для файлов шрифтов, а не для кода
  if (lic === 'OFL-1.1' && name.startsWith('@fontsource')) lic = 'OFL-1.1 (font)';
  const list = byLicense.get(lic) ?? [];
  list.push(`${name}@${pkg.version}`);
  const repo =
    typeof pkg.repository === 'string'
      ? pkg.repository
      : (pkg.repository?.url ?? pkg.homepage ?? '');
  rows.push(
    `| ${name} | ${pkg.version} | ${lic} | ${repo.replace(/^git\+/, '').replace(/\.git$/, '')} |`,
  );
  byLicense.set(lic, list);
}

if (process.argv.includes('--write-notices')) {
  writeFileSync(
    'THIRD-PARTY-NOTICES.md',
    [
      '# Сторонние компоненты',
      '',
      'Arklock использует перечисленные ниже библиотеки (продуктивные зависимости, попадающие в образ и веб-клиент). Каждая распространяется на условиях своей лицензии; тексты лицензий — в каталогах пакетов (node_modules/ИМЯ/LICENSE) и в образе приложения. Файл создаётся командой `node scripts/check-licenses.mjs --write-notices`.',
      'Прочие материалы (список слов EFF и др.) — в файле [NOTICE](NOTICE).',
      '',
      '| Пакет | Версия | Лицензия | Источник |',
      '| --- | --- | --- | --- |',
      ...rows.sort(),
      '',
    ].join(String.fromCharCode(10)),
  );
  console.log('Обновлён THIRD-PARTY-NOTICES.md');
}

let bad = 0;
for (const [lic, names] of [...byLicense].sort()) {
  const ok = ALLOWED.test(lic);
  if (!ok) bad += names.length;
  const detail = !ok || process.argv.includes('--list') ? `  ${names.join(', ')}` : '';
  console.log(
    `${ok ? 'ok  ' : 'CHECK'} ${lic.padEnd(22)} ${String(names.length).padStart(4)}${detail}`,
  );
}
if (bad) {
  console.error(`Пакетов, требующих проверки лицензии: ${bad}`);
  process.exit(1);
}
console.log('Все продуктивные зависимости имеют разрешённые лицензии.');

// Собственная лицензия проекта: текст LICENSE и SPDX-идентификатор во всех манифестах.
const licenseText = readFileSync('LICENSE', 'utf8');
if (
  !licenseText.includes('GNU AFFERO GENERAL PUBLIC LICENSE') ||
  !licenseText.includes('Version 3, 19 November 2007')
) {
  console.error('LICENSE не содержит текст GNU AGPL-3.0');
  process.exit(1);
}
for (const manifest of [
  'package.json',
  'packages/crypto/package.json',
  'packages/contracts/package.json',
  'apps/api/package.json',
  'apps/web/package.json',
]) {
  const { license } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (license !== 'AGPL-3.0-only') {
    console.error(`${manifest}: license должен быть AGPL-3.0-only, найдено: ${license}`);
    process.exit(1);
  }
}
console.log('Лицензия проекта: AGPL-3.0-only (LICENSE и манифесты согласованы).');
