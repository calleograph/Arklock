import { api } from './api';

/**
 * Первоначальная настройка: один упорядоченный список шагов для всех мест, где о ней говорится (страница настройки,
 * полоса на обзоре, в разделе каталога и в рабочей области). Состояние каждого шага берётся из фактической
 * конфигурации сервера, поэтому отмечать ничего вручную не нужно.
 */
export type StepKind = 'required' | 'recommended' | 'optional';
export type SignIn = 'directory' | 'local' | null;
export interface SetupStep {
  id: string;
  group: 'server' | 'signin' | 'structure' | 'protection';
  kind: StepKind;
  /** null — состояние не определяется (выбор без «правильного» ответа) */
  done: boolean | null;
  to: string;
  /** подпункты шага: что уже сделано внутри него */
  parts?: { id: string; done: boolean; optional?: boolean; params?: Record<string, number> }[];
  params?: Record<string, string | number>;
}
export interface SetupState {
  signIn: SignIn;
  steps: SetupStep[];
  /** первый невыполненный обязательный шаг — с него и продолжать */
  current: SetupStep | null;
  done: number;
  total: number;
}

const ok = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

interface LdapProfile {
  enabled: boolean;
  access: string | null;
  groups: unknown[];
  status: { connection?: { ok: boolean }; login?: { ok: boolean } };
}

export async function loadSetup(): Promise<SetupState> {
  const [diag, settings, ldap, depts, people, backups, offsite, recovery, active, invites] =
    await Promise.all([
      ok(api<{ checks: { id: string; level: string }[] }>('GET', '/admin/diagnostics')),
      ok(api<Record<string, unknown>>('GET', '/admin/settings')),
      ok(api<{ profiles: LdapProfile[] }>('GET', '/admin/ldap/profiles')),
      ok(
        api<{ items: { heads: unknown[]; vaults: number }[] }>(
          'GET',
          '/admin/departments?limit=200',
        ),
      ),
      ok(api<{ waiting: number; signedIn: number }>('GET', '/admin/people/summary')),
      ok(
        api<{ backups: { items: unknown[] } | null; schedule?: { enabled: boolean } | null }>(
          'GET',
          '/admin/backups',
        ),
      ),
      ok(api<{ offsite: { configured: boolean } | null }>('GET', '/admin/backups/offsite')),
      ok(
        api<{ recipient: unknown; vaults: { enrolled: boolean }[] }>(
          'GET',
          '/admin/corporate-recovery',
        ),
      ),
      // для входа по приглашениям: сколько действующих учётных записей (кроме своей) и приглашений
      ok(api<{ total: number }>('GET', '/admin/people?limit=1&status=active')),
      ok(api<{ status: string }[]>('GET', '/admin/invitations')),
    ]);
  const good = (id: string) => diag?.checks.find((c) => c.id === id)?.level === 'ok';
  const p = ldap?.profiles?.[0];
  const chosen = settings?.['setup.signIn'];
  // подключение каталога уже есть — значит, выбор сделан, даже если его не отмечали
  const signIn: SignIn =
    chosen === 'directory' || chosen === 'local' ? chosen : p ? 'directory' : null;
  const deptList = depts?.items ?? [];
  // сводка по людям считает сотрудников каталога; при входе по приглашениям — приглашения и действующие учётные записи
  const waiting =
    signIn === 'directory'
      ? (people?.waiting ?? 0)
      : (invites ?? []).filter((i) => i.status === 'pending').length;
  const signedIn =
    signIn === 'directory' ? (people?.signedIn ?? 0) : Math.max(0, (active?.total ?? 1) - 1);
  const copies = backups?.backups?.items.length ?? 0;
  const enrolled = recovery?.vaults.filter((v) => v.enrolled).length ?? 0;

  const steps: SetupStep[] = [
    {
      id: 'url',
      group: 'server',
      kind: 'required',
      done: good('public-url'),
      to: '/admin/settings?section=network',
    },
    { id: 'mail', group: 'server', kind: 'recommended', done: good('smtp'), to: '/admin/smtp' },
    { id: 'signIn', group: 'signin', kind: 'required', done: signIn !== null, to: '' },
  ];
  if (signIn === 'directory')
    steps.push(
      {
        id: 'connect',
        group: 'signin',
        kind: 'required',
        done: !!p?.status.connection?.ok,
        to: '/admin/ldap#connection',
      },
      {
        id: 'login',
        group: 'signin',
        kind: 'recommended',
        done: !!p?.status.login?.ok,
        to: '/admin/ldap#login-check',
      },
      {
        id: 'access',
        group: 'signin',
        kind: 'required',
        done: !!p?.enabled && !!p.access,
        to: '/admin/ldap#access',
      },
      {
        id: 'keys',
        group: 'signin',
        kind: 'optional',
        done: null,
        to: '/admin/keys',
        params: { mode: settings?.['security.keyMode'] === 'managed' ? 'managed' : 'strict' },
      },
    );
  steps.push({
    id: 'departments',
    group: 'structure',
    kind: 'required',
    done: deptList.length > 0 && deptList.every((d) => d.heads.length > 0 && d.vaults > 0),
    to: '/admin/departments',
    parts: [
      { id: 'deptCreated', done: deptList.length > 0 },
      { id: 'deptHeads', done: deptList.length > 0 && deptList.every((d) => d.heads.length > 0) },
      { id: 'deptVaults', done: deptList.length > 0 && deptList.every((d) => d.vaults > 0) },
    ],
  });
  if (signIn === 'directory')
    steps.push({
      id: 'groups',
      group: 'structure',
      kind: 'recommended',
      done: (p?.groups.length ?? 0) > 0,
      to: '/admin/circles',
    });
  steps.push(
    signIn === 'directory'
      ? {
          id: 'peopleDirectory',
          group: 'structure',
          kind: 'required',
          done: signedIn > 0,
          to: '/admin/users',
          params: { waiting, signedIn },
        }
      : {
          id: 'peopleLocal',
          group: 'structure',
          kind: 'required',
          done: waiting + signedIn > 0,
          to: '/admin/invitations',
          params: { waiting, signedIn },
        },
    {
      id: 'mfa',
      group: 'protection',
      kind: 'required',
      done: good('mfa-policy'),
      to: '/admin/settings?section=security',
    },
    {
      id: 'backup',
      group: 'protection',
      kind: 'required',
      done: copies > 0 && !!backups?.schedule?.enabled,
      to: '/admin/backups',
      parts: [
        { id: 'backupFirst', done: copies > 0 },
        { id: 'backupSchedule', done: !!backups?.schedule?.enabled },
        { id: 'backupOffsite', done: !!offsite?.offsite?.configured, optional: true },
      ],
    },
    {
      id: 'recovery',
      group: 'protection',
      kind: 'recommended',
      done:
        !!recovery?.recipient && !!recovery.vaults.length && enrolled === recovery.vaults.length,
      to: '/admin/settings?section=security',
      parts: [
        { id: 'recRecipient', done: !!recovery?.recipient },
        {
          id: 'recVaults',
          done: !!recovery?.vaults.length && enrolled === recovery.vaults.length,
          params: { n: enrolled, m: recovery?.vaults.length ?? 0 },
        },
      ],
    },
  );
  const counted = steps.filter((s) => s.kind !== 'optional');
  return {
    signIn,
    steps,
    current: steps.find((s) => s.kind === 'required' && s.done === false) ?? null,
    done: counted.filter((s) => s.done).length,
    total: counted.length,
  };
}
