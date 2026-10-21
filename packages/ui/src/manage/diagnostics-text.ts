import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

type Options = ReturnType<typeof messageOptions>;

export interface DiagnosticMessage {
  code: string;
  status?: number;
  detail?: string;
  to?: string;
  locale?: string;
  repository?: string;
  revision?: string;
  bucket?: string;
  duration?: number;
  worker?: string;
  version?: number;
  entry?: string;
  name?: string;
}

export const responseMessage = (
  body: Record<string, unknown>,
  fallback: string,
  status?: number,
): DiagnosticMessage => ({
  code: typeof body.code === 'string' ? body.code : fallback,
  ...(status ? { status } : {}),
  ...(typeof body.error === 'string'
    ? { detail: body.error }
    : typeof body.detail === 'string'
      ? { detail: body.detail }
      : {}),
  ...(typeof body.to === 'string' ? { to: body.to } : {}),
  ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
  ...(typeof body.repository === 'string' ? { repository: body.repository } : {}),
  ...(typeof body.revision === 'string' ? { revision: body.revision } : {}),
  ...(typeof body.bucket === 'string' ? { bucket: body.bucket } : {}),
  ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
  ...(typeof body.worker === 'string' ? { worker: body.worker } : {}),
  ...(typeof body.version === 'number' ? { version: body.version } : {}),
  ...(typeof body.entry === 'string' ? { entry: body.entry } : {}),
});

/** The provider's own sentence is English, so it follows the localized one as technical detail. */
export const diagnosticDetail = (message: DiagnosticMessage, uiLocale: UiLocale) =>
  message.detail && message.code !== 'DIAGNOSTIC_DETAIL'
    ? m.common_technical_detail({ detail: message.detail }, messageOptions(uiLocale))
    : '';

export function diagnosticText(message: DiagnosticMessage, uiLocale: UiLocale): string {
  const options = messageOptions(uiLocale);
  switch (message.code) {
    case 'DIAGNOSTICS_LOAD_FAILED':
      return m.diagnostics_load_failed({ status: message.status ?? 0 }, options);
    case 'DIAGNOSTIC_CHECK_FAILED':
      return m.diagnostics_check_failed({ status: message.status ?? 0 }, options);
    case 'DIAGNOSTIC_EMAIL_SENT':
      return m.diagnostics_email_sent({ email: message.to ?? '' }, options);
    case 'DIAGNOSTIC_GITHUB_OK':
      return m.diagnostics_github_ok(
        { repository: message.repository ?? '', revision: message.revision ?? '' },
        options,
      );
    case 'DIAGNOSTIC_STORAGE_OK':
      return m.diagnostics_storage_ok(
        { bucket: message.bucket ?? '', duration: message.duration ?? 0 },
        options,
      );
    case 'DIAGNOSTIC_TRANSLATION_OK':
    case 'INTEGRATION_KEY_TESTED':
      return m.diagnostics_translation_ok(
        { locale: message.locale ? formatLanguageName(message.locale, uiLocale) : '' },
        options,
      );
    case 'DIAGNOSTIC_TRANSLATION_OFF':
      return m.diagnostics_translation_off({}, options);
    case 'DIAGNOSTIC_TRANSLATION_SINGLE_LANGUAGE':
      return m.diagnostics_translation_single_language({}, options);
    case 'DIAGNOSTIC_BUILD_OK':
      return m.diagnostics_build_ok({ worker: message.worker ?? '' }, options);
    case 'DIAGNOSTIC_BUILD_OFF':
      return m.diagnostics_build_off({}, options);
    case 'DIAGNOSTIC_DATABASE_OK':
      return m.diagnostics_database_ok({ version: message.version ?? 0 }, options);
    case 'INTEGRATION_KEYS_LOAD_FAILED':
      return m.diagnostics_keys_load_failed({ status: message.status ?? 0 }, options);
    case 'INTEGRATION_KEY_SAVE_FAILED':
      return m.diagnostics_key_save_failed({ status: message.status ?? 0 }, options);
    case 'INTEGRATION_KEY_REMOVE_FAILED':
      return m.diagnostics_key_remove_failed({ status: message.status ?? 0 }, options);
    case 'INTEGRATION_KEY_REQUIRED':
      return m.diagnostics_key_required({}, options);
    case 'INTEGRATION_KEY_STORED':
      return m.diagnostics_key_stored({ name: message.name ?? '' }, options);
    case 'INTEGRATION_KEY_REMOVED':
      return m.diagnostics_key_removed({ name: message.name ?? '' }, options);
    case 'DIAGNOSTIC_CONFLICT_CREATED':
      return m.diagnostics_conflict_created({ entry: message.entry ?? '' }, options);
    case 'DIAGNOSTIC_CONFLICT_FAILED':
      return m.diagnostics_conflict_failed({ status: message.status ?? 0 }, options);
    case 'DIAGNOSTIC_DETAIL':
      return message.detail ?? '';
    case 'DIAGNOSTIC_REFUSED':
      return m.diagnostics_refused({}, options);
    case 'DIAGNOSTIC_UNAVAILABLE':
      return m.diagnostics_unavailable({}, options);
    default:
      return m.diagnostics_check_failed({ status: message.status ?? 0 }, options);
  }
}

export function checkName(key: string, uiLocale: UiLocale): string {
  const options = messageOptions(uiLocale);
  if (key === 'github') return m.diagnostics_github_name({}, options);
  if (key === 'storage') return m.diagnostics_storage_name({}, options);
  if (key === 'email') return m.diagnostics_email_name({}, options);
  if (key === 'build') return m.diagnostics_build_name({}, options);
  return m.diagnostics_database_name({}, options);
}

export function checkWhat(key: string, uiLocale: UiLocale): string {
  const options = messageOptions(uiLocale);
  if (key === 'github') return m.diagnostics_github_what({}, options);
  if (key === 'storage') return m.diagnostics_storage_what({}, options);
  if (key === 'email') return m.diagnostics_email_what({}, options);
  if (key === 'build') return m.diagnostics_build_what({}, options);
  return m.diagnostics_database_what({}, options);
}

/** Brand names, so they stay as they are in every interface language. */
export function provider(
  key: string,
  mailer: { provider: string } | null,
  uiLocale: UiLocale,
): string | undefined {
  if (key === 'github') return 'GitHub';
  if (key === 'storage') return 'Cloudflare R2';
  if (key === 'email')
    return mailer ? mailerName(mailer.provider, messageOptions(uiLocale)) : undefined;
  if (key === 'build') return 'Cloudflare Workers Builds';
  return 'Cloudflare D1';
}

export function checkStops(key: string, uiLocale: UiLocale): string {
  const options = messageOptions(uiLocale);
  if (key === 'github') return m.diagnostics_github_stops({}, options);
  if (key === 'storage') return m.diagnostics_storage_stops({}, options);
  if (key === 'email') return m.diagnostics_email_stops({}, options);
  if (key === 'translation') return m.diagnostics_translation_stops({}, options);
  if (key === 'build') return m.diagnostics_build_stops({}, options);
  return m.diagnostics_database_stops({}, options);
}

const mailerName = (provider: string, options: Options) => {
  if (provider === 'resend') return 'Resend';
  if (provider === 'smtp') return 'SMTP';
  if (provider === 'cloudflare') return 'Cloudflare Email Sending';
  if (provider === 'custom') return m.diagnostics_custom_mailer({}, options);
  return provider;
};
