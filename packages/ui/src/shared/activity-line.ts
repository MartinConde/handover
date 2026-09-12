import type { ActivityEvent } from '@handover/core';

/** Both screens that draw the log share these sentences, so they never disagree. */

// The only subject shape that is somewhere to go: an id on screen tells nobody anything.
export const ENTRY = /^src\/content\/([\w-]+)\/([\w-]+)\/([\w-]+)\.yaml$/;
const entryOf = (subject: string | null) => {
  const found = subject?.match(ENTRY);
  if (!found) return undefined;
  const [, collection = '', locale = '', name = ''] = found;
  // A global is edited at its own address, not under a collection.
  const href = collection === 'globals' ? `/admin/site/${name}` : `/admin/c/${collection}/${name}`;
  return { href, label: name, locale };
};

/** `detail` is small json; every read is of one named key, never the blob. */
const str = (detail: unknown, key: string): string | undefined => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
};

const METHOD: Record<string, string> = {
  password: 'with a password',
  link: 'with an email link',
  github: 'through GitHub',
};
const ROLES: Record<string, string> = { owner: 'an owner', editor: 'an editor' };
const HOW: Record<string, string> = {
  first: 'set their first password',
  changed: 'changed their password',
  reset: 'reset their password',
};
/** The two keys a client owns, as the settings screen names them, and what can happen to one. */
const INTEGRATIONS: Record<string, string> = {
  deepl: 'DeepL key',
  assist: 'writing help key',
};
const HOW_KEY: Record<string, string> = { set: 'set', replaced: 'replaced', removed: 'removed' };
const MESSAGE: Record<string, string> = {
  'sign-in link': 'A sign-in link',
  invite: 'An invite',
  'password reset': 'A password reset',
};

export const who = (event: ActivityEvent) =>
  event.user ? event.user.name || event.user.email || 'A removed member' : 'System';
/** The subject is a member id; the owner's member list or the written name gives it a name. */
const named = (id: string | null, people: Person[], written?: string) => {
  const found = people.find((p) => p.id === id);
  return found ? found.name || found.email : written || 'a member';
};

/** Whoever this admin knows about, which only an owner is given: an editor names nobody. */
export interface Person {
  id: string;
  name: string;
  email: string;
}

export interface Said {
  lead: string;
  link?: { href: string; label: string; locale: string };
  /** Why a publish was not made; the row opens on it, the way a publish row opens on its diff. */
  reason?: string;
}

const REFUSED: Record<string, string> = {
  'ref-moved':
    'Another change reached the repository first. Nothing was written, and publishing again writes on top of it.',
  refused: 'The repository would not take the commit. Nothing was written.',
};
const changed = (files: number) =>
  files === 1
    ? 'That file had changed in the repository after it was opened. Nothing was written: discard the draft in the pending-changes drawer, then publish again.'
    : `${files} files had changed in the repository after they were opened. Nothing was written: discard those drafts in the pending-changes drawer, then publish again.`;
/** How many files a Publishing event was about, as its route wrote it down. */
const count = (detail: unknown, key: 'files' | 'done' = 'files'): number => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' ? value : 0;
};
/** The languages a removal took away, as the row that would put them back names them. */
const went = (detail: unknown): string => {
  const value = (detail as { locales?: unknown } | null | undefined)?.locales;
  return Array.isArray(value) ? value.map((l) => String(l).toUpperCase()).join(', ') : '';
};

/** What each cron job did, in the words of the screen it did it to. */
const JOB_DID: Record<string, (n: number) => string> = {
  reconcile: (n) =>
    `The hourly media check recorded ${n} upload${n === 1 ? '' : 's'} the library had missed.`,
  retention: (n) =>
    `The daily clean-up removed ${n} activity row${n === 1 ? '' : 's'} older than 180 days.`,
  orphans: (n) =>
    `The daily clean-up discarded ${n} draft${n === 1 ? '' : 's'} whose file is no longer in the repository.`,
  hidden: (n) =>
    `The daily hidden-page check found ${n} page${n === 1 ? '' : 's'} hidden for more than 90 days.`,
};
const JOB_NAME: Record<string, string> = {
  reconcile: 'hourly media check',
  retention: 'daily activity clean-up',
  orphans: 'daily draft clean-up',
  hidden: 'daily hidden-page check',
};

