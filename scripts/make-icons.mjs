#!/usr/bin/env node
/**
 * Значки приложения из одного векторного знака (apps/web/public/favicon.svg): node scripts/make-icons.mjs.
 * PNG рисует Chromium из Playwright (уже есть в зависимостях разработки), поэтому края сглажены и цвета совпадают с SVG.
 * Маскируемый значок и значок iOS — без скругления, знак уменьшен в «безопасную зону».
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const dir = new URL('../apps/web/public/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', dir), 'utf8');
// фон без скругления для маскируемых значков: система сама обрезает их по своей форме
const fullBleed = svg
  .replace('<rect width="64" height="64" rx="15"', '<rect width="64" height="64" rx="0"')
  .replace(/<rect x="0\.75"[^>]*\/>/, '')
  .replace(
    '<g fill="none"',
    '<g transform="translate(32 32) scale(0.78) translate(-32 -32)" fill="none"',
  );

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(source, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  writeFileSync(new URL(`icons/${file}`, dir), await page.screenshot({ omitBackground: true }));
}
await render(svg, 192, '192.png');
await render(svg, 512, '512.png');
await render(svg, 32, 'favicon-32.png');
await render(fullBleed, 512, 'maskable-512.png');
await render(fullBleed, 180, 'apple-touch-icon.png');
await browser.close();
console.log('icons written');
