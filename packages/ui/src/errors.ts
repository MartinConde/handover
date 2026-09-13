import type { UiLocale } from './i18n.js';
import { messageOptions } from './i18n.js';
import * as m from './paraglide/messages.js';

export interface UiMessage {
  code: string;
  status?: number;
  detail?: string;
  limit?: number;
  inclusive?: boolean;
  exact?: boolean;
}

export interface UiProblem {
  message: string;
  descriptor?: UiMessage;
}

export async function responseMessage(response: Response, fallback: string): Promise<UiMessage> {
  const headerCode = response.headers.get('x-handover-error-code');
  let body: { code?: unknown; error?: unknown; message?: unknown } | undefined;
  try {
    body = (await response.clone().json()) as typeof body;
  } catch {
    body = undefined;
  }
  const responseCode = typeof body?.code === 'string' ? body.code : undefined;
  const code = headerCode ?? responseCode ?? fallback;
  const known = KNOWN_CODES.has(code);
  const detailValue = typeof body?.error === 'string' ? body.error : body?.message;
  const detail = typeof detailValue === 'string' && !known ? detailValue : undefined;
  return { code: known ? code : fallback, status: response.status, ...(detail ? { detail } : {}) };
}

const KNOWN_CODES = new Set([
  'CONNECTION_LOST',
  'INVALID_EMAIL_OR_PASSWORD',
  'CREDENTIAL_ACCOUNT_NOT_FOUND',
  'INVALID_PASSWORD',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'EDITOR_HOLD_FAILED',
  'EDITOR_LOCK_TAKE_FAILED',
  'EDITOR_SAVE_CONNECTION',
  'EDITOR_SAVE_REFUSED',
  'EDITOR_SAVE_REVISION',
  'FIELD_REQUIRED',
]);

const numberFormats = new Map<UiLocale, Intl.NumberFormat>();

function numberText(value: number, locale: UiLocale): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      maximumSignificantDigits: 21,
      useGrouping: false,
    });
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

function validationText(message: UiMessage, locale: UiLocale): string | undefined {
  const options = messageOptions(locale);
  switch (message.code) {
    case 'FIELD_REQUIRED':
      return m.validation_required({}, options);
    case 'FIELD_EXPECTED_TEXT':
      return m.validation_expected_text({}, options);
    case 'FIELD_EXPECTED_NUMBER':
      return m.validation_expected_number({}, options);
    case 'FIELD_EXPECTED_INTEGER':
      return m.validation_expected_integer({}, options);
    case 'FIELD_EXPECTED_BOOLEAN':
      return m.validation_expected_boolean({}, options);
    case 'FIELD_INVALID_DATE':
      return m.validation_invalid_date({}, options);
    case 'FIELD_INVALID_SELECTION':
      return m.validation_invalid_selection({}, options);
  }
  if (typeof message.limit !== 'number' || !Number.isFinite(message.limit)) return undefined;
  if (
    (message.code === 'FIELD_TEXT_TOO_SMALL' || message.code === 'FIELD_TEXT_TOO_BIG') &&
    (Object.hasOwn(message, 'inclusive') ||
      (Object.hasOwn(message, 'exact') && typeof message.exact !== 'boolean'))
  )
    return undefined;
  if (
    (message.code === 'FIELD_NUMBER_TOO_SMALL' || message.code === 'FIELD_NUMBER_TOO_BIG') &&
    (Object.hasOwn(message, 'exact') || typeof message.inclusive !== 'boolean')
  )
    return undefined;
  const limit = message.limit;
  switch (message.code) {
    case 'FIELD_TEXT_TOO_SMALL':
      return message.exact === true
        ? m.validation_text_exact({ limit }, options)
        : m.validation_text_minimum({ limit }, options);
    case 'FIELD_TEXT_TOO_BIG':
      return message.exact === true
        ? m.validation_text_exact({ limit }, options)
        : m.validation_text_maximum({ limit }, options);
    case 'FIELD_NUMBER_TOO_SMALL': {
      const formatted = numberText(limit, locale);
      return message.inclusive
        ? m.validation_number_minimum({ limit: formatted }, options)
        : m.validation_number_greater({ limit: formatted }, options);
    }
    case 'FIELD_NUMBER_TOO_BIG': {
      const formatted = numberText(limit, locale);
      return message.inclusive
        ? m.validation_number_maximum({ limit: formatted }, options)
        : m.validation_number_less({ limit: formatted }, options);
    }
    default:
      return undefined;
  }
}

