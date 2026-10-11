#!/usr/bin/env node
/**
 * Инвентаризация лицензий продуктивных зависимостей (то, что попадает в образ и в веб-клиент).
 * Код возврата 1, если найдена лицензия, требующая отдельного решения (copyleft, неизвестная, несвободная).
 * Запуск: node scripts/check-licenses.mjs [--list]
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|BlueOak-1\.0\.0|0BSD|CC0-1\.0|Unlicense|Python-2\.0)$/;
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
for (const name of found.keys()) {
  const file = path.join('node_modules', name, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  let lic = pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
  if (typeof lic === 'object') lic = lic.type;
  const list = byLicense.get(lic) ?? [];
  list.push(`${name}@${pkg.version}`);
  byLicense.set(lic, list);
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
