import { shieldPolicy, type ShieldPolicy } from './policy.js';

/**
 * Проверка параметров защиты входа до применения и описание того, что они значат. Ничего не сохраняет и не меняет
 * счётчики: только разбирает кандидата и сообщает ошибки (применить нельзя), предупреждения (применить можно после
 * подтверждения администратором) и итоговое поведение простыми числами.
 */
export interface PolicyError {
  field: string;
  code: 'out_of_range' | 'not_integer' | 'required' | 'inconsistent' | 'block_over_max' | 'unknown';
}
export interface PolicyWarning {
  code: string;
  data?: Record<string, number | string>;
}
export interface PolicySummary {
  windowMinutes: number;
  captchaAfter: number;
  blockPairAfter: number;
  blockIpAfter: number;
  /** Сроки блокировки при повторных нарушениях: первый, удвоенный и далее до предела (минут). */
  blockSteps: number[];
  blockMaxMinutes: number;
  bits: { start: number; max: number };
  /** Ориентировочное время подбора в браузере, секунд (быстрый компьютер / медленный телефон). Не измерение. */
  solveSeconds: { fast: number; slow: number; maxFast: number; maxSlow: number };
  /** Методы входа, на которые распространяется политика. */
  covered: string[];
  /** Что действует всегда, независимо от этой политики. */
  alwaysOn: { authRatePerMinute: number };
  /** Проверка использует только сервер и браузер: внешних служб нет. */
  externalService: false;
}
export interface PolicyCheck {
  ok: boolean;
  errors: PolicyError[];
  warnings: PolicyWarning[];
  /** Что будет сохранено, если применить (с учётом автоматических поправок). */
  effective: ShieldPolicy | null;
  summary: PolicySummary | null;
}
export interface PolicyEnv {
  /** Сколько прокси доверяет приложение и пришёл ли текущий запрос через прокси (заголовок X-Forwarded-For). */
  hops: number;
  forwarded: boolean;
  authRatePerMinute: number;
}

// ориентиры скорости подбора SHA-256 в браузере: ~150 тыс. хешей/с на компьютере, ~25 тыс./с на слабом телефоне
const FAST = 150_000;
const SLOW = 25_000;
const seconds = (bits: number, rate: number) => Math.round((2 ** bits / rate) * 10) / 10;

export function describePolicy(
  p: ShieldPolicy,
  env: Pick<PolicyEnv, 'authRatePerMinute'>,
): PolicySummary {
  const blockSteps: number[] = [];
  for (let m = p.blockMinutes; blockSteps.length < 8; m *= 2) {
    blockSteps.push(Math.min(m, p.blockMaxMinutes));
    if (m >= p.blockMaxMinutes) break;
  }
  return {
    windowMinutes: p.windowMinutes,
    captchaAfter: p.captchaAfter,
    blockPairAfter: p.blockPairAfter,
    blockIpAfter: p.blockIpAfter,
    blockSteps,
    blockMaxMinutes: p.blockMaxMinutes,
    bits: { start: p.captchaBits, max: p.captchaMaxBits },
    solveSeconds: {
      fast: seconds(p.captchaBits, FAST),
      slow: seconds(p.captchaBits, SLOW),
      maxFast: seconds(p.captchaMaxBits, FAST),
      maxSlow: seconds(p.captchaMaxBits, SLOW),
    },
    covered: ['login', 'recovery', 'directory'],
    alwaysOn: { authRatePerMinute: env.authRatePerMinute },
    externalService: false,
  };
}

export function checkPolicy(candidate: unknown, before: ShieldPolicy, env: PolicyEnv): PolicyCheck {
  const errors: PolicyError[] = [];
  const warnings: PolicyWarning[] = [];
  const parsed = shieldPolicy.safeParse({
    ...before,
    ...(candidate && typeof candidate === 'object' ? candidate : {}),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? '');
      const code: PolicyError['code'] =
        issue.code === 'too_small' || issue.code === 'too_big'
          ? 'out_of_range'
          : issue.code === 'invalid_type'
            ? (issue as { expected?: string }).expected === 'int'
              ? 'not_integer'
              : 'required'
            : /int/.test(issue.message)
              ? 'not_integer'
              : 'unknown';
      if (!errors.some((e) => e.field === field)) errors.push({ field, code });
    }
    return { ok: false, errors, warnings, effective: null, summary: null };
  }
  const next = parsed.data;
  if (next.blockMinutes > next.blockMaxMinutes)
    errors.push({ field: 'blockMinutes', code: 'block_over_max' });
  // то же правило, что применяет сервер при сохранении
  if (next.captchaAfter >= next.blockPairAfter + next.blockIpAfter)
    errors.push({ field: 'captchaAfter', code: 'inconsistent' });
  if (errors.length) return { ok: false, errors, warnings, effective: null, summary: null };

  const effective = { ...next };
  if (effective.captchaMaxBits < effective.captchaBits) {
    effective.captchaMaxBits = effective.captchaBits;
    warnings.push({ code: 'max_bits_raised', data: { bits: effective.captchaBits } });
  }
  // риск массовой блокировки: источник — адрес, а за одним адресом часто целый офис или прокси
  if (env.hops === 0 && env.forwarded) warnings.push({ code: 'proxy_not_trusted' });
  if (effective.blockIpAfter < 15)
    warnings.push({ code: 'ip_threshold_low', data: { n: effective.blockIpAfter } });
  if (effective.blockPairAfter <= 3)
    warnings.push({ code: 'pair_threshold_low', data: { n: effective.blockPairAfter } });
  if (effective.captchaAfter <= 2) warnings.push({ code: 'captcha_every_typo' });
  if (effective.captchaAfter >= effective.blockPairAfter)
    warnings.push({
      code: 'captcha_after_pair_block',
      data: { captcha: effective.captchaAfter, pair: effective.blockPairAfter },
    });
  if (effective.blockMinutes >= 60)
    warnings.push({ code: 'long_block', data: { minutes: effective.blockMinutes } });
  if (effective.windowMinutes > 120 && effective.blockIpAfter < 50)
    warnings.push({ code: 'long_window', data: { minutes: effective.windowMinutes } });
  if (effective.captchaMaxBits >= 21)
    warnings.push({
      code: 'slow_on_phones',
      data: { seconds: describePolicy(effective, env).solveSeconds.maxSlow },
    });
  const weakens =
    effective.captchaAfter > before.captchaAfter ||
    effective.blockIpAfter > before.blockIpAfter ||
    effective.blockPairAfter > before.blockPairAfter ||
    effective.blockMinutes < before.blockMinutes;
  if (weakens) warnings.push({ code: 'weaker_than_current' });
  return { ok: true, errors, warnings, effective, summary: describePolicy(effective, env) };
}
