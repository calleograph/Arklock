import { inArray } from 'drizzle-orm';
import { audit } from './audit.js';
import type { AppContext } from './context.js';
import { settings } from './db/schema.js';

/**
 * Автоматические проверки и обновление. Проверка новой версии — каждые 30 минут (по умолчанию включена).
 * Установка — только по явному согласию администратора, раз в сутки в заданное время по часовому поясу сервера и только
 * стабильной версии. Саму установку (контрольная копия, миграции, проверка после, откат) выполняет помощник.
 */
export const AUTO_CHECK_KEY = 'updates.autoCheck';
export const AUTO_INSTALL_KEY = 'updates.autoInstall';
export const AUTO_AT_KEY = 'updates.autoInstallAt';
export const AUTO_LAST_KEY = 'updates.autoLastDay';
/** Помощник принимает в `by` только UUID: плановые действия идут от нулевого идентификатора. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
export const CHECK_EVERY_MS = 30 * 60_000;
const STABLE = /^v?\d+\.\d+\.\d+$/;

export interface AutoPolicy {
  check: boolean;
  install: boolean;
  at: string;
  lastDay: string | null;
}

export async function autoPolicy(db: AppContext['db']): Promise<AutoPolicy> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [AUTO_CHECK_KEY, AUTO_INSTALL_KEY, AUTO_AT_KEY, AUTO_LAST_KEY]));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    check: v(AUTO_CHECK_KEY) !== false,
    install: v(AUTO_INSTALL_KEY) === true,
    at: typeof v(AUTO_AT_KEY) === 'string' ? (v(AUTO_AT_KEY) as string) : '00:00',
    lastDay: typeof v(AUTO_LAST_KEY) === 'string' ? (v(AUTO_LAST_KEY) as string) : null,
  };
}

/** Календарный день и минуты суток по местному времени сервера. */
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutes = (hhmm: string) => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Один шаг планировщика (раз в минуту). Возвращает, что сделано: для журнала и тестов. */
export async function autoUpdateTick(
  ctx: AppContext,
  now = new Date(),
): Promise<'idle' | 'check' | 'update'> {
  if (!ctx.updater.configured) return 'idle';
  const policy = await autoPolicy(ctx.db);
  if (!policy.check && !policy.install) return 'idle';
  const current = await ctx.updater.overview({
    version: ctx.config.APP_VERSION,
    commit: ctx.config.APP_GIT_COMMIT,
    builtAt: ctx.config.APP_BUILT_AT,
    channel: ctx.config.UPDATE_CHANNEL,
  });
  if (!current.helper.alive || current.pending || current.status.state === 'running') return 'idle';

  const remote = current.remote;
  const checkedAt = remote?.checkedAt ? Date.parse(remote.checkedAt) : 0;
  if (policy.check && now.getTime() - checkedAt >= CHECK_EVERY_MS) {
    await ctx.updater.submit({ action: 'check', by: SYSTEM_ACTOR });
    return 'check';
  }

  const today = localDay(now);
  const due =
    policy.install &&
    policy.lastDay !== today &&
    now.getHours() * 60 + now.getMinutes() >= minutes(policy.at);
  if (due && remote?.status === 'available' && remote.latest && STABLE.test(remote.latest)) {
    // день отмечается до запуска: сбой не приводит к повторным попыткам в тот же день
    await ctx.db
      .insert(settings)
      .values({ key: AUTO_LAST_KEY, value: today, updatedBy: 'system' })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: today, updatedAt: new Date(), updatedBy: 'system' },
      });
    const id = await ctx.updater.submit({
      action: 'update',
      version: remote.latest,
      by: SYSTEM_ACTOR,
    });
    await audit(ctx.db, 'system', 'admin.updates.auto', `request:${id}`, {
      version: remote.latest,
    });
    return 'update';
  }
  return 'idle';
}

export const autoSettingKeys = [AUTO_CHECK_KEY, AUTO_INSTALL_KEY, AUTO_AT_KEY];
