import type { UiLocale } from './i18n.js';
import { messageOptions } from './i18n.js';
import * as m from './paraglide/messages.js';

export interface UiMessage {
  code: string;
  status?: number;
  detail?: string;
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
]);

export function messageText(message: UiMessage, locale: UiLocale): string {
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
    default:
      return m.common_unknown_error({}, options);
  }
}
