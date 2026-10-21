import type { UiLocale } from './i18n.js';
import { formatLanguageList, formatLanguageName, messageOptions } from './i18n.js';
import { fileSize } from './media/upload.js';
import * as m from './paraglide/messages.js';

export interface UiMessage {
  code: string;
  status?: number;
  detail?: string;
  /** Who holds the entry a refusal is about; null when the lock has no name. */
  holder?: string | null;
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
  paths?: string[];
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
  // Better Auth's rate limiter answers 429 with a message and no code.
  const code =
    headerCode ?? responseCode ?? (response.status === 429 ? 'RESOURCE_LIMIT' : fallback);
  const known = KNOWN_CODES.has(code);
  const detailValue = typeof body?.error === 'string' ? body.error : body?.message;
  const heldBy = body?.held_by;
  const holder =
    heldBy && typeof heldBy === 'object' && 'name' in heldBy
      ? typeof heldBy.name === 'string'
        ? heldBy.name
        : null
      : undefined;
  const detail =
    typeof detailValue === 'string' && !known && holder === undefined ? detailValue : undefined;
  const strings = (key: string) =>
    Array.isArray(body?.[key]) && body[key].every((value) => typeof value === 'string')
      ? (body[key] as string[])
      : undefined;
  return {
    code: known ? code : fallback,
    status: response.status,
    ...(detail ? { detail } : {}),
    ...(holder !== undefined ? { holder } : {}),
    ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    ...(typeof body?.address === 'string' ? { address: body.address } : {}),
    ...(typeof body?.collection === 'string' ? { collection: body.collection } : {}),
    ...(typeof body?.locale === 'string' ? { locale: body.locale } : {}),
    ...(strings('locales') ? { locales: strings('locales') } : {}),
    ...(strings('remaining') ? { remaining: strings('remaining') } : {}),
    ...(strings('paths') ? { paths: strings('paths') } : {}),
  };
}

/** `responseMessage`, plus a plain-text refusal's own words, such as who holds the entry. */
export async function retainedFailure(response: Response, fallback: string): Promise<UiMessage> {
  const message = await responseMessage(response, fallback);
  if (
    message.detail ||
    message.code === 'CONNECTION_LOST' ||
    !response.headers.get('content-type')?.startsWith('text/plain')
  )
    return message;
  const detail = (await response.clone().text()).trim();
  return detail ? { ...message, detail } : message;
}

type Render = (context: {
  message: UiMessage;
  locale: UiLocale;
  options: ReturnType<typeof messageOptions>;
}) => string;

// Status 0 is no answer at all, so it gets the plain message.
const withStatus =
  (
    plain: (inputs: Record<string, never>, opts: ReturnType<typeof messageOptions>) => string,
    status: (inputs: { status: number }, opts: ReturnType<typeof messageOptions>) => string,
  ): Render =>
  ({ message, options }) =>
    message.status ? status({ status: message.status }, options) : plain({}, options);

const sameText = (codes: string[], render: Render) =>
  Object.fromEntries(codes.map((code) => [code, render]));

