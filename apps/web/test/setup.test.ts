import { beforeEach, describe, expect, it, vi } from 'vitest';

// ответы сервера по адресам; чего нет — запрос «падает», как у делегированного администратора без прав
const replies = new Map<string, unknown>();
vi.mock('../src/services/api', () => ({
  api: vi.fn(async (_m: string, url: string) => {
    if (!replies.has(url)) throw new Error('forbidden');
    return replies.get(url);
  }),
}));
const { loadSetup } = await import('../src/services/setup');

const ids = (s: Awaited<ReturnType<typeof loadSetup>>) => s.steps.map((x) => x.id);

describe('first-time setup steps', () => {
  beforeEach(() => {
    replies.clear();
    replies.set('/admin/diagnostics', {
      checks: [
        { id: 'public-url', level: 'ok' },
        { id: 'smtp', level: 'warn' },
        { id: 'mfa-policy', level: 'warn' },
      ],
    });
    replies.set('/admin/settings', {});
    replies.set('/admin/ldap/profiles', { profiles: [] });
    replies.set('/admin/departments?limit=200', { items: [] });
    replies.set('/admin/people?limit=1&status=active', { total: 1 });
    replies.set('/admin/invitations', []);
  });

  it('asks how employees sign in before anything else of that kind and continues from the first required gap', async () => {
    const s = await loadSetup();
    expect(s.signIn).toBeNull();
    expect(ids(s)).toEqual([
      'url',
      'mail',
      'signIn',
      'departments',
      'peopleLocal',
      'mfa',
      'backup',
      'recovery',
    ]);
    // адрес готов, почта только рекомендуется: «сейчас» — выбор способа входа
    expect(s.current?.id).toBe('signIn');
    expect(s.done).toBe(1);
    expect(s.total).toBe(8);
  });

  it('a saved directory connection means the directory way, with its own steps', async () => {
    replies.set('/admin/ldap/profiles', {
      profiles: [
        {
          enabled: false,
          access: null,
          groups: [],
          status: { connection: { ok: true } },
        },
      ],
    });
    replies.set('/admin/people/summary', { waiting: 3, signedIn: 0 });
    const s = await loadSetup();
    expect(s.signIn).toBe('directory');
    expect(ids(s)).toEqual([
      'url',
      'mail',
      'signIn',
      'connect',
      'login',
      'access',
      'keys',
      'departments',
      'groups',
      'peopleDirectory',
      'mfa',
      'backup',
      'recovery',
    ]);
    expect(s.steps.find((x) => x.id === 'connect')?.done).toBe(true);
    // вход не разрешён: это следующий обязательный шаг; режим ключей — выбор, а не «невыполнено»
    expect(s.current?.id).toBe('access');
    expect(s.steps.find((x) => x.id === 'keys')?.done).toBeNull();
    expect(s.steps.find((x) => x.id === 'peopleDirectory')?.params).toEqual({
      waiting: 3,
      signedIn: 0,
    });
  });

  it('invited employees count for the invitation way; a department without a head is not done', async () => {
    replies.set('/admin/settings', { 'setup.signIn': 'local' });
    replies.set('/admin/invitations', [{ status: 'pending' }, { status: 'used' }]);
    replies.set('/admin/people?limit=1&status=active', { total: 4 });
    replies.set('/admin/departments?limit=200', { items: [{ heads: [], vaults: 1 }] });
    const s = await loadSetup();
    const people = s.steps.find((x) => x.id === 'peopleLocal')!;
    expect(people.done).toBe(true);
    expect(people.params).toEqual({ waiting: 1, signedIn: 3 });
    const dept = s.steps.find((x) => x.id === 'departments')!;
    expect(dept.done).toBe(false);
    expect(dept.parts?.map((p) => p.done)).toEqual([true, false, true]);
    expect(s.current?.id).toBe('departments');
  });
});
