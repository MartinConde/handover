import { type ActivityEvent, type ActivityGroup, activityGroupOf } from '@handover/core';
import { formatRelativeTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

/** Both screens that draw the log share these sentences, so they never disagree. */
export const ENTRY = /^src\/content\/([\w-]+)\/([\w-]+)\/([\w-]+)\.yaml$/;
const entryOf = (subject: string | null) => {
  const found = subject?.match(ENTRY);
  if (!found) return undefined;
  const [, collection = '', locale = '', name = ''] = found;
  const href = collection === 'globals' ? `/admin/site/${name}` : `/admin/c/${collection}/${name}`;
  return { href, label: name, locale };
};

const str = (detail: unknown, key: string): string | undefined => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
};

export const who = (event: ActivityEvent, locale: UiLocale = 'en') =>
  event.user
    ? event.user.name || event.user.email || m.activity_actor_removed({}, messageOptions(locale))
    : m.activity_actor_system({}, messageOptions(locale));

const named = (
  id: string | null,
  people: Person[],
  written: string | undefined,
  locale: UiLocale,
) => {
  const found = people.find((person) => person.id === id);
  return found
    ? found.name || found.email
    : written || m.activity_actor_member({}, messageOptions(locale));
};

export interface Person {
  id: string;
  name: string;
  email: string;
}

export interface Said {
  lead: string;
  link?: { href: string; label: string; locale: string };
  tail?: string;
  reason?: string;
}

// Each catalog owns a complete sentence. This marker lets its grammar place the linked entry.
const SUBJECT_MARKER = '\ue000activity-entry\ue001';
const linked = (sentence: string, link: NonNullable<Said['link']>): Said => {
  const at = sentence.indexOf(SUBJECT_MARKER);
  if (at < 0) return { lead: `${sentence} `, link };
  return { lead: sentence.slice(0, at), link, tail: sentence.slice(at + SUBJECT_MARKER.length) };
};

const count = (detail: unknown, key: 'files' | 'done' = 'files'): number => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' ? value : 0;
};

/** Language codes identify stored files, so presentation changes case but never translates them. */
const went = (detail: unknown): string => {
  const value = (detail as { locales?: unknown } | null | undefined)?.locales;
  return Array.isArray(value) ? value.map((locale) => String(locale).toUpperCase()).join(', ') : '';
};

export function activityGroupLabel(kind: string, locale: UiLocale = 'en'): string | undefined {
  const options = messageOptions(locale);
  const group = activityGroupOf(kind);
  const labels: Record<ActivityGroup, string> = {
    Accounts: m.activity_group_accounts({}, options),
    Publishing: m.activity_group_publishing({}, options),
    Entries: m.activity_group_entries({}, options),
    Media: m.activity_group_media({}, options),
    Site: m.activity_group_site({}, options),
    Settings: m.activity_group_settings({}, options),
    System: m.activity_group_system({}, options),
  };
  return group ? labels[group] : undefined;
}

