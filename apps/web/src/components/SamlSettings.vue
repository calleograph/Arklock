<script setup lang="ts">
import SwitchField from './SwitchField.vue';
import UnsavedHint from './UnsavedHint.vue';
import { useDirty } from '../services/dirty';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, day } from '../services/helpers';

const { t } = useI18n();

interface CertInfo {
  subject: string;
  notAfter: string;
  fingerprint256: string;
  keyType: string;
  keyBits: number | null;
  daysLeft: number;
  state: 'valid' | 'expiring' | 'expired' | 'not_yet_valid' | 'weak_key';
}
interface Check {
  id: string;
  level: 'ok' | 'warn' | 'error';
  message: string;
}

const NAMEID = {
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
};

const form = ref({
  enabled: false,
  idpEntityId: '',
  entryPoint: '',
  logoutUrl: '',
  idpCerts: '',
  spEntityId: '',
  nameIdFormat: NAMEID.unspecified,
  signRequests: false,
  wantAssertionsSigned: true,
  wantResponseSigned: false,
  allowSha1: false,
  allowIdpInitiated: false,
  forceAuthn: false,
  clockSkewSeconds: 120,
  idAttr: '',
  emailAttr: 'email',
  nameAttr: 'displayName',
  groupsAttr: '',
  groups: [] as { name: string; circleId: string }[],
  requiredGroups: '',
  autoProvision: true,
  buttonText: 'SSO',
  domains: '',
  maxSessionHours: 0,
  allowInsecure: false,
});
const urls = ref<{ entityId: string; acs: string; metadata: string; slo: string } | null>(null);
const idpCertInfo = ref<(CertInfo | null)[]>([]);
const spCertInfo = ref<CertInfo | null>(null);
const hasSpKey = ref(false);
const circles = ref<{ id: string; name: string }[]>([]);
const metaXml = ref('');
const metaUrl = ref('');
const checks = ref<Check[]>([]);
const error = ref('');
const notice = ref('');
const busy = ref(false);

const certClass = (s: CertInfo['state']) =>
  s === 'valid' ? 'text-emerald-600' : s === 'expiring' ? 'text-amber-600' : 'text-red-600';

async function load(): Promise<void> {
  circles.value = await api<{ id: string; name: string }[]>('GET', '/admin/circles').catch(
    () => [],
  );
  const r = await api<Record<string, unknown>>('GET', '/admin/saml');
  urls.value = (r.urls as typeof urls.value) ?? null;
  if (r.configured) {
    form.value = {
      enabled: r.enabled === true,
      idpEntityId: String(r.idpEntityId ?? ''),
      entryPoint: String(r.entryPoint ?? ''),
      logoutUrl: String(r.logoutUrl ?? ''),
      idpCerts: ((r.idpCerts as string[]) ?? []).join('\n'),
      spEntityId: String(r.spEntityId ?? ''),
      nameIdFormat: String(r.nameIdFormat ?? NAMEID.unspecified),
      signRequests: r.signRequests === true,
      wantAssertionsSigned: r.wantAssertionsSigned !== false,
      wantResponseSigned: r.wantResponseSigned === true,
      allowSha1: r.allowSha1 === true,
      allowIdpInitiated: r.allowIdpInitiated === true,
      forceAuthn: r.forceAuthn === true,
      clockSkewSeconds: Number(r.clockSkewSeconds ?? 120),
      idAttr: String(r.idAttr ?? ''),
      emailAttr: String(r.emailAttr ?? 'email'),
      nameAttr: String(r.nameAttr ?? 'displayName'),
      groupsAttr: String(r.groupsAttr ?? ''),
      groups: ((r.groups as { name: string; circleId: string }[]) ?? []).map((g) => ({ ...g })),
      requiredGroups: ((r.requiredGroups as string[]) ?? []).join(', '),
      autoProvision: r.autoProvision !== false,
      buttonText: String(r.buttonText ?? 'SSO'),
      domains: ((r.allowedDomains as string[]) ?? []).join(', '),
      maxSessionHours: Number(r.maxSessionHours ?? 0),
      allowInsecure: r.allowInsecure === true,
    };
    idpCertInfo.value = (r.idpCertInfo as typeof idpCertInfo.value) ?? [];
    spCertInfo.value = (r.spCertInfo as CertInfo | null) ?? null;
    hasSpKey.value = r.hasSpKey === true;
  }
}
const { dirty, clean } = useDirty(() => form.value);
onMounted(() =>
  load()
    .then(clean)
    .catch((e) => (error.value = errorMessage(e, t))),
);

