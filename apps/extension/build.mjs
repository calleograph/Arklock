// Сборка расширения для обоих браузеров: node build.mjs [chromium|firefox|all]. Цель выбирается переменной EXT_TARGET.
import { spawnSync } from 'node:child_process';

const which = process.argv[2] ?? 'all';
const targets = which === 'all' ? ['chromium', 'firefox'] : [which];
for (const target of targets) {
  if (!['chromium', 'firefox'].includes(target)) {
    console.error(`Неизвестная цель сборки: ${target}`);
    process.exit(2);
  }
  console.log(`Сборка расширения: ${target}`);
  const r = spawnSync('npx', ['vite', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, EXT_TARGET: target },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
