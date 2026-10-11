// Имитация помощника обновлений для браузерных тестов интерфейса: читает request.txt и пишет файлы обмена.
// Реальный помощник (scripts/updater.sh) проверяется отдельно в CI.
import {
  appendFileSync,
  mkdirSync,
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

// Снимки состояния, которые публикует настоящий помощник
let backups = [];
const publishBackups = () =>
  write('backups.json', { dir: '/var/lib/arklock/backups', free_gib: 42, items: backups });
write('containers.json', {
  at: new Date().toISOString(),
  items: [
    {
      service: 'app',
      image: 'arklock:local',
      state: 'running',
      health: 'healthy',
      started_at: new Date().toISOString(),
      restarts: 0,
      cpu: '1.0%',
      memory: '100MiB / 2GiB',
    },
    {
      service: 'db',
      image: 'postgres:16-alpine',
      state: 'running',
      health: 'healthy',
      started_at: new Date().toISOString(),
      restarts: 0,
      cpu: '0.5%',
      memory: '50MiB / 2GiB',
    },
  ],
});
write('schedule.json', { enabled: false, hour: 3, keep: 14, last_at: '', last_result: '' });
publishBackups();

function finish(base, ok, message) {
  write('status.json', {
    ...base,
    state: ok ? 'success' : 'failed',
    step_no: 1,
    step_total: 1,
    step_name: '',
    finished_at: new Date().toISOString(),
    result: ok ? 'success' : 'failed',
    message,
    version_from: '0.1.0',
    version_to: '',
  });
  appendFileSync(
    f('history.jsonl'),
    JSON.stringify({
      at: new Date().toISOString(),
      action: base.action,
      result: ok ? 'success' : 'failed',
      message,
    }) + '\n',
  );
}

async function handleOps(req, base) {
  write('status.json', {
    ...base,
    state: 'running',
    step_no: 1,
    step_total: 1,
    step_name: req.action,
  });
  await sleep(500);
  switch (req.action) {
    case 'backup': {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const name = `arklock-${stamp}Z-v0.1.0${req.label ? '-' + req.label : ''}.bak.gpg`;
      backups.unshift({
        name,
        size: 4096,
        created_at: new Date().toISOString(),
        sha256: 'ab'.repeat(32),
        version: '0.1.0',
        migrations: 1,
      });
      publishBackups();
      return finish(base, true, 'Резервная копия создана и проверена');
    }
    case 'backup_verify':
      return finish(base, true, `Копия ${req.file} корректна`);
    case 'backup_delete':
      backups = backups.filter((b) => b.name !== req.file);
      publishBackups();
      return finish(base, true, `Копия ${req.file} удалена`);
    case 'backup_export':
      mkdirSync(f('export'), { recursive: true });
      writeFileSync(path.join(f('export'), req.file), 'ENCRYPTED-FAKE-BACKUP');
      return finish(base, true, 'Копия готова к скачиванию на 10 минут');
    case 'restore':
      return finish(base, true, `База данных восстановлена из ${req.file}`);
    case 'logs':
      writeFileSync(
        f('logs.txt'),
        `${req.service}: started\n${req.service}: ready token=[masked]\n`,
      );
      writeFileSync(f('logs.service'), req.service + '\n');
      return finish(base, true, 'Журнал получен');
    case 'schedule':
      write('schedule.json', {
        enabled: req.schedule_enabled === '1',
        hour: Number(req.schedule_hour),
        keep: Number(req.schedule_keep),
        last_at: '',
        last_result: '',
      });
      return finish(base, true, 'Расписание сохранено');
  }
}

async function handle(req) {
  const base = {
    request_id: req.request_id,
    action: req.action,
    started_at: new Date().toISOString(),
  };
  if (
    [
      'backup',
      'backup_verify',
      'backup_delete',
      'backup_export',
      'restore',
      'logs',
      'schedule',
    ].includes(req.action)
  ) {
    return handleOps(req, base);
  }
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
