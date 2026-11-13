import { eq } from 'drizzle-orm';
import type { Db } from './db/connect.js';
import { roles, settings } from './db/schema.js';
import { ADMIN_PERMS, BUILTIN_VAULT_ROLES, VAULT_PERMS } from './perms.js';

/**
 * Готовые роли для типичных обязанностей: создаются один раз при первом запуске этой версии и дальше обычные пользовательские
 * роли (их можно изменить и удалить; удалённые заново не появляются). Встроенные роли сейфа (владелец, администратор,
 * редактор, читатель, ограниченный) существуют всегда и здесь не дублируются.
 */
export interface PresetRole {
  name: string;
  description: string;
  scope: 'vault' | 'admin';
  allow: string[];
}

const reader = BUILTIN_VAULT_ROLES.reader!;
const editor = BUILTIN_VAULT_ROLES.editor!;

export const PRESET_ROLES: PresetRole[] = [
  {
    name: 'Управление сотрудниками',
    description:
      'Заводит и приглашает сотрудников, управляет группами и составом. Подходит помощнику администратора или кадровой службе.',
    scope: 'admin',
    allow: ['admin.users', 'admin.circles', 'admin.invitations'],
  },
  {
    name: 'Просмотр журнала',
    description:
      'Видит журнал действий и события безопасности, ничего не меняет. Подходит специалисту по безопасности и внутреннему контролю.',
    scope: 'admin',
    allow: ['admin.ledger'],
  },
  {
    name: 'Администратор системы',
    description:
      'Следит за состоянием сервера, делает резервные копии и устанавливает обновления. Пользователей и настройки не меняет.',
    scope: 'admin',
    allow: ['admin.system', 'admin.backups', 'admin.updates'],
  },
  {
    name: 'Администратор интеграций',
    description: 'Подключает каталог пользователей (AD/LDAP), единый вход, почту и вебхуки.',
    scope: 'admin',
    allow: ['admin.integrations'],
  },
  {
    name: 'Администратор настроек',
    description: 'Меняет настройки организации: политики паролей, сроки, ограничения, оформление.',
    scope: 'admin',
    allow: ['admin.settings'],
  },
  {
    name: 'Куратор сейфа',
    description:
      'Работает с записями как редактор и управляет доступом: выдаёт права людям и группам. Настройки, смена ключа и удаление сейфа недоступны.',
    scope: 'vault',
    allow: [...editor, 'grant.manage', 'members.manage'],
  },
  {
    name: 'Редактор без удаления',
    description: 'Читает, добавляет и меняет записи и файлы, но не удаляет и не очищает корзину.',
    scope: 'vault',
    allow: [...reader, 'entry.create', 'entry.update', 'attachment.write'],
  },
  {
    name: 'Чтение без файлов',
    description: 'Видит записи и их историю, но не скачивает вложения и не меняет ничего.',
    scope: 'vault',
    allow: ['entry.read', 'entry.history'],
  },
];

const FLAG = 'roles.presetsSeeded';

/** Создаёт готовые роли один раз; повторный запуск ничего не делает. */
export async function seedPresetRoles(db: Db): Promise<number> {
  const [done] = await db.select().from(settings).where(eq(settings.key, FLAG));
  if (done) return 0;
  const known = new Set<string>([...VAULT_PERMS, ...ADMIN_PERMS]);
  let n = 0;
  for (const p of PRESET_ROLES) {
    const res = await db
      .insert(roles)
      .values({
        id: crypto.randomUUID(),
        name: p.name,
        description: p.description,
        scope: p.scope,
        allow: p.allow.filter((x) => known.has(x)),
        deny: [],
        parents: [],
      })
      .onConflictDoNothing()
      .returning({ id: roles.id });
    n += res.length;
  }
  await db.insert(settings).values({ key: FLAG, value: true }).onConflictDoNothing();
  return n;
}