// Codes the server sends; adding one is one entry here.
const SERVER_TEXT: Record<string, Render> = {
  CONNECTION_LOST: ({ options }) => m.common_connection_lost({}, options),
  ...sameText(['INVALID_EMAIL_OR_PASSWORD', 'CREDENTIAL_ACCOUNT_NOT_FOUND'], ({ options }) =>
    m.auth_sign_in_failed({}, options),
  ),
  INVALID_PASSWORD: ({ options }) => m.account_current_password_wrong({}, options),
  ...sameText(['SESSION_NOT_FRESH', 'SESSION_EXPIRED'], ({ options }) =>
    m.account_password_sign_in_again({}, options),
  ),
  INVALID_EMAIL: ({ options }) => m.account_email_invalid({}, options),
  ...sameText(['USER_NOT_FOUND', 'USER_EMAIL_NOT_FOUND', 'INVALID_USER'], ({ options }) =>
    m.account_user_not_found({}, options),
  ),
  EMAIL_NOT_VERIFIED: ({ options }) => m.account_email_not_verified({}, options),
  ...sameText(['EMAIL_CAN_NOT_BE_UPDATED', 'CHANGE_EMAIL_DISABLED'], ({ options }) =>
    m.account_email_change_unavailable({}, options),
  ),
  FAILED_TO_UPDATE_USER: ({ options }) => m.account_update_failed({}, options),
  PASSWORD_ALREADY_SET: ({ options }) => m.account_password_already_set({}, options),
  PASSWORD_TOO_SHORT: ({ options }) => m.auth_password_too_short({}, options),
  PASSWORD_TOO_LONG: ({ options }) => m.auth_password_too_long({}, options),
  ...sameText(['INVALID_TOKEN', 'TOKEN_EXPIRED'], ({ options }) =>
    m.auth_reset_token_failed({}, options),
  ),
  MEMBER_EMAIL_REQUIRED: ({ options }) => m.members_email_required({}, options),
  MEMBER_ROLE_INVALID: ({ options }) => m.members_role_invalid({}, options),
  MEMBER_ALREADY_SIGNED_IN: ({ options }) => m.members_already_signed_in({}, options),
  MEMBER_SELF_ROLE: ({ options }) => m.members_self_role({}, options),
  MEMBER_LAST_OWNER: ({ options }) => m.members_last_owner({}, options),
  MEMBER_SELF_REMOVE: ({ options }) => m.members_self_remove({}, options),
  ...sameText(['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'], ({ options }) =>
    m.members_already_exists({}, options),
  ),
  ENTRY_ADDRESS_TOO_LONG: ({ message, options }) =>
    m.editor_address_too_long({ limit: message.limit ?? 80 }, options),
  ENTRY_ADDRESS_INVALID: ({ options }) => m.editor_address_invalid({}, options),
  ENTRY_ADDRESS_TAKEN: ({ message, locale, options }) =>
    m.editor_address_taken(
      {
        address: message.address ?? '',
        collection: message.collection ?? '',
        language: message.locale ? formatLanguageName(message.locale, locale) : '',
      },
      options,
    ),
  ENTRY_RENAME_UNPUBLISHED: ({ options }) => m.entry_rename_unpublished({}, options),
  ENTRY_DUPLICATE_UNPUBLISHED: ({ options }) => m.entry_duplicate_unpublished({}, options),
  ENTRY_RENAME_COLLISION: ({ options }) => m.entry_rename_collision({}, options),
  TEMPLATE_UNPUBLISHED: ({ options }) => m.entry_template_unpublished({}, options),
  HISTORY_RESTORE_NO_FILE: ({ options }) => m.history_restore_no_file({}, options),
  HISTORY_RESTORE_UNREADABLE: ({ options }) => m.history_restore_unreadable({}, options),
  REVERT_CONFLICT: ({ message, options }) =>
    m.revert_conflict(
      { count: message.paths?.length ?? 0, files: (message.paths ?? []).join(', ') },
      options,
    ),
  ENTRY_LOCALE_LAST_PUBLISHED: ({ message, locale, options }) =>
    m.offsite_last_published(
      {
        languages: formatLanguageList(message.locales ?? [], locale),
        remaining: formatLanguageList(message.remaining ?? [], locale),
      },
      options,
    ),
  ENTRY_LOCALE_LAST_FILE: ({ message, locale, options }) =>
    m.offsite_last_file({ languages: formatLanguageList(message.locales ?? [], locale) }, options),
  ENTRY_LOCALE_IS_SOURCE: ({ message, locale, options }) =>
    m.entry_locale_is_source(
      { language: message.locale ? formatLanguageName(message.locale, locale) : '' },
      options,
    ),
  ENTRY_DRIFT_ANSWERS_INVALID: ({ options }) => m.drift_changed({}, options),
  TRANSLATION_TARGET_EXISTS: ({ options }) => m.translation_target_exists({}, options),
  ...sameText(
    ['ENTRY_SOURCE_CONFLICT', 'ENTRY_SOURCE_UNDECLARED', 'ENTRY_SOURCE_MISSING'],
    ({ options }) => m.entry_source_unresolved({}, options),
  ),
  ENTRY_SOURCE_TARGET_UNDECLARED: ({ options }) => m.entry_source_target_undeclared({}, options),
  ENTRY_SOURCE_UNCHANGED: ({ options }) => m.entry_source_unchanged({}, options),
  ENTRY_SOURCE_TARGET_MISSING: ({ options }) => m.entry_source_target_missing({}, options),
  ENTRY_SOURCE_TARGET_OFF: ({ options }) => m.entry_source_target_off({}, options),
  ENTRY_SOURCE_REVISION: ({ options }) => m.entry_source_revision({}, options),
  ENTRY_SOURCE_DRIFT: ({ options }) => m.entry_source_drift({}, options),
  ENTRY_SOURCE_ONLY_CONFLICT: ({ options }) => m.entry_source_only_conflict({}, options),
  ENTRY_SOURCE_TARGET_INVALID: ({ options }) => m.entry_source_target_invalid({}, options),
  REDIRECT_NOT_FOUND: ({ options }) => m.redirect_not_found({}, options),
  REDIRECT_MANAGED: ({ options }) => m.redirect_managed_error({}, options),
  PUBLISH_INCOMPLETE: ({ message, options }) =>
    m.publish_incomplete({ count: message.count ?? 0 }, options),
  PUBLISH_DRIFT: ({ message, options }) => m.publish_drift({ count: message.count ?? 0 }, options),
  PUBLISH_SOURCE_UNRESOLVED: ({ message, options }) =>
    m.publish_source_unresolved({ count: message.count ?? 0 }, options),
  PUBLISH_CONFLICT: ({ message, options }) =>
    m.publish_conflict({ count: message.count ?? 0 }, options),
  PUBLISH_REF_MOVED: ({ options }) => m.publish_ref_moved({}, options),
  PUBLISH_REPOSITORY_UNAVAILABLE: ({ options }) => m.publish_repository_unavailable({}, options),
  PUBLISH_FINALIZATION_PENDING: ({ options }) => m.publish_finalization_pending({}, options),
  PUBLISH_CHECKS_FAILED: ({ options }) => m.pending_checks_failed({}, options),
  PUBLISH_SELECTION_INVALID: ({ options }) => m.publish_selection_invalid({}, options),
  PUBLISH_EXCLUDE_NOT_PENDING: ({ options }) => m.publish_exclude_not_pending({}, options),
  PUBLISH_EXCLUDE_ALL: ({ options }) => m.publish_exclude_all({}, options),
  PUBLISH_EXCLUDE_PUBLISHED: ({ options }) => m.publish_exclude_published({}, options),
  PUBLISH_EXCLUDE_SOURCE: ({ options }) => m.publish_exclude_source({}, options),
  CONFLICT_SETTLED: ({ options }) => m.conflict_settled({}, options),
  CONFLICT_CHANGED: ({ options }) => m.conflict_changed({}, options),
  CONFLICT_ANSWERS_INVALID: ({ options }) => m.conflict_answers_invalid({}, options),
  CONFLICT_REPOSITORY_UNAVAILABLE: ({ options }) => m.conflict_repository_unavailable({}, options),
  EDITOR_HOLD_FAILED: ({ options }) => m.editor_hold_failed({}, options),
  EDITOR_LOCK_TAKE_FAILED: ({ options }) => m.editor_lock_take_failed({}, options),
  EDITOR_SAVE_CONNECTION: ({ options }) => m.editor_save_connection({}, options),
  EDITOR_SAVE_REFUSED: ({ options }) => m.editor_save_refused({}, options),
  EDITOR_SAVE_REVISION: ({ options }) => m.editor_save_revision({}, options),
  MEDIA_METADATA_INVALID: ({ options }) => m.media_library_metadata_invalid({}, options),
  MEDIA_NOT_FOUND: ({ options }) => m.media_library_not_found({}, options),
  MEDIA_STORAGE_UNAVAILABLE: ({ options }) => m.media_library_storage_unavailable({}, options),
  MEDIA_IN_USE: ({ message, options }) =>
    m.media_library_delete_in_use({ count: message.count ?? 0 }, options),
  MEDIA_PUBLISHED_IN_USE: ({ message, options }) =>
    m.media_library_delete_published_in_use({ count: message.count ?? 0 }, options),
  MEDIA_TOO_LARGE: ({ message, locale, options }) =>
    m.media_upload_too_large({ limit: fileSize(message.limit, locale) }, options),
  MEDIA_SIZE_MISMATCH: ({ options }) => m.media_upload_size_mismatch({}, options),
  MEDIA_TYPE_MISMATCH: ({ options }) => m.media_upload_type_mismatch({}, options),
  MEDIA_EMPTY: ({ options }) => m.media_upload_empty({}, options),
  MEDIA_INGEST_TIMEOUT: ({ options }) => m.media_upload_timeout({}, options),
  MEDIA_UPLOAD_BUCKET_MISSING: ({ options }) => m.media_upload_bucket_missing({}, options),
  MEDIA_UNAVAILABLE: ({ options }) => m.media_unavailable({}, options),
  MEDIA_BECAME_USED: ({ options }) => m.media_became_used({}, options),
  BODY_TOO_LARGE: ({ options }) => m.request_too_large({}, options),
  BODY_STRUCTURE_INVALID: ({ options }) => m.request_malformed({}, options),
  RESOURCE_LIMIT: ({ options }) => m.request_rate_limited({}, options),
};

