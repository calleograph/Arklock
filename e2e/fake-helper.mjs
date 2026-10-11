// Имитация помощника обновлений для браузерных тестов интерфейса: читает request.txt и пишет файлы обмена.
// Реальный помощник (scripts/updater.sh) проверяется отдельно в CI.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const f = (n) => path.join(dir, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (n, obj) => {
  const tmp = f(`.${n}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, f(n));
};
const beat = () =>
  writeFileSync(
    f('helper.json'),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), pid: process.pid }),
  );

async function handle(req) {
  const base = {
    request_id: req.request_id,
    action: req.action,
    started_at: new Date().toISOString(),
  };
  if (req.action === 'check') {
    write('remote.json', {
      checked_at: new Date().toISOString(),
      status: 'available',
      latest: 'v9.9.9',
      changelog: '## 9.9.9\n- Тестовое изменение',
      migrations: 1,
    });
    return;
  }
  const steps = ['Проверка', 'Резервная копия', 'Загрузка', 'Миграции', 'Проверка работы'];
  const to = req.version ?? 'v0.0.9';
  for (let i = 0; i < steps.length; i++) {
    write('status.json', {
      ...base,
      state: 'running',
      step_no: i + 1,
      step_total: steps.length,
      step_name: steps[i],
      version_from: '0.1.0',
      version_to: to,
    });
    beat();
    await sleep(700);
  }
  write('status.json', {
    ...base,
    state: 'success',
    step_no: steps.length,
    step_total: steps.length,
    step_name: 'Готово',
    finished_at: new Date().toISOString(),
    message: 'Обновление завершено',
    version_from: '0.1.0',
    version_to: to,
  });
  appendFileSync(
    f('history.jsonl'),
    JSON.stringify({
      at: new Date().toISOString(),
      action: req.action,
      result: 'success',
      version_from: '0.1.0',
      version_to: to,
    }) + '\n',
  );
}

for (;;) {
  beat();
  if (existsSync(f('request.txt'))) {
    const req = Object.fromEntries(
      readFileSync(f('request.txt'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    unlinkSync(f('request.txt'));
    await handle(req);
  }
  await sleep(300);
}