async function wrap(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const save = () =>
  wrap(async () => {
    const f = form.value;
    await api('PUT', '/admin/saml', {
      enabled: f.enabled,
      idpEntityId: f.idpEntityId,
      entryPoint: f.entryPoint,
      logoutUrl: f.logoutUrl,
      idpCerts: f.idpCerts,
      spEntityId: f.spEntityId,
      nameIdFormat: f.nameIdFormat,
      signRequests: f.signRequests,
      wantAssertionsSigned: f.wantAssertionsSigned,
      wantResponseSigned: f.wantResponseSigned,
      allowSha1: f.allowSha1,
      allowIdpInitiated: f.allowIdpInitiated,
      forceAuthn: f.forceAuthn,
      clockSkewSeconds: Number(f.clockSkewSeconds),
      idAttr: f.idAttr,
      emailAttr: f.emailAttr,
      nameAttr: f.nameAttr,
      groupsAttr: f.groupsAttr,
      groups: f.groups.filter((g) => g.name.trim()),
      requiredGroups: list(f.requiredGroups),
      autoProvision: f.autoProvision,
      buttonText: f.buttonText,
      allowedDomains: list(f.domains),
      maxSessionHours: Number(f.maxSessionHours),
      allowInsecure: f.allowInsecure,
    });
    notice.value = t('admin.saved');
    clean();
    await load();
  });

const importMeta = () =>
  wrap(async () => {
    const r = await api<{
      entityId: string;
      ssoUrl: string;
      logoutUrl: string;
      certs: string[];
      nameIdFormats: string[];
      warnings: string[];
    }>('POST', '/admin/saml/import-metadata', {
      ...(metaXml.value.trim() ? { xml: metaXml.value } : { url: metaUrl.value }),
      allowInsecure: form.value.allowInsecure,
    });
    form.value.idpEntityId = r.entityId;
    form.value.entryPoint = r.ssoUrl;
    form.value.logoutUrl = r.logoutUrl;
    form.value.idpCerts = r.certs.join('\n');
    const known = Object.values(NAMEID).find((f) => r.nameIdFormats.includes(f));
    if (known) form.value.nameIdFormat = known;
    notice.value = [t('saml.imported'), ...r.warnings].join(' · ');
  });

const makeSpCert = () =>
  wrap(async () => {
    await api('POST', '/admin/saml/sp-cert');
    notice.value = t('saml.spCertDone');
    await load();
  });

const runTest = () =>
  wrap(async () => {
    checks.value = (await api<{ checks: Check[] }>('POST', '/admin/saml/test')).checks;
  });

const hasCircles = computed(() => circles.value.length > 0);
const addGroup = () => form.value.groups.push({ name: '', circleId: circles.value[0]!.id });
</script>

<template>
  <div class="space-y-4" data-testid="saml-settings">
    <p class="text-sm text-slate-500">{{ t('saml.hint') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="saml-admin-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
      data-testid="saml-notice"
    >
      {{ notice }}
    </p>

    <div class="card max-w-3xl space-y-2 p-4 text-sm">
      <div class="font-medium">{{ t('saml.spData') }}</div>
      <template v-if="urls">
        <div class="text-xs text-slate-500">{{ t('saml.spEntity') }}</div>
        <code class="break-all" data-testid="saml-entity">{{ urls.entityId }}</code>
        <div class="text-xs text-slate-500">{{ t('saml.acs') }}</div>
        <code class="break-all" data-testid="saml-acs">{{ urls.acs }}</code>
        <div class="text-xs text-slate-500">{{ t('saml.slo') }}</div>
        <code class="break-all">{{ urls.slo }}</code>
        <div class="text-xs text-slate-500">{{ t('saml.metadata') }}</div>
        <a :href="urls.metadata" target="_blank" rel="noopener" class="break-all underline">{{
          urls.metadata
        }}</a>
      </template>
      <p v-else class="text-amber-700">{{ t('sso.redirectMissing') }}</p>
    </div>

    <div class="card max-w-3xl space-y-2 p-4 text-sm">
      <div class="font-medium">{{ t('saml.importTitle') }}</div>
      <textarea
        v-model="metaXml"
        rows="4"
        class="input font-mono text-xs"
        :placeholder="t('saml.metaXml')"
        data-testid="saml-meta-xml"
      />
      <input
        v-model="metaUrl"
        class="input"
        :placeholder="t('saml.metaUrl')"
        data-testid="saml-meta-url"
      />
      <button
        type="button"
        class="btn"
        :disabled="busy || (!metaXml.trim() && !metaUrl.trim())"
        data-testid="saml-import"
        @click="importMeta"
      >
        {{ t('saml.import') }}
      </button>
    </div>

    <form class="card max-w-3xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <SwitchField v-model="form.enabled" data-testid="saml-enabled" :label="t('saml.enabled')" />
      <label class="block"
        >{{ t('saml.idpEntity')
        }}<input v-model="form.idpEntityId" class="input font-mono" data-testid="saml-idp-entity"
      /></label>
      <label class="block"
        >{{ t('saml.entryPoint')
        }}<input v-model="form.entryPoint" class="input font-mono" data-testid="saml-entry-point"
      /></label>
      <label class="block"
        >{{ t('saml.logoutUrl') }}<input v-model="form.logoutUrl" class="input font-mono"
      /></label>
      <label class="block"
        >{{ t('saml.certs') }}
        <textarea
          v-model="form.idpCerts"
          rows="6"
          class="input font-mono text-xs"
          placeholder="-----BEGIN CERTIFICATE-----"
          data-testid="saml-certs"
        />
      </label>
      <ul v-if="idpCertInfo.length" class="space-y-1 text-xs" data-testid="saml-cert-info">
        <li v-for="(c, i) in idpCertInfo" :key="i">
          <template v-if="c">
            <span :class="certClass(c.state)" class="font-medium">{{
              t(`saml.cert.${c.state}`)
            }}</span>
            · {{ c.subject }} · {{ c.keyType.toUpperCase()
            }}{{ c.keyBits ? ` ${c.keyBits}` : '' }} · {{ t('saml.until') }}
            {{ day(c.notAfter) }} ({{ c.daysLeft }} {{ t('saml.days') }})
            <div class="break-all font-mono text-slate-500">SHA-256 {{ c.fingerprint256 }}</div>
          </template>
          <span v-else class="text-red-600">{{ t('saml.cert.invalid') }}</span>
        </li>
      </ul>

      <div class="flex flex-wrap gap-3">
        <label class="flex-1"
          >{{ t('saml.nameIdFormat') }}
          <select v-model="form.nameIdFormat" class="input">
            <option v-for="(v, k) in NAMEID" :key="k" :value="v">{{ k }}</option>
          </select>
        </label>
        <label class="flex-1"
          >{{ t('saml.skew')
          }}<input
            v-model.number="form.clockSkewSeconds"
            type="number"
            min="0"
            max="600"
            class="input"
        /></label>
      </div>

      <fieldset class="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <legend class="px-1 text-xs text-slate-500">{{ t('saml.mapping') }}</legend>
        <div class="flex flex-wrap gap-3">
          <label class="flex-1"
            >{{ t('saml.emailAttr')
            }}<input v-model="form.emailAttr" class="input" data-testid="saml-email-attr"
          /></label>
          <label class="flex-1"
            >{{ t('saml.nameAttr') }}<input v-model="form.nameAttr" class="input"
          /></label>
          <label class="flex-1"
            >{{ t('saml.idAttr') }}<input v-model="form.idAttr" class="input" placeholder="NameID"
          /></label>
          <label class="flex-1"
            >{{ t('saml.groupsAttr')
            }}<input v-model="form.groupsAttr" class="input" data-testid="saml-groups-attr"
          /></label>
        </div>
        <div class="font-medium">{{ t('saml.groups') }}</div>
        <div v-for="(g, i) in form.groups" :key="i" class="flex gap-2">
          <input
            v-model="g.name"
            class="input flex-1"
            :placeholder="t('saml.groupName')"
            :data-testid="`saml-group-${i}`"
          />
          <select v-model="g.circleId" class="input w-48">
            <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button type="button" class="btn" @click="form.groups.splice(i, 1)">✕</button>
        </div>
        <button
          type="button"
          class="btn"
          :disabled="!hasCircles"
          data-testid="saml-add-group"
          @click="addGroup"
        >
          {{ t('saml.addGroup') }}
        </button>
        <label class="block"
          >{{ t('saml.requiredGroups')
          }}<input v-model="form.requiredGroups" class="input" data-testid="saml-required-groups"
        /></label>
      </fieldset>

      <label class="block"
        >{{ t('sso.domains') }}<input v-model="form.domains" class="input"
      /></label>
      <label class="block"
        >{{ t('sso.button') }}<input v-model="form.buttonText" class="input"
      /></label>
      <label class="block"
        >{{ t('saml.maxSession')
        }}<input v-model.number="form.maxSessionHours" type="number" min="0" class="input"
      /></label>

      <fieldset class="space-y-1 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <legend class="px-1 text-xs text-slate-500">{{ t('saml.security') }}</legend>
        <SwitchField v-model="form.wantAssertionsSigned" :label="t('saml.wantAssertionsSigned')" />
        <SwitchField v-model="form.wantResponseSigned" :label="t('saml.wantResponseSigned')" />
        <SwitchField
          v-model="form.signRequests"
          :disabled="!hasSpKey"
          :label="t('saml.signRequests')"
        />
        <SwitchField v-model="form.forceAuthn" :label="t('saml.forceAuthn')" />
        <SwitchField v-model="form.allowIdpInitiated" :label="t('saml.allowIdpInitiated')" />
        <SwitchField v-model="form.allowSha1" :label="t('saml.allowSha1')" />
        <SwitchField v-model="form.autoProvision" :label="t('sso.autoProvision')" />
        <SwitchField
          v-model="form.allowInsecure"
          data-testid="saml-insecure"
          :label="t('sso.allowInsecure')"
        />
      </fieldset>

      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="saml-save">
          {{ t('common.save') }}
        </button>
        <UnsavedHint :dirty="dirty" />
        <button type="button" class="btn" :disabled="busy" data-testid="saml-test" @click="runTest">
          {{ t('saml.test') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="saml-sp-cert"
          @click="makeSpCert"
        >
          {{ hasSpKey ? t('saml.spCertRenew') : t('saml.spCertMake') }}
        </button>
      </div>
      <div v-if="spCertInfo" class="text-xs" data-testid="saml-sp-info">
        {{ t('saml.spCert') }}:
        <span :class="certClass(spCertInfo.state)">{{ t(`saml.cert.${spCertInfo.state}`) }}</span>
        · {{ t('saml.until') }} {{ day(spCertInfo.notAfter) }}
      </div>

      <ul v-if="checks.length" class="space-y-1" data-testid="saml-checks">
        <li v-for="(c, i) in checks" :key="i" :data-level="c.level">
          <span
            :class="
              c.level === 'ok'
                ? 'text-emerald-600'
                : c.level === 'warn'
                  ? 'text-amber-600'
                  : 'text-red-600'
            "
            >{{ c.level === 'ok' ? '✔' : c.level === 'warn' ? '!' : '✘' }}</span
          >
          {{ t(`saml.check.${c.id}`) }}: {{ c.message }}
        </li>
      </ul>
    </form>
  </div>
</template>
