import { ApiError } from './api';

/**
 * Шифрование в браузере требует защищённого контекста (HTTPS или localhost): без него Web Crypto API недоступен.
 * Проверяется заранее, чтобы показать причину, а не общую ошибку.
 */
export function hasWebCrypto(): boolean {
  return globalThis.isSecureContext === true && typeof globalThis.crypto?.subtle !== 'undefined';
}

type T = (key: string, named?: Record<string, unknown>) => string;

/** Понятное пользователю сообщение. Технические детали и тексты сервера не показываются. */
export function errorMessage(e: unknown, t: T): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'password_policy': {
        const policy = e.details as
          { minLength?: number; classes?: number; violations?: unknown } | undefined;
        if (!Array.isArray(policy?.violations)) return t('corporate.policyViolation');
        return (
          policy.violations
            .filter((v) => v === 'length' || v === 'classes')
            .map((v) => t(`policy.${v}`, { n: v === 'length' ? policy.minLength : policy.classes }))
            .join(' ') || t('corporate.policyViolation')
        );
      }
      case 'move_verification_failed':
        return t('corporate.moveVerificationFailed');
      case 'move_cleanup_failed':
        return t('corporate.moveCleanupFailed');
      case 'move_source_failed':
        return t('corporate.moveSourceFailed');
      case 'invalid_credentials':
        return t('auth.invalid');
      case 'too_many_attempts':
        return t('auth.locked');
      case 'registration_closed':
        return t('auth.closed');
      case 'invalid_setup_token':
        return t('auth.badSetupCode');
      case 'setup_disabled':
        return t('auth.setupDisabled');
      case 'already_exists':
        return t('auth.exists');
      case 'version_conflict':
        return t('vault.conflict');
      case 'mfa_admin_not_enrolled':
        return t('adminx.mfaAdminNotEnrolled');
      case 'mfa_required_by_policy':
        return t('mfa.requiredByPolicy');
      case 'attachment_too_large':
        return t('files.tooLarge');
      case 'quota_exceeded':
        return t('files.quota');
      case 'storage_unavailable':
        return t('files.disabled');
      case 'stale_key_version':
        return t('files.stale');
      case 'network_error':
        return t('error.network');
      case 'forbidden':
        return t('error.forbidden');
      case 'not_found':
        return t('error.notFound');
      case 'validation_error':
        return t('error.validation');
      case 'reauth_required':
        return t('error.reauth');
      case 'personal_lockers_disabled':
        return t('error.personalDisabled');
      case 'key_missing':
        return t('error.keyMissing');
      case 'invalid_pin':
        return t('error.pinWrong', {
          n: (e.details as { remaining?: number } | undefined)?.remaining ?? 0,
        });
      case 'pin_locked':
        return t('error.pinLocked');
      case 'pin_disabled':
        return t('error.pinDisabled');
      case 'pin_gone':
        return t('error.pinGone');
      case 'last_owner':
        return t('error.lastOwner');
      case 'space_not_empty':
        return t('error.spaceNotEmpty');
      case 'space_archived':
        return t('error.spaceArchived');
      case 'default_space_required':
        return t('error.defaultSpace');
      case 'self_disable':
        return t('error.selfDisable');
      case 'mail_queue_full':
        return t('error.mailQueueFull');
      case 'smtp_not_configured':
        return t('error.smtpNotConfigured');
      case 'ldap_not_configured':
        return t('error.ldapNotConfigured');
      case 'ldap_unavailable':
        return t('ldap.unavailable');
      case 'public_url_required':
        return t('error.publicUrl');
      case 'not_in_trash':
        return t('error.notInTrash');
      case 'conflict':
        return t('vault.conflict');
      case 'update_in_progress':
        return t('updates.errBusy');
      case 'updater_unavailable':
        return t('updates.errHelper');
      case 'invalid_code':
        return t('mfa.invalidCode');
      case 'range_unavailable':
        return t('inspector.unavailable');
    }
    // коды без отдельного текста: объясняем по смыслу статуса, а не общей фразой
    if (e.status === 403) return t('error.forbidden');
    if (e.status === 404) return t('error.notFound');
    if (e.status === 429) return t('auth.locked');
    if (e.status >= 500) return t('error.server');
  }
  return hasWebCrypto() ? t('error.generic') : t('error.insecure');
}

/** Основное пространство создаётся с английским именем «Organization»: в интерфейсе показываем его на языке пользователя. */
export function spaceLabel(s: { name: string; isDefault?: boolean }, t: T): string {
  return s.isDefault && s.name === 'Organization' ? t('spaces.defaultName') : s.name;
}

/** Корпоративный сейф, созданный при первой регистрации, хранит английское имя «Organization»: показываем его на языке интерфейса. */
export function vaultLabel(
  v: { name: string | null; kind?: string },
  t: (k: string) => string,
): string {
  return v.kind !== 'locker' && v.name === 'Organization'
    ? t('spaces.defaultName')
    : (v.name ?? '');
}
