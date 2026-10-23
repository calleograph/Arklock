/**
 * Полномочия. Роли (встроенные и пользовательские) — наборы разрешений и явных запретов; запрет сильнее разрешения.
 * Все проверки выполняются на сервере по эффективному набору полномочий пользователя.
 */
export const VAULT_PERMS = [
  'entry.read',
  'entry.history',
  'entry.create',
  'entry.update',
  'entry.delete',
  'attachment.read',
  'attachment.write',
  'branch.manage',
  'trash.purge',
  'grant.manage',
  'members.manage',
  'vault.settings',
  'vault.rotate',
  'vault.delete',
  'vault.signals',
] as const;
export type VaultPerm = (typeof VAULT_PERMS)[number];

/** Административные полномочия (делегирование отдельных разделов панели без полного доступа). */
export const ADMIN_PERMS = [
  'admin.users',
  'admin.circles',
  'admin.settings',
  'admin.ledger',
  'admin.system',
  'admin.backups',
  'admin.updates',
  'admin.integrations',
  'admin.invitations',
  'admin.roles',
] as const;
export type AdminPerm = (typeof ADMIN_PERMS)[number];

export type Perm = VaultPerm | AdminPerm;
export const ALL_PERMS: readonly string[] = [...VAULT_PERMS, ...ADMIN_PERMS];

const reader: VaultPerm[] = ['entry.read', 'entry.history', 'attachment.read', 'vault.signals'];
const editor: VaultPerm[] = [
  ...reader,
  'entry.create',
  'entry.update',
  'entry.delete',
  'attachment.write',
  'branch.manage',
  'trash.purge',
];
const admin: VaultPerm[] = [
  ...editor,
  'grant.manage',
  'members.manage',
  'vault.settings',
  'vault.rotate',
];

/** Встроенные роли хранилища как наборы полномочий. */
export const BUILTIN_VAULT_ROLES: Record<string, readonly VaultPerm[]> = {
  owner: [...admin, 'vault.delete'],
  admin,
  editor,
  reader,
  limited: [],
};

export interface RoleDef {
  id: string;
  scope: 'vault' | 'admin';
  allow: string[];
  deny: string[];
  parents: string[];
}

/** Разворачивает роль с наследованием от родителей (с защитой от циклов и чрезмерной глубины). */
export function expandRole(
  roles: Map<string, RoleDef>,
  id: string,
  seen = new Set<string>(),
  depth = 0,
): { allow: Set<string>; deny: Set<string> } {
  const allow = new Set<string>();
  const deny = new Set<string>();
  const r = roles.get(id);
  if (!r || seen.has(id) || depth > 8) return { allow, deny };
  seen.add(id);
  for (const p of r.parents) {
    const e = expandRole(roles, p, seen, depth + 1);
    e.allow.forEach((x) => allow.add(x));
    e.deny.forEach((x) => deny.add(x));
  }
  r.allow.forEach((x) => allow.add(x));
  r.deny.forEach((x) => deny.add(x));
  return { allow, deny };
}

/** Эффективные полномочия: объединение разрешений всех назначений минус объединение запретов. */
export function effective(
  parts: { allow: Iterable<string>; deny: Iterable<string> }[],
): Set<string> {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const p of parts) {
    for (const a of p.allow) allow.add(a);
    for (const d of p.deny) deny.add(d);
  }
  for (const d of deny) allow.delete(d);
  return allow;
}

/** Для каких путей административного API требуется какое полномочие (первое совпадение). */
export const ADMIN_PATHS: [RegExp, AdminPerm][] = [
  [/^\/api\/v1\/admin\/continuity$/, 'admin.system'],
  [/^\/api\/v1\/admin\/corporate-recovery(\/|$)/, 'admin.system'],
  [/^\/api\/v1\/admin\/roles(\/|$)/, 'admin.roles'],
  [/^\/api\/v1\/admin\/users\/[^/]+\/mfa-reset$/, 'admin.users'],
  [/^\/api\/v1\/admin\/users(\/|$)/, 'admin.users'],
  [/^\/api\/v1\/admin\/circles(\/|$)/, 'admin.circles'],
  [/^\/api\/v1\/admin\/(settings|security\/range)(\/|$)/, 'admin.settings'],
  [/^\/api\/v1\/admin\/ledger(\/|$)/, 'admin.ledger'],
  [
    /^\/api\/v1\/admin\/(overview|resources|containers|storage|diagnostics|certificates|logs)(\/|$)/,
    'admin.system',
  ],
  [/^\/api\/v1\/admin\/backups(\/|$)/, 'admin.backups'],
  [/^\/api\/v1\/admin\/(updates|reauth)(\/|$)/, 'admin.updates'],
  [/^\/api\/v1\/admin\/network(\/|$)/, 'admin.settings'],
  [/^\/api\/v1\/admin\/(ldap|sso|saml|smtp|syslog|webhooks)(\/|$)/, 'admin.integrations'],
  [/^\/api\/v1\/admin\/invitations(\/|$)/, 'admin.invitations'],
];

export const adminPermFor = (path: string): AdminPerm | null =>
  ADMIN_PATHS.find(([re]) => re.test(path))?.[1] ?? null;
