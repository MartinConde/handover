import type { ActivityEvent } from '@handover/core';

/**
 * One activity row as a sentence. Both screens that draw the log — the full one and the
 * dashboard's tile — say the same thing about the same event, so what a row *reads as* lives
 * here and each screen writes only its own markup around it.
 */

// `src/content/<collection>/<locale>/<slug>.yaml` — the only subject shape that is somewhere to
// go. A user id or a media id is a key, and a key on screen tells nobody anything.
export const ENTRY = /^src\/content\/([\w-]+)\/([\w-]+)\/([\w-]+)\.yaml$/;
const entryOf = (subject: string | null) => {
  const found = subject?.match(ENTRY);
  if (!found) return undefined;
  const [, collection = '', locale = '', name = ''] = found;
  // A global is edited at its own address rather than under a collection, which is where every
  // other link to one on every other screen goes.
  const href = collection === 'globals' ? `/admin/site/${name}` : `/admin/c/${collection}/${name}`;
  return { href, label: name, locale };
};

/** `detail` is small json written by whichever route caused the event, so every read of it is a
    read of one named key and never of the blob. */
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
/** The subject of an Accounts event is a member id; the list an owner already has gives it a name. */
// The member list first, where the screen has one; then the name the row was written with, so
// the dashboard and an editor's own view name people too; a row with neither says nothing.
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
  /** Why a publish was not made. The one kind of row that expands, until 3.19 draws the diff. */
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
};
const JOB_NAME: Record<string, string> = {
  reconcile: 'hourly media check',
  retention: 'daily activity clean-up',
  orphans: 'daily draft clean-up',
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
      // The log holds the name of the key and what happened to it, never the value, so the row
      // has nothing else to say. An unknown key is still a record of a change.
      const did = HOW_KEY[str(d, 'how') ?? ''] ?? 'changed';
      const key = INTEGRATIONS[event.subject ?? ''];
      return { lead: key ? `${actor} ${did} the ${key}.` : `${actor} ${did} a key.` };
    }
    case 'entry-delete': {
      // Named rather than linked: the entry is gone, and a row pointing at a page that answers
      // 404 is worse than the file name on its own.
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
      // Both are the same inverse commit, so the detail is what tells them apart: one takes a
      // publish back, the other puts a delete back.
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
    // A rule is named by the address it covers, which is the half a client recognises; where it
    // sends them is the other column of the screen it was written on.
    case 'redirect-added':
      return { lead: `${actor} added a redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'redirect-changed':
      return { lead: `${actor} changed the redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'redirect-deleted':
      return { lead: `${actor} deleted the redirect from ${str(d, 'from') ?? 'an address'}.` };
    case 'mail-failed':
      return { lead: `${MESSAGE[str(d, 'message') ?? ''] ?? 'A message'} could not be sent.` };
  }
  // Later kinds arrive without opening this file. A row whose sentence nobody has written is
  // still a record of something, so it names the kind rather than throwing or vanishing.
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

/**
 * A week is where a distance stops being an answer: "1 week ago" is not something an audit can
 * be read off, so anything older is its date. The day buckets count calendar days from local
 * midnight rather than dividing elapsed milliseconds, because a day is 23 or 25 hours across a
 * daylight-saving change — 2026-03-29 02:00 local is 25 hours after 2026-03-28 01:00 here.
 */
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
