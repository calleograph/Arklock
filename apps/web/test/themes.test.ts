import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_IDS } from '@arklock/contracts';
import { DARK_THEMES, GLASS_THEMES, PREVIEW, THEMES } from '../src/services/theme';

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const css = read('src/style.css');

/** Относительная яркость и контраст WCAG. */
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('themes', () => {
  it('every theme has a palette, a preview, a pre-paint colour and a name in both languages', () => {
    const init = read('public/theme-init.js');
    const html = read('index.html');
    const ru = read('src/i18n/ru.extra.ts');
    const en = read('src/i18n/en.extra.ts');
    for (const id of THEME_IDS) {
      expect(css, id).toContain(`[data-theme='${id}']`);
      expect(PREVIEW[id], id).toBeDefined();
      expect(init, id).toContain(id);
      expect(ru, id).toContain(`    ${id}: '`);
      expect(en, id).toContain(`    ${id}: '`);
      if (id !== 'corporate') expect(html, id).toContain(`html[data-theme='${id}']`);
    }
    expect(THEMES).toEqual(THEME_IDS);
  });

  it('glass themes ship local backgrounds and nothing is fetched from outside', () => {
    for (const id of GLASS_THEMES) {
      const svg = read(`public/bg/${id}.svg`);
      expect(svg.length, id).toBeLessThan(4000);
      expect(svg, id).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    }
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
    expect(css).not.toMatch(/@import\s+url/);
  });

  it('text and accent buttons keep AA contrast on every glass theme', () => {
    const block = (id: string) =>
      css.slice(css.indexOf(`:root[data-theme='${id}'] {`)).split('}')[0] ?? '';
    for (const id of GLASS_THEMES) {
      const b = block(id);
      const v = (name: string) => b.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))?.[1] ?? '';
      const dark = DARK_THEMES.includes(id);
      const surface = v(dark ? 'color-slate-900' : 'color-white') || PREVIEW[id].card;
      expect(
        contrast(v(dark ? 'color-slate-100' : 'color-slate-900'), surface),
        `${id} text`,
      ).toBeGreaterThanOrEqual(7);
      expect(contrast(v('color-slate-500'), surface), `${id} muted`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v('on-brand'), v('color-brand-500')), `${id} button`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