// FIELD_REQUIRED is rendered by validationText.
const KNOWN_CODES = new Set([...Object.keys(SERVER_TEXT), 'FIELD_REQUIRED']);

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

// Outcomes the client raises itself; the server never sends these codes.
const LOCAL_TEXT: Record<string, Render> = {
  AUTH_SIGN_IN_FAILED: ({ options }) => m.auth_sign_in_failed({}, options),
  AUTH_PASSWORD_TOO_SHORT: ({ options }) => m.auth_password_too_short({}, options),
  AUTH_PASSWORDS_DIFFERENT: ({ options }) => m.auth_passwords_different({}, options),
  AUTH_RESET_FAILED: ({ options }) => m.auth_reset_failed({}, options),
  AUTH_RESET_REQUEST_FAILED: ({ options }) => m.auth_reset_request_failed({}, options),
  AUTH_GITHUB_FAILED: ({ options }) => m.auth_github_failed({}, options),
  ACCOUNT_NAME_SAVE_FAILED: ({ options }) => m.account_name_save_failed({}, options),
  ACCOUNT_NAME_SAVED: ({ options }) => m.account_name_saved({}, options),
  ACCOUNT_PASSWORD_FAILED: ({ options }) => m.account_password_failed({}, options),
  ACCOUNT_PASSWORD_CHANGED: ({ options }) => m.account_password_changed({}, options),
  ACCOUNT_PASSWORD_SET: ({ options }) => m.account_password_set({}, options),
  ACCOUNT_EMAIL_CHANGE_SENT: ({ options }) => m.account_email_change_sent({}, options),
  ACCOUNT_EMAIL_CHANGE_FAILED: ({ options }) => m.account_email_change_failed({}, options),
  ACCOUNT_EMAIL_LINK_FAILED: ({ options }) => m.account_email_link_failed({}, options),
  ACCOUNT_SESSIONS_END_FAILED: ({ options }) => m.account_sessions_end_failed({}, options),
  ACCOUNT_SESSIONS_ENDED: ({ options }) => m.account_sessions_ended({}, options),
  ACCOUNT_LOAD_FAILED: ({ options }) => m.account_load_failed({}, options),
  MEMBER_LIST_FAILED: withStatus(m.members_load_failed, m.members_load_failed_status),
  MEMBER_INVITE_FAILED: withStatus(m.members_invite_failed, m.members_invite_failed_status),
  MEMBER_ROLE_FAILED: withStatus(m.members_role_failed, m.members_role_failed_status),
  MEMBER_REMOVE_FAILED: withStatus(m.members_remove_failed, m.members_remove_failed_status),
  ENTRY_LIST_LOAD_FAILED: withStatus(m.entry_list_load_failed, m.entry_list_load_failed_status),
  ENTRY_DELETED_LOAD_FAILED: withStatus(
    m.entry_deleted_load_failed,
    m.entry_deleted_load_failed_status,
  ),
  ENTRY_ACTION_FAILED: withStatus(m.entry_action_failed, m.entry_action_failed_status),
  ENTRY_CREATE_FAILED: withStatus(m.new_entry_create_failed, m.new_entry_create_failed_status),
  ENTRY_CREATE_UNCONFIRMED: ({ options }) => m.new_entry_create_unconfirmed({}, options),
  SOURCE_CHANGE_SAVE_FAILED: ({ options }) => m.source_change_save_failed({}, options),
  SOURCE_CHANGE_RESPONSE_LOST: ({ options }) => m.source_change_response_lost({}, options),
  SOURCE_CHANGE_RELOAD_FAILED: ({ options }) => m.source_change_reload_failed({}, options),
  CREATE_ALL_SAVE_FAILED: ({ options }) => m.create_all_save_failed({}, options),
  CREATE_ALL_RELOAD_FAILED: ({ options }) => m.create_all_reload_failed({}, options),
  REDIRECT_LOAD_FAILED: withStatus(m.redirect_load_failed, m.redirect_load_failed_status),
  REDIRECT_SAVE_FAILED: withStatus(m.redirect_save_failed, m.redirect_save_failed_status),
  REDIRECT_DELETE_FAILED: withStatus(m.redirect_delete_failed, m.redirect_delete_failed_status),
  REDIRECT_FROM_REQUIRED: ({ options }) => m.redirect_validation_from_required({}, options),
  REDIRECT_FROM_ABSOLUTE: ({ options }) => m.redirect_validation_from_absolute({}, options),
  REDIRECT_FROM_SLASH: ({ message, options }) =>
    m.redirect_validation_from_slash({ suggestion: message.suggestion ?? '/' }, options),
  REDIRECT_FROM_WHITESPACE: ({ options }) => m.redirect_validation_from_whitespace({}, options),
  REDIRECT_TO_REQUIRED: ({ options }) => m.redirect_validation_to_required({}, options),
  REDIRECT_TO_WHITESPACE: ({ options }) => m.redirect_validation_to_whitespace({}, options),
  REDIRECT_TO_INVALID: ({ message, options }) =>
    m.redirect_validation_to_invalid({ suggestion: message.suggestion ?? '/' }, options),
  REDIRECT_SAME_ADDRESS: ({ options }) => m.redirect_validation_same({}, options),
  REDIRECT_SHADOWS_PAGE: ({ message, options }) =>
    m.redirect_validation_shadows({ page: message.page ?? '' }, options),
  REDIRECT_FROM_EXISTS: ({ options }) => m.redirect_validation_exists({}, options),
  PUBLISH_SAVE_FAILED: ({ options }) => m.publish_save_failed({}, options),
  PUBLISH_CHECKS_BLOCKED: ({ options }) => m.publish_checks_blocked({}, options),
  PUBLISH_RESPONSE_LOST: ({ options }) => m.publish_response_lost({}, options),
  PUBLISH_ENTRY_RESPONSE_LOST: ({ options }) => m.publish_entry_response_lost({}, options),
  PUBLISH_RELOAD_FAILED: ({ options }) => m.publish_reload_failed({}, options),
  PUBLISH_ENTRY_RELOAD_FAILED: ({ options }) => m.publish_entry_reload_failed({}, options),
  PUBLISH_FAILED: withStatus(m.publish_failed, m.publish_failed_status),
  PUBLISH_ENTRY_INCOMPLETE: ({ options }) => m.publish_entry_incomplete({}, options),
  PUBLISH_ENTRY_DRIFT: ({ options }) => m.publish_entry_drift({}, options),
  PENDING_DISCARD_SAVE_FAILED: ({ options }) => m.pending_discard_save_failed({}, options),
  PENDING_DISCARD_UNCONFIRMED: ({ options }) => m.pending_discard_unconfirmed({}, options),
  PENDING_DISCARD_REMOTE_CHANGED: ({ options }) => m.pending_discard_remote_changed({}, options),
  PENDING_DISCARD_FAILED: ({ message, options }) =>
    m.pending_discard_failed({ status: message.status ?? 0 }, options),
  PENDING_DIFF_FAILED: ({ message, options }) =>
    m.pending_diff_failed({ page: message.page ?? '', status: message.status ?? 0 }, options),
  HISTORY_LOAD_FAILED: withStatus(m.history_load_failed, m.history_load_failed_status),
  HISTORY_DIFF_FAILED: ({ options }) => m.history_diff_failed({}, options),
  HISTORY_RESTORE_SAVE_FAILED: ({ options }) => m.history_restore_save_failed({}, options),
  HISTORY_RESTORE_UNCONFIRMED: ({ options }) => m.history_restore_unconfirmed({}, options),
  HISTORY_RESTORE_RELOAD_FAILED: ({ options }) => m.history_restore_reload_failed({}, options),
  HISTORY_RESTORE_FAILED: withStatus(m.history_restore_failed, m.history_restore_failed_status),
  CONFLICT_LOAD_FAILED: withStatus(m.conflict_load_failed, m.conflict_load_failed_status),
  CONFLICT_SAVE_FAILED: ({ options }) => m.conflict_save_failed({}, options),
  CONFLICT_UNCONFIRMED: ({ options }) => m.conflict_unconfirmed({}, options),
  CONFLICT_RESOLVE_FAILED: withStatus(m.conflict_resolve_failed, m.conflict_resolve_failed_status),
  TRANSLATION_FAILED: withStatus(m.translation_failed, m.translation_failed_status),
  TRANSLATION_UNCONFIRMED: ({ options }) => m.translation_unconfirmed({}, options),
  TRANSLATION_STALE: ({ options }) => m.translation_stale({}, options),
  TRANSLATION_CREATE_FAILED: withStatus(
    m.translation_create_failed,
    m.translation_create_failed_status,
  ),
  TRANSLATION_CREATE_UNCONFIRMED: ({ options }) => m.translation_create_unconfirmed({}, options),
  TRANSLATION_CREATED_FILL_FAILED: ({ options }) => m.translation_created_fill_failed({}, options),
  TRANSLATION_CREATED_FILL_UNCONFIRMED: ({ options }) =>
    m.translation_created_fill_unconfirmed({}, options),
  MEDIA_UPLOAD_DECLARATION_FAILED: withStatus(
    m.media_upload_declaration_failed,
    m.media_upload_declaration_failed_status,
  ),
  MEDIA_UPLOAD_DECLARATION_UNCONFIRMED: ({ options }) =>
    m.media_upload_declaration_unconfirmed({}, options),
  MEDIA_UPLOAD_DECLARATION_INVALID: ({ options }) =>
    m.media_upload_declaration_invalid({}, options),
  MEDIA_UPLOAD_BUCKET_FAILED: withStatus(
    m.media_upload_bucket_failed,
    m.media_upload_bucket_failed_status,
  ),
  MEDIA_UPLOAD_BUCKET_UNCONFIRMED: ({ options }) => m.media_upload_bucket_unconfirmed({}, options),
  MEDIA_UPLOAD_CONFIRMATION_FAILED: withStatus(
    m.media_upload_confirmation_failed,
    m.media_upload_confirmation_failed_status,
  ),
  MEDIA_UPLOAD_CONFIRMATION_UNCONFIRMED: ({ options }) =>
    m.media_upload_confirmation_unconfirmed({}, options),
  MEDIA_UPLOAD_CONFIRMATION_INVALID: ({ options }) =>
    m.media_upload_confirmation_invalid({}, options),
  MEDIA_UPLOAD_NORMALIZATION_FAILED: ({ options }) =>
    m.media_upload_normalization_failed({}, options),
  MEDIA_UPLOAD_FAILED: ({ options }) => m.media_upload_failed({}, options),
  MEDIA_LIBRARY_READ_FAILED: withStatus(
    m.media_library_read_failed,
    m.media_library_read_failed_status,
  ),
  MEDIA_LIBRARY_READ_INVALID: ({ options }) => m.media_library_read_invalid({}, options),
  MEDIA_METADATA_FAILED: withStatus(
    m.media_library_metadata_failed,
    m.media_library_metadata_failed_status,
  ),
  MEDIA_METADATA_UNCONFIRMED: ({ options }) => m.media_library_metadata_unconfirmed({}, options),
  CANVAS_NO_PAGE: ({ options }) => m.canvas_failure_no_page({}, options),
  CANVAS_DRAFT_UNRENDERABLE: ({ options }) => m.canvas_failure_draft_unrenderable({}, options),
  CANVAS_LOADER_MISSING: ({ options }) => m.canvas_failure_loader_missing({}, options),
  CANVAS_POST_FAILED: ({ options }) => m.canvas_failure_post({}, options),
  MEDIA_DELETE_FAILED: withStatus(
    m.media_library_delete_failed,
    m.media_library_delete_failed_status,
  ),
  MEDIA_DELETE_UNCONFIRMED: ({ options }) => m.media_library_delete_unconfirmed({}, options),
  MEDIA_DELETE_INVALID: ({ options }) => m.media_library_delete_invalid({}, options),
  CROP_SOURCE_FAILED: withStatus(m.crop_source_failed, m.crop_source_failed_status),
  CROP_RENDER_FAILED: ({ options }) => m.crop_render_failed({}, options),
  CROP_FAILED: ({ options }) => m.crop_failed({}, options),
};