export function said(event: ActivityEvent, people: Person[] = []): Said {
  const actor = who(event);
  const d = event.detail;
  if (event.kind.startsWith('cron-')) {
    const job = event.kind.slice('cron-'.length);
    const failed = str(d, 'error');
    if (failed) return { lead: `The ${JOB_NAME[job] ?? `${job} job`} failed: ${failed}.` };
    const n = count(d, 'done');
    return {
      lead: JOB_DID[job]?.(n) ?? `The ${job} job ran and did ${n} thing${n === 1 ? '' : 's'}.`,
    };
  }
  switch (event.kind) {
    case 'login': {
      const how = METHOD[str(d, 'method') ?? ''];
      return { lead: how ? `${actor} signed in ${how}.` : `${actor} signed in.` };
    }
    case 'invite':
      return {
        lead: `${actor} invited ${str(d, 'email') ?? 'somebody'} as ${ROLES[str(d, 'role') ?? ''] ?? 'a member'}.`,
      };
    case 'role-change':
      return {
        lead: `${actor} made ${named(event.subject, people, str(d, 'name'))} ${ROLES[str(d, 'role') ?? ''] ?? 'a member'}.`,
      };
    case 'member-removed': {
      const address = str(d, 'email') ?? 'somebody';
      return {
        lead: (d as { pending?: unknown } | null)?.pending
          ? `${actor} revoked the invite to ${address}.`
          : `${actor} removed ${address}.`,
      };
    }
    case 'password-set':
      return { lead: `${actor} ${HOW[str(d, 'how') ?? ''] ?? 'set their password'}.` };
    case 'publish': {
      const one = entryOf(event.subject);
      if (one) return { lead: `${actor} published `, link: one };
      const files = (d as { files?: unknown } | null)?.files;
      const many =
        typeof files === 'number' ? `${files} file${files === 1 ? '' : 's'}` : 'several files';
      return { lead: `${actor} published ${many}.` };
    }
    case 'publish-failed':
      return {
        lead: 'Publish failed: the repository refused the update.',
        reason: REFUSED[str(d, 'reason') ?? ''] ?? REFUSED.refused,
      };
    case 'publish-conflict': {
      const one = entryOf(event.subject);
      const files = count(d);
      return {
        lead: one
          ? 'Publish stopped: somebody else had changed '
          : `Publish stopped: ${files} files had changed in the repository.`,
        link: one,
        reason: changed(one ? 1 : files),
      };
    }
    case 'draft-discard': {
      // One kind, two writers: the drawer's Discard, and a version restored over the draft.
      const one = entryOf(event.subject);
      const lead = (d as { restore?: unknown } | null)?.restore
        ? `${actor} restored an older version over the unpublished changes to `
        : `${actor} discarded the unpublished changes to `;
      return one ? { lead, link: one } : { lead: `${lead}an entry.` };
    }
    case 'hold-released': {
      const one = entryOf(event.subject);
      const from = str(d, 'from');
      const whose = from ? `${from}'s hold` : 'the hold';
      return one
        ? { lead: `${actor} released ${whose} on `, link: one }
        : { lead: `${actor} released ${whose}.` };
    }
    case 'lock-takeover': {
      const one = entryOf(event.subject);
      const from = str(d, 'from');
      const whose = from ? `${from}'s editing of ` : 'editing of ';
      return one
        ? { lead: `${actor} took over ${whose}`, link: one }
        : { lead: `${actor} took over an entry.` };
    }
    case 'setting-changed': {
      // The log holds the key name and what happened, never the value.
      const did = HOW_KEY[str(d, 'how') ?? ''] ?? 'changed';
      const key = INTEGRATIONS[event.subject ?? ''];
      return { lead: key ? `${actor} ${did} the ${key}.` : `${actor} ${did} a key.` };
    }
    // Both rows link the entry as it is now, which is the one that is somewhere to go.
    case 'entry-rename': {
      const one = entryOf(event.subject);
      const from = str(d, 'from') ?? 'an entry';
      return one
        ? { lead: `${actor} renamed ${from} to `, link: one }
        : { lead: `${actor} renamed ${from}.` };
    }
    case 'entry-duplicate': {
      const one = entryOf(event.subject);
      const from = str(d, 'from') ?? 'an entry';
      return one
        ? { lead: `${actor} duplicated ${from} as `, link: one }
        : { lead: `${actor} duplicated ${from}.` };
    }
    case 'template-saved': {
      const one = entryOf(event.subject);
      const name = str(d, 'template') ?? 'a template';
      return one
        ? { lead: `${actor} saved the template ${name} from `, link: one }
        : { lead: `${actor} saved the template ${name}.` };
    }
    case 'entry-delete': {
      // Named, not linked: a row pointing at a 404 is worse than the file name.
      const gone = entryOf(event.subject);
      const langs = went(d);
      return {
        lead: `${actor} deleted ${gone?.label ?? 'an entry'}${langs ? ` (${langs})` : ''}.`,
      };
    }
    case 'locale-off': {
      const one = entryOf(event.subject);
      const langs = went(d) || 'a language';
      return one
        ? { lead: `${actor} turned ${langs} off for `, link: one }
        : { lead: `${actor} turned ${langs} off for an entry.` };
    }
    case 'revert': {
      // Both are the same inverse commit; only the detail tells them apart.
      const one = entryOf(event.subject);
      if (!(d as { restore?: unknown } | null)?.restore)
        return { lead: `${actor} undid a publish.` };
      return one
        ? { lead: `${actor} restored `, link: one }
        : { lead: `${actor} restored ${count(d)} files.` };
    }
    case 'upload':
      return { lead: `${actor} uploaded ${str(d, 'name') ?? 'a file'}.` };
    case 'media-archive': {
      const what = str(d, 'name') ?? 'a file';
      return {
        lead: (d as { archived?: unknown } | null)?.archived
          ? `${actor} archived ${what}.`
          : `${actor} took ${what} out of the archive.`,
      };
    }
    case 'media-delete':
      return { lead: `${actor} deleted ${str(d, 'name') ?? 'a file'} from storage.` };
    // A rule is named by the address it covers, the half a client recognises.
    case 'redirect-added':
      return { lead: `${actor} added a redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'redirect-changed':
      return { lead: `${actor} changed the redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'redirect-deleted':
      return { lead: `${actor} deleted the redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'mail-failed':
      return { lead: `${MESSAGE[str(d, 'message') ?? ''] ?? 'A message'} could not be sent.` };
  }
  // A kind with no sentence yet is still a record, so it is named rather than dropped.
  const one = entryOf(event.subject);
  return { lead: one ? `${actor} — ${event.kind} ` : `${actor} — ${event.kind}`, link: one };
}

export const initials = (event: ActivityEvent) =>
  (event.user?.name || event.user?.email || '')
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const EXACT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' });
const midnight = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** Day buckets count from local midnight: a day is 23 or 25 hours across a DST change. */
export function when(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return DATE.format(at);
}

/** Same calendar days as `when`; nothing on the day it was set. */
export function age(since: number): string {
  const days = Math.round((midnight(Date.now()) - midnight(since)) / 86_400_000);
  return days < 1 ? '' : days === 1 ? '1 day' : `${days} days`;
}
