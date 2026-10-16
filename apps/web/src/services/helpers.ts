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
    }
  }
  return hasWebCrypto() ? t('error.generic') : t('error.insecure');
}
