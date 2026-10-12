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
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Атомарная запись (временный файл и переименование). В Windows переименование поверх открытого файла может отказать — повтор, затем запись напрямую. */
const write = (n, obj) => {
  const tmp = f(`.${n}.tmp`);
  const json = JSON.stringify(obj);
  writeFileSync(tmp, json);
  for (let i = 0; i < 8; i++) {
    try {
      renameSync(tmp, f(n));
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      pause(15);
    }
  }
  writeFileSync(f(n), json);
};
const beat = () => write('helper.json', { ts: Math.floor(Date.now() / 1000), pid: process.pid });

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

// Удалённое хранилище: настройка (с секретом) остаётся только здесь, как у настоящего помощника
let offsite = null; // { cfg, items, last }
const publishOffsite = () => {
  const c = offsite?.cfg;
  write('offsite.json', {
    configured: !!c,
    type: c?.type ?? '',
    endpoint: c?.endpoint ?? '',
    region: c?.region ?? '',
    bucket: c?.bucket ?? '',
    prefix: c?.prefix ?? '',
    host: c?.host ?? '',
    share: c?.share ?? '',
    user: c?.user ?? '',
    auto: c?.auto === '1',
    keep: Number(c?.keep ?? 14),
    last_at: offsite?.last?.at ?? '',
    last_result: offsite?.last?.result ?? '',
    last_file: offsite?.last?.file ?? '',
    last_error: '',
    listed_at: new Date().toISOString(),
    list_error: '',
    items: offsite?.items ?? [],
  });
};
publishOffsite();

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
    case 'offsite_import': {
      const input = f('offsite-config.in');
      if (!existsSync(input)) return finish(base, false, 'Файл настройки не найден');
      const cfg = Object.fromEntries(
        readFileSync(input, 'utf8')
          .trim()
          .split('\n')
          .map((l) => {
            const i = l.indexOf('=');
            return [l.slice(0, i), Buffer.from(l.slice(i + 1), 'base64').toString()];
          }),
      );
      unlinkSync(input);
      const old = offsite?.cfg;
      // пустой секрет — оставить прежний
      if (!cfg.secret_key && old?.secret_key) cfg.secret_key = old.secret_key;
      if (!cfg.password && old?.password) cfg.password = old.password;
      offsite = { cfg, items: offsite?.items ?? [], last: offsite?.last };
      publishOffsite();
      return finish(base, true, 'Настройка удалённого хранилища сохранена');
    }
    case 'offsite_test':
      return finish(base, !!offsite, offsite ? 'Соединение проверено' : 'Хранилище не настроено');
    case 'offsite_push': {
      const b = backups.find((x) => x.name === req.file);
      if (!offsite || !b) return finish(base, false, 'Копия не найдена');
      offsite.items = [
        { name: b.name, size: b.size },
        ...offsite.items.filter((x) => x.name !== b.name),
      ].slice(0, Number(offsite.cfg.keep));
      offsite.last = { at: new Date().toISOString(), result: 'ok', file: b.name };
      publishOffsite();
      return finish(base, true, `Копия ${b.name} отправлена и проверена на хранилище`);
    }
    case 'offsite_verify':
      return finish(base, true, `Копия ${req.file} на хранилище цела`);
    case 'offsite_delete':
      if (offsite) offsite.items = offsite.items.filter((x) => x.name !== req.file);
      publishOffsite();
      return finish(base, true, `Копия ${req.file} удалена с хранилища`);
    case 'offsite_pull':
      return finish(base, true, `Копия ${req.file} загружена и проверена`);
    case 'offsite_refresh':
      publishOffsite();
      return finish(base, true, 'Список обновлён');
    case 'offsite_clear':
      offsite = null;
      publishOffsite();
      return finish(base, true, 'Настройка и секреты удалены с этого сервера');
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
      'offsite_import',
      'offsite_test',
      'offsite_push',
      'offsite_verify',
      'offsite_delete',
      'offsite_pull',
      'offsite_refresh',
      'offsite_clear',
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