export function messageText(message: UiMessage, locale: UiLocale): string {
  const validation = validationText(message, locale);
  if (validation) return validation;
  const options = messageOptions(locale);
  switch (message.code) {
    case 'CONNECTION_LOST':
      return m.common_connection_lost({}, options);
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
    case 'AUTH_SIGN_IN_FAILED':
      return m.auth_sign_in_failed({}, options);
    case 'INVALID_PASSWORD':
      return m.account_current_password_wrong({}, options);
    case 'PASSWORD_TOO_SHORT':
    case 'AUTH_PASSWORD_TOO_SHORT':
      return m.auth_password_too_short({}, options);
    case 'PASSWORD_TOO_LONG':
      return m.auth_password_too_long({}, options);
    case 'AUTH_PASSWORDS_DIFFERENT':
      return m.auth_passwords_different({}, options);
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
      return m.auth_reset_token_failed({}, options);
    case 'AUTH_RESET_FAILED':
      return m.auth_reset_failed({}, options);
    case 'AUTH_RESET_REQUEST_FAILED':
      return m.auth_reset_request_failed({}, options);
    case 'AUTH_GITHUB_FAILED':
      return m.auth_github_failed({}, options);
    case 'ACCOUNT_NAME_SAVE_FAILED':
      return m.account_name_save_failed({}, options);
    case 'ACCOUNT_NAME_SAVED':
      return m.account_name_saved({}, options);
    case 'ACCOUNT_PASSWORD_FAILED':
      return m.account_password_failed({}, options);
    case 'ACCOUNT_PASSWORD_CHANGED':
      return m.account_password_changed({}, options);
    case 'ACCOUNT_PASSWORD_SET':
      return m.account_password_set({}, options);
    case 'ACCOUNT_SESSIONS_END_FAILED':
      return m.account_sessions_end_failed({}, options);
    case 'ACCOUNT_SESSIONS_ENDED':
      return m.account_sessions_ended({}, options);
    case 'ACCOUNT_LOAD_FAILED':
      return m.account_load_failed({}, options);
    case 'ENTRY_LIST_LOAD_FAILED':
      return message.status
        ? m.entry_list_load_failed_status({ status: message.status }, options)
        : m.entry_list_load_failed({}, options);
    case 'ENTRY_DELETED_LOAD_FAILED':
      return message.status
        ? m.entry_deleted_load_failed_status({ status: message.status }, options)
        : m.entry_deleted_load_failed({}, options);
    case 'ENTRY_ACTION_FAILED':
      return message.status
        ? m.entry_action_failed_status({ status: message.status }, options)
        : m.entry_action_failed({}, options);
    case 'ENTRY_CREATE_FAILED':
      return message.status
        ? m.new_entry_create_failed_status({ status: message.status }, options)
        : m.new_entry_create_failed({}, options);
    case 'ENTRY_CREATE_UNCONFIRMED':
      return m.new_entry_create_unconfirmed({}, options);
    case 'EDITOR_HOLD_FAILED':
      return m.editor_hold_failed({}, options);
    case 'EDITOR_LOCK_TAKE_FAILED':
      return m.editor_lock_take_failed({}, options);
    case 'EDITOR_SAVE_CONNECTION':
      return m.editor_save_connection({}, options);
    case 'EDITOR_SAVE_REFUSED':
      return m.editor_save_refused({}, options);
    case 'EDITOR_SAVE_REVISION':
      return m.editor_save_revision({}, options);
    case 'MEDIA_UPLOAD_DECLARATION_FAILED':
      return message.status
        ? m.media_upload_declaration_failed_status({ status: message.status }, options)
        : m.media_upload_declaration_failed({}, options);
    case 'MEDIA_UPLOAD_DECLARATION_UNCONFIRMED':
      return m.media_upload_declaration_unconfirmed({}, options);
    case 'MEDIA_UPLOAD_DECLARATION_INVALID':
      return m.media_upload_declaration_invalid({}, options);
    case 'MEDIA_UPLOAD_BUCKET_FAILED':
      return message.status
        ? m.media_upload_bucket_failed_status({ status: message.status }, options)
        : m.media_upload_bucket_failed({}, options);
    case 'MEDIA_UPLOAD_BUCKET_UNCONFIRMED':
      return m.media_upload_bucket_unconfirmed({}, options);
    case 'MEDIA_UPLOAD_CONFIRMATION_FAILED':
      return message.status
        ? m.media_upload_confirmation_failed_status({ status: message.status }, options)
        : m.media_upload_confirmation_failed({}, options);
    case 'MEDIA_UPLOAD_CONFIRMATION_UNCONFIRMED':
      return m.media_upload_confirmation_unconfirmed({}, options);
    case 'MEDIA_UPLOAD_CONFIRMATION_INVALID':
      return m.media_upload_confirmation_invalid({}, options);
    case 'MEDIA_UPLOAD_NORMALIZATION_FAILED':
      return m.media_upload_normalization_failed({}, options);
    case 'MEDIA_UPLOAD_FAILED':
      return m.media_upload_failed({}, options);
    default:
      return m.common_unknown_error({}, options);
  }
}

/** A descriptor marks Handover-owned validation; unmarked schema prose stays authored. */
export function problemText(problem: UiProblem, locale: UiLocale): string {
  return (problem.descriptor && validationText(problem.descriptor, locale)) ?? problem.message;
}
