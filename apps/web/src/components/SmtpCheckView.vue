<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { when } from '../services/helpers';
import Icon from './Icon.vue';

/**
 * Результат проверки почтового соединения: итог одной строкой (что проверено, получилось ли, где остановилось и что
 * делать), этапы — в раскрывающемся блоке. Один вид для проверки сохранённого профиля и текущих значений формы.
 */
export interface SmtpStage {
  stage: string;
  ok: boolean;
  skipped?: boolean;
  warn?: boolean;
  code?: string;
  smtpStatus?: number;
  serverText?: string;
  info?: Record<string, string | number | boolean | string[]>;
}
export interface SmtpCheck {
  ok: boolean;
  code?: string;
  stage?: string | null;
  smtpStatus?: number | null;
  text?: string | null;
  stages: SmtpStage[];
}
const props = defineProps<{
  check: SmtpCheck;
  /** Что проверялось: сохранённый профиль или текущие значения формы. */
  source: 'saved' | 'draft';
  authNone: boolean;
  /** Можно ли предложить «Доверять этому сертификату» (только для сохранённого профиля). */
  canTrust?: boolean;
  /** Сколько доверенных центров сохранено на сервере: от этого зависит, что посоветовать при недоверенном сертификате. */
  casCount?: number;
  testid?: string;
}>();
const emit = defineEmits<{
  trust: [cert: { subject: string; fingerprint256: string }];
  'open-cas': [];
}>();
const { t, te } = useI18n();