const TEXT = { ...SERVER_TEXT, ...LOCAL_TEXT };

export function holderText(message: Pick<UiMessage, 'holder'>, locale: UiLocale): string {
  const options = messageOptions(locale);
  if (message.holder === null) return m.editor_lock_held_anonymous({}, options);
  if (message.holder !== undefined)
    return m.editor_lock_held_by({ holder: message.holder }, options);
  return '';
}

export function messageText(message: UiMessage, locale: UiLocale): string {
  const validation = validationText(message, locale);
  const options = messageOptions(locale);
  const render = Object.hasOwn(TEXT, message.code) ? TEXT[message.code] : undefined;
  const text =
    validation ||
    (render ? render({ message, locale, options }) : m.common_unknown_error({}, options));
  const holder = holderText(message, locale);
  return holder ? `${text} ${holder}` : text;
}

export function messageDetail(message: Pick<UiMessage, 'detail'>, locale: UiLocale) {
  return message.detail
    ? m.common_technical_detail({ detail: message.detail }, messageOptions(locale))
    : '';
}

/** A descriptor marks Handover-owned validation; unmarked schema prose stays authored. */
export function problemText(problem: UiProblem, locale: UiLocale): string {
  return (problem.descriptor && validationText(problem.descriptor, locale)) ?? problem.message;
}
