import type { UiLocale } from './i18n.js';
import { formatLanguageList, formatLanguageName, messageOptions } from './i18n.js';
import * as m from './paraglide/messages.js';

export interface UiMessage {
  code: string;
  status?: number;
  detail?: string;
  limit?: number;
  inclusive?: boolean;
  exact?: boolean;
  count?: number;
  suggestion?: string;
  page?: string;
  address?: string;
  collection?: string;
  locale?: string;
  locales?: string[];
  remaining?: string[];
}

export interface UiProblem {
  message: string;
  descriptor?: UiMessage;
}

export async function responseMessage(response: Response, fallback: string): Promise<UiMessage> {
  const headerCode = response.headers.get('x-handover-error-code');
  let body:
    | (Record<string, unknown> & { code?: unknown; error?: unknown; message?: unknown })
    | undefined;
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
  const strings = (key: string) =>
    Array.isArray(body?.[key]) && body[key].every((value) => typeof value === 'string')
      ? (body[key] as string[])
      : undefined;
  return {
    code: known ? code : fallback,
    status: response.status,
    ...(detail ? { detail } : {}),
    ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    ...(typeof body?.address === 'string' ? { address: body.address } : {}),
    ...(typeof body?.collection === 'string' ? { collection: body.collection } : {}),
    ...(typeof body?.locale === 'string' ? { locale: body.locale } : {}),
    ...(strings('locales') ? { locales: strings('locales') } : {}),
    ...(strings('remaining') ? { remaining: strings('remaining') } : {}),
  };
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
  'MEDIA_METADATA_INVALID',
  'MEDIA_NOT_FOUND',
  'MEDIA_STORAGE_UNAVAILABLE',
  'MEDIA_IN_USE',
  'MEDIA_PUBLISHED_IN_USE',
  'ENTRY_ADDRESS_TOO_LONG',
  'ENTRY_ADDRESS_INVALID',
  'ENTRY_ADDRESS_TAKEN',
  'ENTRY_LOCALE_LAST_PUBLISHED',
  'ENTRY_LOCALE_LAST_FILE',
  'REDIRECT_NOT_FOUND',
  'REDIRECT_MANAGED',
  'PUBLISH_INCOMPLETE',
  'PUBLISH_DRIFT',
  'PUBLISH_CONFLICT',
  'PUBLISH_REF_MOVED',
  'PUBLISH_REPOSITORY_UNAVAILABLE',
  'PUBLISH_FINALIZATION_PENDING',
  'PUBLISH_CHECKS_FAILED',
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
    case 'ENTRY_ADDRESS_TOO_LONG':
      return m.editor_address_too_long({ limit: message.limit ?? 80 }, options);
    case 'ENTRY_ADDRESS_INVALID':
      return m.editor_address_invalid({}, options);
    case 'ENTRY_ADDRESS_TAKEN':
      return m.editor_address_taken(
        {
          address: message.address ?? '',
          collection: message.collection ?? '',
          language: message.locale ? formatLanguageName(message.locale, locale) : '',
        },
        options,
      );
    case 'ENTRY_LOCALE_LAST_PUBLISHED':
      return m.offsite_last_published(
        {
          languages: formatLanguageList(message.locales ?? [], locale),
          remaining: formatLanguageList(message.remaining ?? [], locale),
        },
        options,
      );
    case 'ENTRY_LOCALE_LAST_FILE':
      return m.offsite_last_file(
        { languages: formatLanguageList(message.locales ?? [], locale) },
        options,
      );
    case 'REDIRECT_NOT_FOUND':
      return m.redirect_not_found({}, options);
    case 'REDIRECT_MANAGED':
      return m.redirect_managed_error({}, options);
    case 'REDIRECT_LOAD_FAILED':
      return message.status
        ? m.redirect_load_failed_status({ status: message.status }, options)
        : m.redirect_load_failed({}, options);
    case 'REDIRECT_SAVE_FAILED':
      return message.status
        ? m.redirect_save_failed_status({ status: message.status }, options)
        : m.redirect_save_failed({}, options);
    case 'REDIRECT_DELETE_FAILED':
      return message.status
        ? m.redirect_delete_failed_status({ status: message.status }, options)
        : m.redirect_delete_failed({}, options);
    case 'REDIRECT_FROM_REQUIRED':
      return m.redirect_validation_from_required({}, options);
    case 'REDIRECT_FROM_ABSOLUTE':
      return m.redirect_validation_from_absolute({}, options);
    case 'REDIRECT_FROM_SLASH':
      return m.redirect_validation_from_slash({ suggestion: message.suggestion ?? '/' }, options);
    case 'REDIRECT_FROM_WHITESPACE':
      return m.redirect_validation_from_whitespace({}, options);
    case 'REDIRECT_TO_REQUIRED':
      return m.redirect_validation_to_required({}, options);
    case 'REDIRECT_TO_WHITESPACE':
      return m.redirect_validation_to_whitespace({}, options);
    case 'REDIRECT_TO_INVALID':
      return m.redirect_validation_to_invalid({ suggestion: message.suggestion ?? '/' }, options);
    case 'REDIRECT_SAME_ADDRESS':
      return m.redirect_validation_same({}, options);
    case 'REDIRECT_SHADOWS_PAGE':
      return m.redirect_validation_shadows({ page: message.page ?? '' }, options);
    case 'REDIRECT_FROM_EXISTS':
      return m.redirect_validation_exists({}, options);
    case 'PUBLISH_SAVE_FAILED':
      return m.publish_save_failed({}, options);
    case 'PUBLISH_CHECKS_BLOCKED':
      return m.publish_checks_blocked({}, options);
    case 'PUBLISH_RESPONSE_LOST':
      return m.publish_response_lost({}, options);
    case 'PUBLISH_ENTRY_RESPONSE_LOST':
      return m.publish_entry_response_lost({}, options);
    case 'PUBLISH_RELOAD_FAILED':
      return m.publish_reload_failed({}, options);
    case 'PUBLISH_ENTRY_RELOAD_FAILED':
      return m.publish_entry_reload_failed({}, options);
    case 'PUBLISH_FAILED':
      return message.status
        ? m.publish_failed_status({ status: message.status }, options)
        : m.publish_failed({}, options);
    case 'PUBLISH_INCOMPLETE':
      return m.publish_incomplete({ count: message.count ?? 0 }, options);
    case 'PUBLISH_DRIFT':
      return m.publish_drift({ count: message.count ?? 0 }, options);
    case 'PUBLISH_CONFLICT':
      return m.publish_conflict({ count: message.count ?? 0 }, options);
    case 'PUBLISH_REF_MOVED':
      return m.publish_ref_moved({}, options);
    case 'PUBLISH_REPOSITORY_UNAVAILABLE':
      return m.publish_repository_unavailable({}, options);
    case 'PUBLISH_FINALIZATION_PENDING':
      return m.publish_finalization_pending({}, options);
    case 'PUBLISH_ENTRY_INCOMPLETE':
      return m.publish_entry_incomplete({}, options);
    case 'PUBLISH_ENTRY_DRIFT':
      return m.publish_entry_drift({}, options);
    case 'PUBLISH_CHECKS_FAILED':
      return m.pending_checks_failed({}, options);
    case 'PENDING_DISCARD_SAVE_FAILED':
      return m.pending_discard_save_failed({}, options);
    case 'PENDING_DISCARD_UNCONFIRMED':
      return m.pending_discard_unconfirmed({}, options);
    case 'PENDING_DISCARD_REMOTE_CHANGED':
      return m.pending_discard_remote_changed({}, options);
    case 'PENDING_DISCARD_FAILED':
      return m.pending_discard_failed({ status: message.status ?? 0 }, options);
    case 'PENDING_DIFF_FAILED':
      return m.pending_diff_failed(
        { page: message.page ?? '', status: message.status ?? 0 },
        options,
      );
    case 'HISTORY_LOAD_FAILED':
      return message.status
        ? m.history_load_failed_status({ status: message.status }, options)
        : m.history_load_failed({}, options);
    case 'HISTORY_DIFF_FAILED':
      return m.history_diff_failed({}, options);
    case 'HISTORY_RESTORE_SAVE_FAILED':
      return m.history_restore_save_failed({}, options);
    case 'HISTORY_RESTORE_UNCONFIRMED':
      return m.history_restore_unconfirmed({}, options);
    case 'HISTORY_RESTORE_RELOAD_FAILED':
      return m.history_restore_reload_failed({}, options);
    case 'HISTORY_RESTORE_FAILED':
      return message.status
        ? m.history_restore_failed_status({ status: message.status }, options)
        : m.history_restore_failed({}, options);
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
    case 'TRANSLATION_FAILED':
      return message.status
        ? m.translation_failed_status({ status: message.status }, options)
        : m.translation_failed({}, options);
    case 'TRANSLATION_UNCONFIRMED':
      return m.translation_unconfirmed({}, options);
    case 'TRANSLATION_STALE':
      return m.translation_stale({}, options);
    case 'TRANSLATION_CREATE_FAILED':
      return message.status
        ? m.translation_create_failed_status({ status: message.status }, options)
        : m.translation_create_failed({}, options);
    case 'TRANSLATION_CREATE_UNCONFIRMED':
      return m.translation_create_unconfirmed({}, options);
    case 'TRANSLATION_CREATED_FILL_FAILED':
      return m.translation_created_fill_failed({}, options);
    case 'TRANSLATION_CREATED_FILL_UNCONFIRMED':
      return m.translation_created_fill_unconfirmed({}, options);
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
    case 'MEDIA_LIBRARY_READ_FAILED':
      return message.status
        ? m.media_library_read_failed_status({ status: message.status }, options)
        : m.media_library_read_failed({}, options);
    case 'MEDIA_LIBRARY_READ_INVALID':
      return m.media_library_read_invalid({}, options);
    case 'MEDIA_METADATA_FAILED':
      return message.status
        ? m.media_library_metadata_failed_status({ status: message.status }, options)
        : m.media_library_metadata_failed({}, options);
    case 'MEDIA_METADATA_UNCONFIRMED':
      return m.media_library_metadata_unconfirmed({}, options);
    case 'MEDIA_METADATA_INVALID':
      return m.media_library_metadata_invalid({}, options);
    case 'MEDIA_NOT_FOUND':
      return m.media_library_not_found({}, options);
    case 'MEDIA_STORAGE_UNAVAILABLE':
      return m.media_library_storage_unavailable({}, options);
    case 'MEDIA_IN_USE':
      return m.media_library_delete_in_use({ count: message.count ?? 0 }, options);
    case 'MEDIA_PUBLISHED_IN_USE':
      return m.media_library_delete_published_in_use({ count: message.count ?? 0 }, options);
    case 'MEDIA_DELETE_FAILED':
      return message.status
        ? m.media_library_delete_failed_status({ status: message.status }, options)
        : m.media_library_delete_failed({}, options);
    case 'MEDIA_DELETE_UNCONFIRMED':
      return m.media_library_delete_unconfirmed({}, options);
    case 'MEDIA_DELETE_INVALID':
      return m.media_library_delete_invalid({}, options);
    case 'CROP_SOURCE_FAILED':
      return message.status
        ? m.crop_source_failed_status({ status: message.status }, options)
        : m.crop_source_failed({}, options);
    case 'CROP_RENDER_FAILED':
      return m.crop_render_failed({}, options);
    case 'CROP_FAILED':
      return m.crop_failed({}, options);
    default:
      return m.common_unknown_error({}, options);
  }
}

/** A descriptor marks Handover-owned validation; unmarked schema prose stays authored. */
export function problemText(problem: UiProblem, locale: UiLocale): string {
  return (problem.descriptor && validationText(problem.descriptor, locale)) ?? problem.message;
}
