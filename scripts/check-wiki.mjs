#!/usr/bin/env node
/**
 * Проверка исходников вики (каталог wiki/): внутренние ссылки и изображения, строка версии и даты вверху страницы,
 * достижимость каждой страницы из боковой панели или главной, совпадение версии с файлом VERSION.
 * Запуск: node scripts/check-wiki.mjs   Код возврата: 0 — чисто, 1 — найдены ошибки.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = path.join(ROOT, 'wiki');
const VERSION = readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const SERVICE = new Set(['_Sidebar.md', '_Footer.md']);
const HEADER =
  /^> Относится к версии (\d+\.\d+\.\d+) · проверено (\d{4}-\d{2}-\d{2}) · уровень проверки \d/m;

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

const pages = readdirSync(WIKI).filter((f) => f.endsWith('.md'));
const names = new Set(pages.map((f) => f.slice(0, -3)));
const linked = new Set(['Home']);

for (const file of pages) {
  const text = readFileSync(path.join(WIKI, file), 'utf8');
  if (/\s/.test(file)) fail(file, 'в имени файла пробел: используйте дефис');
  if (!SERVICE.has(file)) {
    const m = HEADER.exec(text);
    if (!m)
      fail(file, 'нет строки «Относится к версии X · проверено ГГГГ-ММ-ДД · уровень проверки N»');
    else if (m[1] !== VERSION) fail(file, `версия ${m[1]} не совпадает с VERSION (${VERSION})`);
  }
  // ссылки вида [текст](цель); код в блоках ``` исключается
  const body = text.replace(/```[\s\S]*?```/g, '');
  for (const [, , raw] of body.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0]);
    if (target.startsWith('images/')) {
      if (!existsSync(path.join(WIKI, target))) fail(file, `нет изображения ${target}`);
    } else if (!names.has(target)) fail(file, `ссылка на несуществующую страницу «${target}»`);
    else if (file === '_Sidebar.md' || file === 'Home.md') linked.add(target);
  }
  for (const [, alt, src] of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    if (!alt.trim()) fail(file, `у изображения ${src} нет текста-замены`);
  }
  if (/ТРЕБУЕТ ПРОВЕРКИ/.test(text)) console.log(`пометка «ТРЕБУЕТ ПРОВЕРКИ»: ${file}`);
}
for (const p of names) {
  if (!SERVICE.has(`${p}.md`) && !linked.has(p))
    fail(`${p}.md`, 'нет ссылки из боковой панели или главной страницы');
}
if (!pages.includes('Home.md')) fail('Home.md', 'нет главной страницы');

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\nНайдено ошибок: ${errors.length}`);
  process.exit(1);
}
console.log(`Вики: ${pages.length} файлов, версия ${VERSION}, ошибок нет`);
