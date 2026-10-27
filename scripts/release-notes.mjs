#!/usr/bin/env node
/**
 * Примечания к выпускам из CHANGELOG.md — единственный источник пользовательских изменений.
 *   node scripts/release-notes.mjs --write        обновить apps/web/src/release-notes.json (его показывает «Что нового»)
 *   node scripts/release-notes.mjs --check        проверить CHANGELOG и актуальность JSON (CI, релиз)
 *   node scripts/release-notes.mjs --notes 1.2.3  напечатать примечания версии (текст GitHub Release)
 * Категории: «Новые возможности», «Улучшения», «Исправления», «Безопасность», «Обновление», «Известные ограничения».
 * Прежние заголовки («Добавлено», «Изменено», «Исправлено», «Ограничения»…) распознаются и сводятся к ним же.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const OUT = path.join(ROOT, 'apps/web/src/release-notes.json');
/** В приложение попадают последние выпуски; полная история — в CHANGELOG.md и на странице выпусков. */
const KEEP = 30;

export const CATEGORIES = {
  features: 'Новые возможности',
  improvements: 'Улучшения',
  fixes: 'Исправления',
  security: 'Безопасность',
  upgrade: 'Обновление',
  limits: 'Известные ограничения',
};
const ALIASES = [
  [/^(новые возможности|добавлено)$/i, 'features'],
  [/^(улучшения|изменено)$/i, 'improvements'],
  [/^(исправления|исправлено)$/i, 'fixes'],
  [/^безопасность$/i, 'security'],
  [/^(обновление|выпуск и установка|установка и обслуживание)$/i, 'upgrade'],
  [/^(известные ограничения|ограничения)$/i, 'limits'],
];
const categoryOf = (title) => ALIASES.find(([re]) => re.test(title.trim()))?.[1] ?? 'improvements';
const PLACEHOLDER =
  /\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b|<[^>\n]*(здесь|описание|вставьте)[^>\n]*>/i;

export function parse(text) {
  const releases = [];
  let rel = null;
  let sec = null;
  let item = null;
  for (const line of text.split('\n')) {
    const h2 = /^## \[([^\]]+)\](?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (h2) {
      rel = { version: h2[1], date: h2[2] ?? null, sections: [] };
      releases.push(rel);
      sec = item = null;
      continue;
    }
    if (!rel) continue;
    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      const id = categoryOf(h3[1]);
      sec = rel.sections.find((s) => s.id === id);
      if (!sec) rel.sections.push((sec = { id, items: [] }));
      item = null;
      continue;
    }
    if (!sec) continue;
    const b = /^- (.*)$/.exec(line);
    if (b) {
      item = b[1].trim();
      sec.items.push(item);
      continue;
    }
    // продолжение пункта и вложенный список остаются в том же пункте
    if (item !== null && /^\s+\S/.test(line)) {
      sec.items[sec.items.length - 1] += ' ' + line.trim().replace(/^[-*] /, '— ');
    } else if (!line.trim()) item = null;
  }
  return releases;
}

const order = Object.keys(CATEGORIES);
const sorted = (r) => ({
  ...r,
  sections: [...r.sections].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
});

export function notesOf(rel) {
  return sorted(rel)
    .sections.map((s) => `### ${CATEGORIES[s.id]}\n\n${s.items.map((i) => `- ${i}`).join('\n')}`)
    .join('\n\n');
}

function build() {
  const all = parse(readFileSync(CHANGELOG, 'utf8')).filter((r) =>
    /^\d+\.\d+\.\d+$/.test(r.version),
  );
  return { releases: all.slice(0, KEEP).map(sorted) };
}

const arg = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (arg === '--write') {
    writeFileSync(OUT, JSON.stringify(build()) + '\n');
    console.log(
      `Примечания: ${build().releases.length} выпусков → apps/web/src/release-notes.json`,
    );
  } else if (arg === '--notes') {
    const rel = build().releases.find((r) => r.version === process.argv[3]);
    if (!rel) {
      console.error(`CHANGELOG.md не содержит выпуска ${process.argv[3]}`);
      process.exit(1);
    }
    console.log(notesOf(rel));
  } else if (arg === '--check') {
    const errors = [];
    const version = readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    const data = build();
    const rel = data.releases.find((r) => r.version === version);
    if (!rel) errors.push(`CHANGELOG.md: нет раздела «## [${version}] — ГГГГ-ММ-ДД»`);
    else {
      if (!rel.date) errors.push(`CHANGELOG.md: у выпуска ${version} нет даты`);
      if (!rel.sections.some((s) => s.items.length))
        errors.push(`CHANGELOG.md: выпуск ${version} без единого пункта`);
      for (const s of rel.sections) {
        if (!s.items.length)
          errors.push(`CHANGELOG.md: пустая категория «${CATEGORIES[s.id]}» в ${version}`);
        for (const i of s.items) {
          if (!i.replace(/[*`\s]/g, '')) errors.push(`CHANGELOG.md: пустой пункт в ${version}`);
          if (PLACEHOLDER.test(i))
            errors.push(`CHANGELOG.md: шаблонный текст в ${version}: «${i.slice(0, 60)}»`);
        }
      }
    }
    if (data.releases[0]?.version !== version && rel)
      errors.push(
        `CHANGELOG.md: самый новый раздел — ${data.releases[0]?.version}, а VERSION — ${version}`,
      );
    let stored = '';
    try {
      stored = readFileSync(OUT, 'utf8');
    } catch {
      /* ниже будет понятная ошибка */
    }
    if (stored !== JSON.stringify(data) + '\n')
      errors.push(
        'apps/web/src/release-notes.json устарел: выполните node scripts/release-notes.mjs --write',
      );
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    console.log(`Примечания к выпуску ${version}: ${rel.sections.length} категорий, JSON актуален`);
  } else {
    console.error('Использование: release-notes.mjs --write | --check | --notes <версия>');
    process.exit(2);
  }
}