const text = (s: unknown) => (typeof s === 'string' ? s : s == null ? '' : String(s));
function errInfo(
  code: string | null | undefined,
  reason?: unknown,
): { title: string; hint: string } {
  const key = te(`mail.err.${code ?? ''}.title`) ? `mail.err.${code}` : 'mail.err.error';
  const extra =
    typeof reason === 'string' && te(`mail.reason.${reason}`) ? t(`mail.reason.${reason}`) : '';
  return { title: t(`${key}.title`), hint: [extra, t(`${key}.hint`)].filter(Boolean).join('. ') };
}
function stageLine(s: SmtpStage): string {
  const i = s.info ?? {};
  if (s.skipped)
    return t(
      s.stage === 'auth'
        ? 'mail.detail.authSkipped'
        : s.stage === 'tls' || s.stage === 'certificate'
          ? 'mail.detail.notApplicable'
          : 'mail.detail.skipped',
    );
  switch (s.stage) {
    case 'dns':
      return t('mail.detail.dns', { addresses: text(i.addresses) });
    case 'tcp':
      return t('mail.detail.tcp', { address: text(i.address) });
    case 'greeting':
      return text(i.banner);
    case 'ehlo':
      return text(i.features);
    case 'tls':
      return t('mail.detail.tlsOk', { protocol: text(i.protocol) });
    case 'certificate':
      return s.ok
        ? [
            t(s.warn ? 'mail.detail.certUnverified' : 'mail.detail.certTrusted', {
              subject: text(i.subject),
              issuer: text(i.issuer),
              validTo: i.validTo ? when(text(i.validTo)).slice(0, 10) : '',
            }),
            // чем подтверждён: центром, сохранённым на сервере, или системным
            i.anchor ? t('mail.ca.anchorLine', { name: text(i.anchor) }) : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    case 'methods': {
      const list = (v: unknown) =>
        Array.isArray(v) && v.length ? v.join(', ') : t('mail.detail.methodsNone');
      return t('mail.detail.methods', { before: list(i.before), after: list(i.after) });
    }
    case 'auth':
      return s.ok ? t('mail.detail.authOk') : '';
    default:
      return '';
  }
}
const STAGE_ORDER = ['dns', 'tcp', 'greeting', 'ehlo', 'tls', 'certificate', 'methods', 'auth'];
/** Этапы по порядку; последний результат этапа; не дошедшие — «не выполнялось». */
function stageRows(c: SmtpCheck): { stage: string; s: SmtpStage | null }[] {
  const last = new Map<string, SmtpStage>();
  for (const s of c.stages) last.set(s.stage, s);
  return STAGE_ORDER.map((stage) => ({ stage, s: last.get(stage) ?? null }));
}
const failReason = (c: SmtpCheck): unknown =>
  c.stages.find((x) => !x.ok && x.info?.reason)?.info?.reason;
function certProbe(c: SmtpCheck): string {
  const i = c.stages.find((x) => x.stage === 'certificate' && !x.ok)?.info;
  if (!i?.subject) return '';
  return t('mail.detail.cert', {
    subject: text(i.subject),
    issuer: text(i.issuer),
    validTo: i.validTo ? when(text(i.validTo)).slice(0, 10) : '',
    fingerprint: text(i.fingerprint256),
  });
}
function presentedCert(c: SmtpCheck): { subject: string; fingerprint256: string } | null {
  const i = c.stages.find((x) => x.stage === 'certificate' && !x.ok)?.info;
  if (!i?.fingerprint256 || ['expired', 'not_yet_valid', 'revoked'].includes(text(i.reason)))
    return null;
  return { subject: text(i.subject), fingerprint256: text(i.fingerprint256) };
}
/** Недоверенный сертификат: нужен центр на сервере (корневой и промежуточные). Браузерного «принять» для сервера нет. */
const needsAuthority = (c: SmtpCheck) =>
  ['untrusted', 'self_signed'].includes(
    text(c.stages.find((x) => x.stage === 'certificate' && !x.ok)?.info?.reason),
  );
const failedStage = (c: SmtpCheck) => c.stages.find((x) => !x.ok)?.stage ?? c.stage ?? '';
void props;
</script>

<template>
  <div
    class="space-y-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50"
    :data-testid="testid"
    data-result
  >
    <p class="text-xs text-slate-500">
      {{ source === 'draft' ? t('mail.check.sourceDraft') : t('mail.check.sourceSaved') }}
    </p>
    <p v-if="check.ok" class="text-emerald-700 dark:text-emerald-300" data-testid="smtp-result">
      {{ authNone ? t('mail.result.okNoAuth') : t('mail.result.ok') }}
    </p>
    <div v-else class="space-y-1" data-testid="smtp-result">
      <p class="font-medium text-red-700 dark:text-red-300">
        <span v-if="failedStage(check)">{{ t(`mail.stage.${failedStage(check)}`) }}: </span
        >{{ errInfo(check.code, failReason(check)).title }}
      </p>
      <p>{{ errInfo(check.code, failReason(check)).hint }}</p>
      <p v-if="check.text" class="text-xs text-slate-500">
        {{ t('mail.result.server', { text: check.text }) }}
      </p>
      <p v-if="certProbe(check)" class="break-all text-xs text-slate-500">{{ certProbe(check) }}</p>
      <div v-if="needsAuthority(check)" class="space-y-1" data-testid="smtp-suggest-ca">
        <p class="text-xs">
          {{ (casCount ?? 0) > 0 ? t('mail.ca.suggestMore') : t('mail.ca.suggest') }}
        </p>
        <button
          type="button"
          class="btn"
          data-testid="smtp-suggest-ca-open"
          @click="emit('open-cas')"
        >
          {{ t('mail.ca.suggestOpen') }}
        </button>
      </div>
      <div
        v-if="canTrust && presentedCert(check)"
        class="flex flex-wrap items-center gap-2 pt-1"
        data-testid="smtp-trust"
      >
        <button type="button" class="btn" @click="emit('trust', presentedCert(check)!)">
          <Icon name="shield" class="size-4" />{{ t('mail.trust.button') }}
        </button>
        <span class="text-xs text-slate-500">{{ t('mail.trust.hint') }}</span>
      </div>
    </div>
    <details class="text-xs" data-testid="smtp-stages">
      <summary class="cursor-pointer text-slate-500">{{ t('mail.check.stages') }}</summary>
      <ol class="mt-1 space-y-1">
        <li
          v-for="r in stageRows(check)"
          :key="r.stage"
          class="flex items-start gap-2"
          :data-stage="r.stage"
        >
          <span class="mt-0.5 w-4 shrink-0 text-center" aria-hidden="true">{{
            !r.s ? '·' : r.s.skipped ? '–' : r.s.ok ? (r.s.warn ? '!' : '✓') : '✗'
          }}</span>
          <span class="w-32 shrink-0 font-medium">{{ t(`mail.stage.${r.stage}`) }}</span>
          <span class="min-w-0 break-words text-slate-600 dark:text-slate-300">
            <template v-if="!r.s">{{ t('mail.detail.notReached') }}</template>
            <template v-else-if="r.s.ok">{{ stageLine(r.s) }}</template>
            <strong v-else class="text-red-700 dark:text-red-300">{{
              errInfo(r.s.code, r.s.info?.reason).title
            }}</strong>
          </span>
        </li>
      </ol>
    </details>
  </div>
</template>