export function said(event: ActivityEvent, people: Person[] = [], locale: UiLocale = 'en'): Said {
  const options = messageOptions(locale);
  const actor = who(event, locale);
  const detail = event.detail;

  if (event.kind.startsWith('cron-')) {
    const job = event.kind.slice('cron-'.length);
    const failed = str(detail, 'error');
    if (failed) {
      const known = {
        reconcile: m.activity_cron_reconcile_failed,
        retention: m.activity_cron_retention_failed,
        orphans: m.activity_cron_orphans_failed,
        hidden: m.activity_cron_hidden_failed,
      }[job];
      return {
        lead: known
          ? known({ error: failed }, options)
          : m.activity_cron_unknown_failed({ job, error: failed }, options),
      };
    }
    const done = count(detail, 'done');
    const known = {
      reconcile: m.activity_cron_reconcile,
      retention: m.activity_cron_retention,
      orphans: m.activity_cron_orphans,
      hidden: m.activity_cron_hidden,
    }[job];
    return {
      lead: known
        ? known({ count: done }, options)
        : m.activity_cron_unknown({ job, count: done }, options),
    };
  }

  switch (event.kind) {
    case 'login': {
      const message = {
        password: m.activity_login_password,
        link: m.activity_login_link,
        github: m.activity_login_github,
      }[str(detail, 'method') ?? ''];
      return { lead: (message ?? m.activity_login)({ actor }, options) };
    }
    case 'invite': {
      const email = str(detail, 'email') ?? m.activity_actor_somebody({}, options);
      const message = {
        owner: m.activity_invite_owner,
        editor: m.activity_invite_editor,
      }[str(detail, 'role') ?? ''];
      return { lead: (message ?? m.activity_invite_member)({ actor, email }, options) };
    }
    case 'role-change': {
      const member = named(event.subject, people, str(detail, 'name'), locale);
      const message = {
        owner: m.activity_role_owner,
        editor: m.activity_role_editor,
      }[str(detail, 'role') ?? ''];
      return { lead: (message ?? m.activity_role_member)({ actor, member }, options) };
    }
    case 'member-removed': {
      const email = str(detail, 'email') ?? m.activity_actor_somebody({}, options);
      return {
        lead: (detail as { pending?: unknown } | null)?.pending
          ? m.activity_invite_revoked({ actor, email }, options)
          : m.activity_member_removed({ actor, email }, options),
      };
    }
    case 'password-set': {
      const message = {
        first: m.activity_password_first,
        changed: m.activity_password_changed,
        reset: m.activity_password_reset,
      }[str(detail, 'how') ?? ''];
      return { lead: (message ?? m.activity_password_set)({ actor }, options) };
    }
    case 'publish': {
      const one = entryOf(event.subject);
      if (one)
        return linked(m.activity_publish_entry({ actor, entry: SUBJECT_MARKER }, options), one);
      const files = (detail as { files?: unknown } | null)?.files;
      return {
        lead:
          typeof files === 'number'
            ? m.activity_publish_files({ actor, count: files }, options)
            : m.activity_publish_several({ actor }, options),
      };
    }
    case 'publish-failed':
      return {
        lead: m.activity_publish_failed({}, options),
        reason:
          str(detail, 'reason') === 'ref-moved'
            ? m.activity_publish_ref_moved({}, options)
            : m.activity_publish_refused({}, options),
      };
    case 'publish-conflict': {
      const one = entryOf(event.subject);
      const files = one ? 1 : count(detail);
      return {
        ...(one
          ? linked(m.activity_publish_conflict_entry({ entry: SUBJECT_MARKER }, options), one)
          : { lead: m.activity_publish_conflict_files({ count: files }, options) }),
        reason: m.activity_publish_conflict_reason({ count: files }, options),
      };
    }
    case 'draft-discard': {
      const one = entryOf(event.subject);
      const restore = Boolean((detail as { restore?: unknown } | null)?.restore);
      if (!one)
        return {
          lead: restore
            ? m.activity_draft_restored_unknown({ actor }, options)
            : m.activity_draft_discarded_unknown({ actor }, options),
        };
      return linked(
        restore
          ? m.activity_draft_restored({ actor, entry: SUBJECT_MARKER }, options)
          : m.activity_draft_discarded({ actor, entry: SUBJECT_MARKER }, options),
        one,
      );
    }
    case 'hold-released': {
      const one = entryOf(event.subject);
      const from = str(detail, 'from');
      if (!one)
        return {
          lead: from
            ? m.activity_hold_released_named_unknown({ actor, from }, options)
            : m.activity_hold_released_unknown({ actor }, options),
        };
      return linked(
        from
          ? m.activity_hold_released_named({ actor, from, entry: SUBJECT_MARKER }, options)
          : m.activity_hold_released({ actor, entry: SUBJECT_MARKER }, options),
        one,
      );
    }
    case 'lock-takeover': {
      const one = entryOf(event.subject);
      const from = str(detail, 'from');
      if (!one) return { lead: m.activity_lock_takeover_unknown({ actor }, options) };
      return linked(
        from
          ? m.activity_lock_takeover_named({ actor, from, entry: SUBJECT_MARKER }, options)
          : m.activity_lock_takeover({ actor, entry: SUBJECT_MARKER }, options),
        one,
      );
    }
    case 'setting-changed': {
      const key =
        event.subject === 'deepl' ? 'deepl' : event.subject === 'assist' ? 'assist' : 'key';
      const action = str(detail, 'how');
      const messages = {
        set: {
          deepl: m.activity_setting_deepl_set,
          assist: m.activity_setting_assist_set,
          key: m.activity_setting_key_set,
        },
        replaced: {
          deepl: m.activity_setting_deepl_replaced,
          assist: m.activity_setting_assist_replaced,
          key: m.activity_setting_key_replaced,
        },
        removed: {
          deepl: m.activity_setting_deepl_removed,
          assist: m.activity_setting_assist_removed,
          key: m.activity_setting_key_removed,
        },
      } as const;
      return {
        lead:
          action === 'set' || action === 'replaced' || action === 'removed'
            ? messages[action][key]({ actor }, options)
            : m.activity_setting_key_changed({ actor }, options),
      };
    }
    case 'entry-rename': {
      const one = entryOf(event.subject);
      const from = str(detail, 'from') ?? m.activity_entry_unknown({}, options);
      return one
        ? linked(m.activity_entry_renamed({ actor, from, entry: SUBJECT_MARKER }, options), one)
        : { lead: m.activity_entry_renamed_unknown({ actor, from }, options) };
    }
    case 'entry-duplicate': {
      const one = entryOf(event.subject);
      const from = str(detail, 'from') ?? m.activity_entry_unknown({}, options);
      return one
        ? linked(m.activity_entry_duplicated({ actor, from, entry: SUBJECT_MARKER }, options), one)
        : { lead: m.activity_entry_duplicated_unknown({ actor, from }, options) };
    }
    case 'template-saved': {
      const one = entryOf(event.subject);
      const template = str(detail, 'template') ?? m.activity_template_unknown({}, options);
      return one
        ? linked(
            m.activity_template_saved({ actor, template, entry: SUBJECT_MARKER }, options),
            one,
          )
        : { lead: m.activity_template_saved_unknown({ actor, template }, options) };
    }
    case 'entry-delete': {
      const entry = entryOf(event.subject)?.label ?? m.activity_entry_unknown({}, options);
      const locales = went(detail);
      return {
        lead: locales
          ? m.activity_entry_deleted_locales({ actor, entry, locales }, options)
          : m.activity_entry_deleted({ actor, entry }, options),
      };
    }
    case 'locale-off': {
      const one = entryOf(event.subject);
      const locales = went(detail) || m.activity_language_unknown({}, options);
      return one
        ? linked(
            m.activity_locale_disabled({ actor, locales, entry: SUBJECT_MARKER }, options),
            one,
          )
        : { lead: m.activity_locale_disabled_unknown({ actor, locales }, options) };
    }
    case 'revert': {
      if (!(detail as { restore?: unknown } | null)?.restore)
        return { lead: m.activity_publish_undone({ actor }, options) };
      const one = entryOf(event.subject);
      return one
        ? linked(m.activity_entry_restored({ actor, entry: SUBJECT_MARKER }, options), one)
        : { lead: m.activity_files_restored({ actor, count: count(detail) }, options) };
    }
    case 'upload':
      return {
        lead: m.activity_uploaded(
          { actor, name: str(detail, 'name') ?? m.activity_file_unknown({}, options) },
          options,
        ),
      };
    case 'media-archive': {
      const name = str(detail, 'name') ?? m.activity_file_unknown({}, options);
      return {
        lead: (detail as { archived?: unknown } | null)?.archived
          ? m.activity_media_archived({ actor, name }, options)
          : m.activity_media_unarchived({ actor, name }, options),
      };
    }
    case 'media-delete':
      return {
        lead: m.activity_media_deleted(
          { actor, name: str(detail, 'name') ?? m.activity_file_unknown({}, options) },
          options,
        ),
      };
    case 'redirect-added':
      return {
        lead: m.activity_redirect_added(
          { actor, from: str(detail, 'from') ?? m.activity_address_unknown({}, options) },
          options,
        ),
      };
    case 'redirect-changed':
      return {
        lead: m.activity_redirect_changed(
          { actor, from: str(detail, 'from') ?? m.activity_address_unknown({}, options) },
          options,
        ),
      };
    case 'redirect-deleted':
      return {
        lead: m.activity_redirect_deleted(
          { actor, from: str(detail, 'from') ?? m.activity_address_unknown({}, options) },
          options,
        ),
      };
    case 'mail-failed': {
      const message = {
        'sign-in link': m.activity_mail_sign_in_failed,
        invite: m.activity_mail_invite_failed,
        'password reset': m.activity_mail_reset_failed,
      }[str(detail, 'message') ?? ''];
      return { lead: (message ?? m.activity_mail_failed)({}, options) };
    }
  }

  const one = entryOf(event.subject);
  return one
    ? linked(
        m.activity_unknown_entry({ actor, kind: event.kind, entry: SUBJECT_MARKER }, options),
        one,
      )
    : { lead: m.activity_unknown({ actor, kind: event.kind }, options) };
}

export const initials = (event: ActivityEvent) =>
  (event.user?.name || event.user?.email || '')
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

/** Legacy editor acknowledgement; Activity itself always supplies the reactive UI locale. */
export const when = (at: number): string => formatRelativeTime(at, 'en');
