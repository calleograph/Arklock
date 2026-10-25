import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
const N = 30_000;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'big-admin@example.com', 'big-directory-pass-1234');
  await admin.register();
  await admin.login();
  // 30 000 синтетических сотрудников одним запросом: ключи фиктивные, входить они не будут
  await fixture.database.db.execute(sql`
    insert into users (id, email, display_name, role, kdf, kdf_salt, auth_salt, auth_hash, public_key, sign_public_key,
      wrapped_private_key, wrapped_sign_private_key, recovery_salt, recovery_hash, recovery_wrapped_private_key,
      recovery_wrapped_sign_private_key, title, department)
    select gen_random_uuid(), 'user' || g || '@corp.example', 'Сотрудник ' || lpad(g::text, 5, '0'), 'member', '{}',
      'o', 'o', 'o', 'o', 'o', 'o', 'o', 'o', 'o', 'o', 'o',
      case when g % 7 = 0 then 'Руководитель группы' else 'Специалист' end,
      'Отдел ' || (g % 20)
    from generate_series(1, ${N}) g`);
}, 120_000);
afterAll(async () => fixture.app.close());

const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = Date.now();
  const r = await f();
  return [r, Date.now() - t];
};

it('searches 30 000 employees on the server within a second or two, a page at a time', async () => {
  const [byName, t1] = await timed(() =>
    admin.req('GET', '/admin/people?q=Сотрудник 12345&limit=12'),
  );
  expect(byName.json().items[0].name).toBe('Сотрудник 12345');
  const [byTitle, t2] = await timed(() =>
    admin.req('GET', '/admin/people?q=Руководитель&limit=12'),
  );
  expect(byTitle.json().total).toBe(Math.floor(N / 7));
  const [first, t3] = await timed(() => admin.req('GET', '/admin/people?limit=12'));
  expect(first.json().total).toBe(N + 1);
  expect(first.json().items).toHaveLength(12);
  // пределы щедрые (общий сервер, PGlite): важно, что время не растёт с размером списка до десятков секунд
  process.stdout.write(
    `${`30k: поиск по имени ${t1} мс, по должности ${t2} мс, первая страница ${t3} мс`.slice(1, -1)}\n`,
  );
  for (const t of [t1, t2, t3]) expect(t).toBeLessThan(3000);
});

it('pages the user list and sorts it on the server', async () => {
  const [page, t] = await timed(() =>
    admin.req('GET', '/admin/users?limit=50&offset=15000&sort=name'),
  );
  const body = page.json();
  expect(body.total).toBe(N + 1);
  expect(body.items).toHaveLength(50);
  process.stdout.write(
    `${`30k: страница списка пользователей со смещением 15000 — ${t} мс`.slice(1, -1)}\n`,
  );
  expect(t).toBeLessThan(4000);
  const [filtered] = await timed(() => admin.req('GET', '/admin/users?limit=50&q=user29999@'));
  expect(filtered.json().items.map((u: { email: string }) => u.email)).toEqual([
    'user29999@corp.example',
  ]);
});

it('keeps the groups list and group search independent of the number of employees', async () => {
  for (let i = 0; i < 25; i++)
    await admin.req('POST', '/admin/circles', { name: `Подразделение ${i}` });
  const [list, t] = await timed(() =>
    admin.req('GET', '/admin/circles?limit=10&q=Подразделение 2'),
  );
  expect(list.json().items.length).toBeGreaterThan(0);
  expect(t).toBeLessThan(2000);
});
