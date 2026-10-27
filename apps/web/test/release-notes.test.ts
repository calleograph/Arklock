import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { between, cmpVersion, inline, type Release } from '../src/services/releases';
// @ts-expect-error — скрипт на чистом JavaScript
import { parse } from '../../../scripts/release-notes.mjs';

const changelog = readFileSync(path.resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');

describe('release notes', () => {
  it('parses categories, legacy headings and multi-line items', () => {
    const rel = parse(
      '## [1.2.3] — 2026-01-02\n\n### Добавлено\n\n- Первое\n  продолжение\n\n### Безопасность\n\n- Второе\n',
    )[0] as Release;
    expect(rel).toMatchObject({ version: '1.2.3', date: '2026-01-02' });
    expect(rel.sections.map((s) => s.id)).toEqual(['features', 'security']);
    expect(rel.sections[0]!.items[0]).toBe('Первое продолжение');
  });

  it('every release of CHANGELOG has a date and items in the latest 30', () => {
    for (const r of (parse(changelog) as Release[])
      .filter((x) => /^\d/.test(x.version))
      .slice(0, 30)) {
      expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.sections.flatMap((s) => s.items).length, r.version).toBeGreaterThan(0);
    }
  });

  it('compares versions numerically and selects the skipped releases', () => {
    expect(cmpVersion('1.10.0', '1.9.0')).toBeGreaterThan(0);
    const all = ['1.5.0', '1.4.0', '1.3.0', '1.2.0'].map((version) => ({
      version,
      date: null,
      sections: [],
    }));
    expect(between(all, '1.3.0', '1.5.0').map((r) => r.version)).toEqual(['1.5.0', '1.4.0']);
    expect(between(all, null, '1.5.0')).toHaveLength(4);
    expect(between(all, '1.5.0', '1.5.0')).toEqual([]);
  });

  it('escapes markup in release text', () => {
    expect(inline('**a** <img onerror=x> `c`')).toBe(
      '<strong>a</strong> &lt;img onerror=x&gt; <code>c</code>',
    );
  });
});
