#!/usr/bin/env node
// Генерация значков PWA (синий квадрат с замком) без внешних зависимостей: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

function icon(size, maskable) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = maskable ? 0 : size * 0.18;
  const k = maskable ? 0.8 : 1; // маскируемый значок: рисунок в «безопасной зоне»
  const inside = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const off = (size * (1 - k)) / 2;
  const s = size * k;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      if (cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r) continue;
      const body = inside(x, y, off + s * 0.3, off + s * 0.48, off + s * 0.7, off + s * 0.78);
      const outer = inside(x, y, off + s * 0.36, off + s * 0.24, off + s * 0.64, off + s * 0.5);
      const inner = inside(x, y, off + s * 0.44, off + s * 0.32, off + s * 0.56, off + s * 0.5);
      const white = body || (outer && !inner);
      px[i] = white ? 255 : 37;
      px[i + 1] = white ? 255 : 99;
      px[i + 2] = white ? 255 : 235;
      px[i + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../apps/web/public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('192.png', out), icon(192, false));
writeFileSync(new URL('512.png', out), icon(512, false));
writeFileSync(new URL('maskable-512.png', out), icon(512, true));
writeFileSync(new URL('apple-touch-icon.png', out), icon(180, true));
console.log('icons written');
