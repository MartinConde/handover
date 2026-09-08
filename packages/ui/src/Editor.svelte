<script lang="ts">
import {
  type Drift,
  entryName,
  entryUrl,
  type Field,
  fieldPosition,
  LOCK_TTL,
  resolveSeo,
  type SeoDefaultsValue,
  syncLocale,
} from '@handover/core';
import { onMount, tick, untrack } from 'svelte';
import { when } from './activity-line';
import CheckLines, { type CheckItem, merged, plural, verdict } from './CheckLines.svelte';
import DriftPanel from './Drift.svelte';
import { createEntrySession } from './entry-session.svelte';
import Fields from './Fields.svelte';
import History from './History.svelte';
import { guardNavigation, navigate } from './navigate';
import OffsiteDialog, { type Target } from './Offsite.svelte';
import PreviewPane from './Preview.svelte';
import { request as fetch, sitePath } from './request.js';
import { classifyDraftSaveRefusal } from './save';
import Translation from './Translation.svelte';

type Data = Record<string, unknown>;
type Problem = { path: string; message: string };
let {
  collection,
  slug,
  entry,
  section = '',
  mediaBase = '',
  preview = false,
  userId = '',
  onchanged,
  onpending,
  onpublished,
  onrestored,
  restored,
  site,
}: {
  collection: string;
  slug: string;
  /** Who is signed in, so a lock held by the same person reads as their other tab. */
  userId?: string;
  /** Where a stored media key is served from; the image and file widgets draw from it. */
  mediaBase?: string;
  /** This build serves `/_preview`: without it the pane says so rather than framing a 404. */
  preview?: boolean;
  entry: {
    fields: readonly Field[];
    blocks: Record<string, Field[]>;
    data: Data;
    revisions?: Record<string, string>;
    /** The languages whose file this entry has a draft ahead of in git. */
    pending: string[];
    /** The languages the repository already has a file for; the rest are only in the preview. */
    published: string[];
    /** Somebody marked it "Not ready yet" — the toggle opens pressed, whoever they were. */
    held?: boolean;
    /** Off the site for every language, since `_status` is shared across the files. */
    hidden?: boolean;
    /** Where each language sends its readers while it is hidden; empty for "nowhere". */
    redirects?: Record<string, string>;
    /** What the collection schema will not accept yet, by field path. */
    problems: { path: string; message: string }[];
    /** The field this collection is keyed on, when it is not `title`. */
    titleField?: string;
    /** The site's own SEO defaults per language; absent for an entry with no `seo` field. */
    seoDefaults?: Record<string, SeoDefaultsValue>;
    /** A global: one file the schema names, so nothing that renames, hides or copies it. */
    singleton?: boolean;
    /** What the dev calls this global — a global has no title field to be named by. */
    label?: string;
    /** The languages the site declares. */
    locales: string[];
    /** The site's default, which is what says whether a language's URLs carry its segment. */
    defaultLocale: string;
    /** The language the structure is edited in and a translation is made from. */
    sourceLocale: string;
    /** The languages it is offered in; the rest are turned off and get no file. */
    offered: string[];
    /** What its own `_locales` says that the files it has contradict — a hand edit or a merge. */
    offerProblems?: string[];
    /** The other languages this entry has a file in, parsed; none where it has no other file. */
    translations: Record<string, Data>;
    /** Which of them were translated from a source language that has moved on since. */
    stale: string[];
    /** The blocks this entry's languages disagree about; publishing waits on these. */
    drift: Drift[];
    /** The site has something to machine-translate with: without one, none of it is offered. */
    translator?: boolean;
    /** This collection serves an address per language; without it the row is not drawn at all. */
    localizedSlugs?: boolean;
    /** The address each language serves this entry at, empty meaning under the file name. */
    addresses?: Record<string, string>;
    /** The collection's own route, which is what an address is a segment of. */
    route?: string;
    /** The page above it, where a language that loses its file sends its readers. */
    index?: string;
    /** Whether the default language's URLs carry its segment. */
    prefixDefaultLocale?: boolean;
  };
  /** Which of the entry's tabs the address is on; empty is the form itself. */
  section?: string;
  /** The site's origin, for the SEO previews; none, and the panel draws none. */
  site?: string;
  /** A file of this entry was made, removed or settled, so the entry has to be read again. */
  onchanged: () => void;
  /** Fires only on the save that flips whether this entry has something to publish. */
  onpending?: () => void;
  /** This entry went out from its header, named the way the shell should say it. */
  onpublished?: (title: string) => void;
  /** A version went into the drafts; the shell remembers its git date past the reload. */
  onrestored?: (date: string) => void;
  /** The date of the version the unpublished changes were restored from, while they wait. */
  restored?: string;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded files seed this opened entry's session
const entryForm = { fields: [...entry.fields], blocks: entry.blocks };
// svelte-ignore state_referenced_locally -- the loaded files seed this opened entry's session
const entrySession = createEntrySession({
  sourceLocale: entry.sourceLocale,
  data: entry.data,
  translations: entry.translations,
  revisions: entry.revisions,
  form: entryForm,
  problems: { [entry.sourceLocale]: entry.problems },
});
const data = $derived(entrySession.snapshot(entry.sourceLocale));
const saveState = $derived(entrySession.saveState(entry.sourceLocale));
const saved = $derived(saveState.saved);
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending.includes(entry.sourceLocale));
const saving = $derived(saveState.phase === 'saving');
const saveFailed = $derived(saveState.phase === 'failed');
let saveError = $state('');
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let held = $state(entry.held === true);
const schemaProblems = $derived(entrySession.positionalProblems(entry.sourceLocale));
/** What the pre-publish checks found over this entry: read when it opens and after every save. */
let checks = $state<CheckItem[]>([]);
// Only check errors block the publish; they name rows by id, so the position is looked up now.
const checkProblems = $derived(
  Object.fromEntries(
    checks
      .filter((c) => c.severity === 'error')
      .flatMap((c) => {
        const at = fieldPosition('default', c.fieldPath, data);
        return at ? [[at.join('.'), c.message]] : [];
      }),
  ),
);
const problems = $derived({ ...checkProblems, ...schemaProblems });
// svelte-ignore state_referenced_locally -- the language the entry is written in is where it opens
let locale = $state(entry.sourceLocale);
let side = $state(false);
// The pane is one thing at a time: the preview, or the second language.
let previewing = $state(false);
let savedAt = $state(0);
let pane = $state<ReturnType<typeof Translation>>();
// Lives here rather than in the column, which is thrown away whenever the screen changes.
let translated = $state(false);

// A site with one language draws none of the language controls.
const many = $derived(entry.locales.length > 1);
const others = $derived(entry.locales.filter((l) => l !== entry.sourceLocale));
// The column beside the source language.
const target = $derived(locale === entry.sourceLocale ? others[0] : locale);
const shown = $derived(side ? target : locale === entry.sourceLocale ? undefined : locale);
// A translation on its own: the switcher is on another language and the second column is shut.
const alone = $derived(!side && shown !== undefined);
// The entry always has the file it was opened on; the others are the ones that can be absent.
const untranslated = (of: string) => of !== entry.sourceLocale && !entrySession.hasSnapshot(of);
// Turned off for this entry: no file is written for it and the site does not offer it.
const off = (of: string) => !entry.offered.includes(of);
let busy = $state(false);

// Both change which files the entry has, so the screen is read again rather than patched.
async function ask(url: string, init: RequestInit = {}) {
  if (!(await flush())) return false;
  busy = true;
  const res = await fetch(url, { method: 'POST', ...init });
  busy = false;
  if (res.ok) onchanged();
  else actionFailed = await res.text();
  return res.ok;
}

/** The turn-off this language can be brought back from, when the CMS is what turned it off. */
let putBack = $state<{ commit_sha: string; at: number }>();
$effect(() => {
  const of = shown;
  putBack = undefined;
  // A global has no languages to turn off, and its collection is not one the route knows.
  if (of && off(of) && !entry.singleton) findRestore(of);
});

async function findRestore(of: string) {
  // A nicety: if the log cannot be asked, the offer is simply not made.
  const res = await fetch(`/admin/api/deleted/${collection}`).catch(() => undefined);
  if (!res?.ok) return;
  const { deleted } = (await res.json()) as {
    deleted: {
      slug: string;
      locales: string[];
      whole: boolean;
      commit_sha: string;
      at: number;
      blocked?: string;
    }[];
  };
  const found = deleted.find(
    (row) => !row.whole && !row.blocked && row.slug === slug && row.locales.includes(of),
  );
  // The answer to a language nobody is looking at any more is not this pane's.
  if (found && of === shown) putBack = found;
}

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const createFrom = (of: string) => ask(`/admin/api/drafts/${collection}/${slug}/${of}`);
// The file has to exist before a machine's draft can be written into it.
async function createFilled(of: string) {
  if (!(await flush())) return;
  busy = true;
  const made = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
  let filled: Response | undefined;
  if (made.ok)
    filled = await fetch(`/admin/api/translate/${collection}/${slug}/${of}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  busy = false;
  if (!made.ok) {
    actionFailed = await made.text();
    return;
  }
  if (!filled?.ok) {
    actionFailed =
      'The language was created, but translation failed. Reload it to retry translation.';
    return;
  }
  onchanged();
}
// Through `act`: a refused turn-off answers with a sentence the screen shows.
async function offer(of: string, on: boolean, redirect?: Target) {
  const res = await act(`/admin/api/entries/${collection}/${slug}/locales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      locales: on
        ? entry.locales.filter((l) => l === of || !off(l))
        : entry.offered.filter((l) => l !== of),
      ...(redirect ? { redirect } : {}),
    }),
  });
  if (res) onchanged();
  return res !== undefined;
}

const json = $derived(JSON.stringify(data));
const missing = $derived(Object.keys(problems));
const named = $derived(data[entry.titleField ?? 'title']);
const title = $derived(entry.label ?? (typeof named === 'string' && named ? named : slug));
// The SEO panel is its own tab, so the Content form omits the field; a global has no tabs.
const seoField = $derived(!entry.singleton && entry.fields.some((f) => f.type === 'seo'));
/** The key the seo field sits under, which is what a problem on it is named by. */
const seoAt = $derived(entry.fields.find((f) => f.type === 'seo')?.path[0]);
const fields = $derived(
  !seoField
    ? entry.fields
    : section === 'seo'
      ? entry.fields.filter((f) => f.type === 'seo')
      : entry.fields.filter((f) => f.type !== 'seo'),
);
/** What one language's page would say with nothing typed: the build's own resolution. */
const inherited = (of: string, values: Data) =>
  entry.fields.some((f) => f.type === 'seo')
    ? resolveSeo(
        undefined,
        entry.seoDefaults?.[of],
        String(values[entry.titleField ?? 'title'] ?? ''),
      )
    : undefined;
// Another language already pending when the entry was read; stands until it is read again.
const elsewhere = $derived(entry.pending.some((l) => l !== entry.sourceLocale));
// The second column is its own file, so an edit only made there is still something to publish.
const dirty = $derived(drafted || elsewhere || translated || entrySession.unsaved());
const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const language = (of: string) => {
  try {
    return LANGUAGES.of(of) ?? of;
  } catch {
    return of;
  }
};

/** The soft lock on every language of this entry at once; `undefined` until the first answer. */
type Lock = {
  held_by: { id: string; name: string | null } | null;
  mine: boolean;
  expires_at: number | null;
};
let lock = $state<Lock>();
// A per-tab token, kept in session storage so a tab that returns to an entry is still itself.
const tab = (() => {
  try {
    const kept = sessionStorage.getItem('handover-tab');
    if (kept) return kept;
    const made = crypto.randomUUID();
    sessionStorage.setItem('handover-tab', made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
})();
// Separate from the lock: the lost and locked banners say different things about the same fact.
let lost = $state(false);
function loseLock(next?: Lock) {
  if (next) lock = next;
  if (lost) return;
  lost = true;
  entrySession.closeSaveGate();
}
let taking = $state(false);
let takePanel = $state<HTMLElement>();
let takeTrigger = $state<HTMLButtonElement>();
$effect(() => {
  if (taking) takePanel?.focus();
});
// Taking over reads the entry again, so only Cancel has a button to give focus back to.
function cancelTake() {
  taking = false;
  takeTrigger?.focus();
}
// When the last answer came back, and when this tab last extended a lock of its own.
let asked = $state(0);
let beatAt = 0;
const locked = $derived(lost || (lock !== undefined && !lock.mine));
const holder = $derived(lock?.held_by?.name || 'Somebody else');
// The holder is this same person, in another tab.
const otherTab = $derived(lock?.held_by?.id !== undefined && lock?.held_by?.id === userId);
// Beats ride on the autosave, so the expiry is the holder's last keystroke plus one lifetime.
const idle = $derived(lock?.expires_at ? asked - (lock.expires_at - LOCK_TTL) : 0);

$effect(() => {
  void beat(true);
});

// The poll only reads; it runs on both sides so a holder hears of a take-over without typing.
$effect(() => {
  if (lost) return;
  const timer = setInterval(() => beat(false), 15000);
  return () => clearInterval(timer);
});
// Coming back to the front means somebody is about to type, so ask now rather than next tick.
const recheck = () => {
  if (lock?.mine && !lost && document.visibilityState === 'visible') void beat(false);
};

let renewing = false;
function renew() {
  if (!lock?.mine || lost || renewing || Date.now() - beatAt < 45000) return;
  if (lock.expires_at !== null && Date.now() >= lock.expires_at) {
    loseLock();
    return;
  }
  renewing = true;
  void beat(true).finally(() => {
    renewing = false;
  });
}
async function beat(claim: boolean) {
  const res = await fetch(
    `/admin/api/locks/${collection}/${slug}${claim ? '' : `?tab=${tab}`}`,
    claim
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tab }),
        }
      : { method: 'GET' },
  ).catch(() => undefined);
  if (!res?.ok) return;
  const had = lock?.mine === true;
  lock = (await res.json()) as Lock;
  asked = Date.now();
  if (lock.mine && claim) beatAt = asked;
  else if (had && !lock.mine) {
    // Expiry and takeover both require a fresh read before this tab can resume editing.
    loseLock();
  }
}

entrySession.configureAutosave((of, snapshot, revision, contentVersion) =>
  of === entry.sourceLocale
    ? writeSourceSave(snapshot, revision, contentVersion)
    : writeTranslationSave(of, snapshot, revision, contentVersion),
);

// The same skeleton sync the server runs for stored siblings, applied to the column on screen.
$effect(() => {
  const column = pane;
  const of = shown;
  if (!column || of === undefined || untranslated(of)) return;
  const after = JSON.parse(json) as Data;
  const form = { fields: [...entry.fields], blocks: entry.blocks };
  column.sync((target) => syncLocale('default', form, of, { before: entry.data, after }, target));
});

// Subscribe only to snapshots; failure-state updates must not schedule another retry.
$effect(() => {
  const dirty = json !== saved;
  untrack(() => {
    if (dirty) renew();
    entrySession.change(entry.sourceLocale);
  });
});

async function writeSourceSave(
  sent: string,
  revision: string | undefined,
  contentVersion: number,
): Promise<boolean> {
  saveError = '';
  try {
    const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: JSON.parse(sent),
        tab,
        revision,
      }),
    });
    if (!res.ok) {
      saveError = 'Your changes are still here. Try saving again before leaving.';
      const refusal = await classifyDraftSaveRefusal(res);
      if (refusal.kind === 'lock') loseLock(refusal.lock);
      else if (refusal.kind === 'revision')
        saveError =
          refusal.error ?? 'This entry changed elsewhere. Copy your unsaved text before reloading.';
      return false;
    }
    const body = (await res.json()) as {
      pending: boolean;
      problems: Problem[];
      revisions?: Record<string, string>;
    };
    entrySession.mergeRevisions(body.revisions);
    savedAt = Date.now();
    renew();
    if (body.pending !== drafted) onpending?.();
    drafted = body.pending;
    entrySession.acceptProblems(entry.sourceLocale, body.problems, sent, contentVersion);
    // The checks read the draft rows, so a save that left nothing pending has nothing to lint.
    if (body.pending) void lint();
    else checks = [];
    return true;
  } catch {
    saveError = 'Your changes are still here. Check your connection and try saving again.';
    return false;
  }
}

async function writeTranslationSave(
  of: string,
  sent: string,
  revision: string | undefined,
  contentVersion: number,
): Promise<boolean> {
  try {
    const res = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: JSON.parse(sent), tab, revision }),
    });
    if (!res.ok) {
      const refusal = await classifyDraftSaveRefusal(res);
      if (refusal.kind === 'lock') loseLock(refusal.lock);
      return false;
    }
    const body = (await res.json()) as {
      pending: boolean;
      problems: Problem[];
      revision?: string;
    };
    if (body.revision) entrySession.setRevision(of, body.revision);
    entrySession.acceptProblems(of, body.problems, sent, contentVersion);
    renew();
    if (body.pending !== translated) onpending?.();
    translated = body.pending;
    savedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

export function flush(): Promise<boolean> {
  return entrySession.flush();
}
const unsaved = () => entrySession.unsaved();
onMount(() => {
  const release = guardNavigation(flush);
  const warn = (event: BeforeUnloadEvent) => {
    if (unsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  addEventListener('beforeunload', warn);
  return () => {
    entrySession.closeSaveGate();
    release();
    removeEventListener('beforeunload', warn);
  };
});

// The entry is read again afterwards: carrying on means loading the shared draft they left.
async function takeOver() {
  busy = true;
  const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ take: true, tab }),
  });
  busy = false;
  if (!res.ok) {
    actionFailed = await res.text();
    return;
  }
  taking = false;
  lock = (await res.json()) as Lock;
  onchanged();
}

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let hidden = $state(entry.hidden === true);
let statusMenu = $state(false);
let hiding = $state(false);
let statusFailed = $state('');

async function setStatus(next: boolean, redirect?: Target) {
  statusMenu = false;
  busy = true;
  statusFailed = '';
  // Everything on screen goes into the rows first: this write rewrites the same files.
  if (!(await flush())) {
    busy = false;
    return;
  }
  const res = await fetch(`/admin/api/status/${collection}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [slug], hidden: next, redirect }),
  });
  busy = false;
  if (!res.ok) {
    statusFailed = await res.text();
    return;
  }
  hidden = next;
  hiding = false;
  onchanged();
}

// A rename navigates to the new name and a delete to the list, so neither refreshes this screen.
let moreMenu = $state(false);
let renaming = $state(false);
let deleting = $state(false);
let newName = $state('');
let actionFailed = $state('');
const willBe = $derived(entryName('default', newName, []));

function openRename() {
  moreMenu = false;
  newName = slug;
  actionFailed = '';
  renaming = true;
}

// A 409 body is the server's own sentence, which reads better than a generic one.
async function act(url: string, init: RequestInit) {
  if (!(await flush())) return undefined;
  busy = true;
  actionFailed = '';
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  actionFailed =
    res.status === 409 || res.status === 503
      ? await res.text()
      : `That did not work (${res.status})`;
  return undefined;
}

async function rename(event: Event) {
  event.preventDefault();
  const res = await act(`/admin/api/entries/${collection}/${slug}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: newName }),
  });
  if (!res) return;
  const { slug: to } = (await res.json()) as { slug: string };
  navigate(`/admin/c/${collection}/${to}`);
}

async function remove(redirect: Target) {
  const res = await act(`/admin/api/entries/${collection}/${slug}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect }),
  });
  if (res) navigate(`/admin/c/${collection}`);
}

// The flag lives on the draft rows, so the form is stored first or the hold outruns the words.
async function toggleHold() {
  const next = !held;
  busy = true;
  if (!(await flush())) {
    busy = false;
    return;
  }
  const res = await fetch(`/admin/api/hold/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hold: next }),
  });
  busy = false;
  if (res.ok) held = ((await res.json()) as { held: unknown }).held === true;
  else actionFailed = await res.text();
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function land(field: HTMLElement | null) {
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}
function focusField(path: readonly string[]) {
  const target = document.getElementById(`f-${path.join('.')}-field`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  const control =
    target.querySelector<HTMLElement>(':scope > details:not([open]) > summary') ??
    target.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"]',
    ) ??
    target.querySelector<HTMLElement>('button:not(:disabled), summary') ??
    target;
  control.focus({ preventScroll: true });
}
// A picture's `src` has no control of its own, so the jump lands on the nearest drawn ancestor.
function drawn(prefix: string, path: string | undefined) {
  const steps = path?.split('.') ?? [];
  for (; steps.length; steps.pop()) {
    const field = document.getElementById(`${prefix}-${steps.join('.')}`);
    if (field) return field;
  }
  return null;
}
function goTo(path: string | undefined) {
  const field = drawn('f', path);
  // A field on the other tab is not on screen: go to that tab, then look for it once only.
  if (!field && path && seoField && path.split('.')[0] === seoAt) {
    navigate(`/admin/c/${collection}/${slug}/seo`);
    void tick().then(() => land(drawn('f', path)));
    return;
  }
  land(field);
}
const goToFirst = () => goTo(missing[0]);

// The drawer's `?field=…&locale=…`: open the column first, then look for the control once drawn.
function fromAddress() {
  const query = new URLSearchParams(location.search);
  const field = query.get('field');
  if (!field) return;
  const of = query.get('locale') || entry.sourceLocale;
  const inColumn = of !== entry.sourceLocale && entry.locales.includes(of) && !untranslated(of);
  if (inColumn && shown !== of) {
    leaving(() => {
      locale = of;
      side = true;
    });
  } else if (!inColumn && alone) {
    leaving(() => {
      locale = entry.sourceLocale;
    });
  }
  const at = fieldPosition('default', field, inColumn ? entrySession.snapshot(of) : data);
  if (!at) return;
  void tick().then(() => land(drawn(inColumn ? 't' : 'f', at.join('.'))));
}
onMount(() => {
  fromAddress();
  // Only a draft gets linted, so an entry with nothing pending is not asked about.
  if (entry.pending.length) void lint();
});

// This entry whole and nothing else; it commits, so it confirms first.
let confirming = $state(false);
let sending = $state(false);
let publishFailed = $state('');
/** The pass could not be run at all — which holds nothing back: it is a lint, not a gate. */
let checksFailed = $state(false);
let pass = 0;
const lines = $derived(merged(checks));
const errors = $derived(lines.filter((c) => c.severity === 'error'));
const warnings = $derived(lines.filter((c) => c.severity === 'warn'));
// Detection only; resolving it is the drawer's job.
let conflicted = $state(false);
let publishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();
$effect(() => {
  if (confirming) publishPanel?.focus();
});

// `drafted` is live for the source language; the rest are as read, plus what the column sent.
const going = $derived(
  entry.locales.filter(
    (of) =>
      (of === entry.sourceLocale ? drafted : entry.pending.includes(of)) ||
      (of === target && translated),
  ),
);

async function askToPublish() {
  if (!(await flush())) return;
  publishFailed = '';
  confirming = true;
  void lint();
}

/** The drawer's lint over this one entry; an answer that never comes holds nothing back. */
async function lint() {
  const key = `${collection}/${slug}`;
  const mine = ++pass;
  const res = await fetch('/admin/api/publish/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [key] }),
  }).catch(() => undefined);
  // The daily hidden check's note about some other page is the drawer's to list, not this entry's.
  const results = (res?.ok && ((await res.json()) as { results?: CheckItem[] }).results) || [];
  // A save since asked again; the older answer would put back what the newer one cleared.
  if (mine !== pass) return;
  checksFailed = !res?.ok;
  checks = results.filter((c) => c.entry === key);
}

function closePublish() {
  confirming = false;
  publishButton?.focus();
}

async function publishEntry() {
  sending = true;
  publishFailed = '';
  // Again on the press: the dialog may have been open a while.
  await lint();
  if (errors.length) {
    sending = false;
    // A disabled button drops the focus that pressed it.
    publishFailed =
      'Nothing was published. The checks found something in the way just now — it is listed above.';
    publishPanel?.focus();
    return;
  }
  const res = await fetch('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [`${collection}/${slug}`] }),
  });
  sending = false;
  if (res.ok) {
    confirming = false;
    onpublished?.(title);
    // The rows are re-seeded on the commit, so the screen is read again rather than patched.
    onchanged();
    return;
  }
  // A repository the App cannot reach is the server's own sentence; nothing else adds to it.
  if (res.status === 503) {
    publishFailed = await res.text();
    return;
  }
  if (res.status === 422) {
    publishFailed =
      'Nothing was published. Something this entry needs is still missing — open each of its languages to see what.';
    return;
  }
  if (res.status === 409) {
    const body = await res.text();
    const parsed = JSON.parse(body.startsWith('{') ? body : '{}') as { reason?: string };
    // Drift has a panel on this screen; a file somebody else changed is handled in the drawer.
    if (parsed.reason !== 'drift') {
      closePublish();
      conflicted = true;
      return;
    }
    publishFailed =
      "Nothing was published. This entry's languages disagree about which blocks it has — the panel on this screen is where that is settled.";
    return;
  }
  publishFailed = `Nothing was published (${res.status}).`;
}

// Keep the pane mounted until all its changes have been saved.
async function leaving(change: () => void) {
  if (unsaved() && !(await flush())) return;
  change();
}

// Unlike a field, an address is validated, unique and owes a redirect when it moves.
let editing = $state(false);
let typed = $state('');
let addressFailed = $state('');
const address = $derived(entry.addresses?.[locale] ?? '');
// A language with no file has no address: the offer to make one stands where the form would be.
const addressable = $derived(
  entry.localizedSlugs === true && (locale === entry.sourceLocale || !untranslated(locale)),
);
const routing = $derived({
  locales: entry.locales,
  defaultLocale: entry.defaultLocale,
  prefixDefaultLocale: entry.prefixDefaultLocale,
});
const url = $derived(entryUrl('default', routing, entry.route, address || slug, locale) ?? '');
// The part in front of the address, so what is being typed reads as the URL it will be.
const before = $derived(entryUrl('default', routing, entry.route, '', locale) ?? '');

// Deletes the file, so it asks where that language's readers go; a refusal stays in the dialog.
let offing = $state<string>();
async function turnOff(of: string, target: Target) {
  if (!(await flush())) return;
  if (await offer(of, false, target)) offing = undefined;
}

// What the Turn-off dialog names; no index when the collection has no page above it.
const localeUrl = (of: string) =>
  entryUrl('default', routing, entry.route, entry.addresses?.[of] || slug, of) ?? undefined;
const localeIndex = (of: string) => entryUrl('default', routing, entry.index, '', of) ?? undefined;

// A collection with no route renders nowhere, so Preview is absent rather than refusing.
const previewable = $derived(Boolean(entry.route));
// A language with no file is an offer to create one, not a page.
const previewLocales = $derived(
  entry.locales
    .filter((of) => of === entry.sourceLocale || !untranslated(of))
    .map((of) => ({ locale: of, label: language(of), url: localeUrl(of) ?? '' })),
);
// Nested paths answer under the top field, which is where the form scrolls to anyway.
const labelOf = (path: string) => {
  const head = path.split('.')[0] ?? path;
  return entry.fields.find((f) => f.path.join('.') === head)?.label ?? head;
};
const previewProblems = $derived(
  missing.map((path) => ({ path, label: labelOf(path), message: problems[path] ?? '' })),
);

function editAddress() {
  typed = address;
  addressFailed = '';
  editing = true;
}

// The screen is read again afterwards so both columns get the address the server settled on.
async function saveAddress() {
  busy = true;
  if (!(await flush())) {
    busy = false;
    return;
  }
  const res = await fetch(`/admin/api/entries/${collection}/${slug}/address/${locale}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: typed.trim() }),
  });
  busy = false;
  if (!res.ok) {
    addressFailed = await res.text();
    return;
  }
  editing = false;
  onchanged();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return;
    if (confirming) closePublish();
    else if (taking) cancelTake();
  }}
  onfocus={recheck}
  onpopstate={fromAddress}
/>
<svelte:document onvisibilitychange={recheck} />

<main class="main main-editor">
  {#if actionFailed && !renaming && !deleting && !offing}<p class="notice notice-danger" role="alert">{actionFailed}</p>{/if}
  {#if saveError}<p class="notice notice-danger" role="alert">{saveError} <button class="btn-link" type="button" onclick={() => flush()}>Retry save</button></p>{/if}
  {#each entry.offerProblems ?? [] as problem (problem)}
    <div class="lock-banner is-offer">
      This entry's file says something its languages contradict — {problem}. Fix it in the
      repository; until then the files are what counts.
    </div>
  {/each}
  {#if lost}
    <!-- Leads with where the work went: the draft is in D1. -->
    <div class="lock-banner is-lost">
      {#if otherTab}
        Your other tab has this entry now. Saved changes are in the shared draft. Any unsaved text remains here; copy it before reloading.
      {:else if !lock?.held_by}
        This editing session expired while idle. Saved changes are in the shared draft. Any unsaved text remains here; copy it before reloading.
      {:else}
        {holder} took over this entry. Saved changes are in the shared draft. Any unsaved text remains here; copy it before reloading.
      {/if}
      <button class="btn-link" type="button" onclick={onchanged}>Reload</button>
    </div>
  {:else if locked}
    <div class="lock-banner">
      {#if otherTab}
        You have this open in another tab
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={() => (taking = true)}>Edit here instead</button>
      {:else if lock?.held_by}
        Being edited by {lock.held_by.name || 'somebody else'}
        <span class="when">
          {idle >= 60000
            ? '— nothing typed for a minute; the lock frees itself after two'
            : '— active a few seconds ago'}
        </span>
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={() => (taking = true)}>Take over</button>
      {:else}
        Nobody is editing this entry any more.
        <button class="btn-link" type="button" onclick={onchanged}>Reload</button>
      {/if}
    </div>
  {/if}
  {#if restored && entry.pending.length}
    <!-- The restore is over by the time this draws, so this is what says what just happened. -->
    <div class="lock-banner" class:is-drift={entry.drift.length > 0} role="status">
      <span>
        <b>Restored the version from {when(Date.parse(restored)).toLowerCase()}.</b>
        {#if entry.drift.length}
          The languages disagree about its blocks since then — decide what to keep, then publish.
        {:else}
          It is here as unpublished changes — nothing is live until you publish.
        {/if}
      </span>
    </div>
  {:else if entry.drift.length}
    <div class="lock-banner is-drift">
      The languages of this entry disagree about its blocks — publishing is blocked until that is
      settled.
    </div>
  {/if}
  <header class="entry-header" class:is-held={held}>
    <div class="crumbs">
      <a href={sitePath(entry.singleton ? '/admin/site' : `/admin/c/${collection}`)}>{entry.singleton ? 'Site settings' : capitalise(collection)}</a><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={saving} class:is-offline={saveFailed}>
        {#if saving}Saving…{:else if saveFailed}Not saved{:else if json !== saved}Unsaved changes{:else}Saved{/if}
      </span>
    </div>
    <div class="heading-row">
      <div class="title-row">
        <h1>{title}</h1>
        <div class="meta">
          <!-- Nothing lists a global, so there is nothing to take it off the site from. -->
          {#if !entry.singleton}
            <div class="pop-anchor">
              <button
                class="status"
                class:status-hidden={hidden}
                type="button"
                aria-haspopup="menu"
                aria-expanded={statusMenu}
                disabled={locked || busy}
                onclick={() => (statusMenu = !statusMenu)}
              ><span class="dot" aria-hidden="true"></span> {hidden ? 'Hidden' : 'Live'} ▾</button>
              {#if statusMenu}
                <div class="menu status-menu" role="menu" aria-label="Status">
                  <button type="button" role="menuitem" aria-current={hidden ? undefined : 'true'} onclick={() => (hidden ? setStatus(false) : (statusMenu = false))}>
                    <span class="dot dot-live" aria-hidden="true"></span> Live
                    <span class="sub">{url ? `on the site at ${url}` : 'on the site'}</span>
                  </button>
                  <button type="button" role="menuitem" aria-current={hidden ? 'true' : undefined} onclick={() => { statusMenu = false; if (!hidden) hiding = true; }}>
                    <span class="dot dot-hidden" aria-hidden="true"></span> Hidden
                    <span class="sub">off the site, kept here — we’ll ask where visitors should go</span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
          {#if conflicted}
            <span class="badge badge-danger">Changed in the repository since you opened it</span>
          {/if}
          <button
            class="hold-toggle"
            type="button"
            aria-pressed={held}
            disabled={locked || lost || busy || (!dirty && !held)}
            title={dirty || held ? undefined : 'There is nothing unpublished to hold back yet'}
            onclick={toggleHold}
          ><span class="dot" aria-hidden="true"></span> Not ready yet</button>
          {#if missing.length}
            <button class="problems" type="button" onclick={goToFirst}>
              {missing.length} problem{missing.length === 1 ? '' : 's'}
            </button>
          {/if}
        </div>
      </div>
      <div class="actions">
        {#if many}
          {#if entry.locales.length < 5}
            <div class="seg" role="group" aria-label="Language">
              {#each entry.locales as of (of)}
                <button type="button" class:is-off={off(of)} aria-pressed={locale === of} onclick={() => leaving(() => (locale = of))}>
                  {of.toUpperCase()}{#if off(of)}<span class="visually-hidden"> — turned off for this entry</span>{:else if untranslated(of)}<span class="visually-hidden"> — not translated yet</span><span class="mark is-empty" aria-hidden="true"></span>{:else if entry.stale.includes(of)}<span class="visually-hidden"> — {language(entry.sourceLocale)} changed since this was translated</span><span class="mark" aria-hidden="true"></span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <label class="visually-hidden" for="entry-locale">Language</label>
            <select
              class="input"
              id="entry-locale"
              value={locale}
              onchange={(e) => leaving(() => (locale = e.currentTarget.value))}
            >
              {#each entry.locales as of (of)}
                <option value={of}>{language(of)}</option>
              {/each}
            </select>
          {/if}
          <button class="btn btn-sbs" type="button" aria-pressed={side} onclick={() => leaving(() => (side = !side))}>Side by side</button>
        {/if}
        {#if previewable}
          <button class="btn btn-preview" type="button" aria-pressed={previewing} onclick={() => leaving(() => (previewing = !previewing))}>Preview</button>
        {/if}
        <button
          class="btn btn-primary"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={confirming}
          disabled={!dirty || saving || missing.length > 0 || entry.drift.length > 0 || locked}
          title={locked
            ? 'Somebody else is editing this entry'
            : entry.drift.length
            ? 'The languages of this entry disagree about its blocks'
            : missing.length
              ? 'Fill in what is missing before publishing this entry'
              : undefined}
          onclick={askToPublish}
          bind:this={publishButton}
        >Publish this entry</button>
        {#if !entry.singleton}
          <div class="pop-anchor">
            <button
              class="btn btn-ghost"
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreMenu}
              aria-label="More actions"
              disabled={locked || busy}
              onclick={() => (moreMenu = !moreMenu)}
            >⋯</button>
            {#if moreMenu}
              <div class="menu" role="menu" aria-label="More actions">
                <button type="button" role="menuitem" onclick={openRename}>Rename</button>
                <button type="button" role="menuitem" onclick={() => { moreMenu = false; if (hidden) setStatus(false); else hiding = true; }}>
                  {hidden ? 'Show' : 'Hide'}
                </button>
                <button type="button" role="menuitem" onclick={() => { moreMenu = false; actionFailed = ''; deleting = true; }}>Delete</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
    {#if conflicted}
      <p class="subline">
        Somebody changed this in the repository after you opened it. Open Unpublished changes to
        resolve it field by field, or to discard yours and take what is there now.
      </p>
    {/if}
    {#if held}
      <p class="subline">On hold — won't be included when others publish</p>
    {/if}
    {#if hidden}
      <p class="subline">
        {#if entry.redirects?.[locale]}Redirecting to {entry.redirects[locale]} while hidden{:else}Off the site — visitors to its old address see “page not found”{/if}
      </p>
    {/if}
    {#if statusFailed}<p class="subline is-bad" role="alert">{statusFailed}</p>{/if}
    {#if addressable}
      <p class="slug-row">
        {#if editing}
          <span class="url">{before}</span>
          <label class="visually-hidden" for="entry-address">Web address in {language(locale)}</label>
          <input class="input" id="entry-address" type="text" bind:value={typed} placeholder={slug} />
          <button class="btn btn-sm" type="button" disabled={busy} onclick={saveAddress}>Save</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => (editing = false)}>Cancel</button>
          {#if addressFailed}<span class="mode is-bad">{addressFailed}</span>{/if}
        {:else}
          <span class="url">{url}</span>
          {#if !address}<span class="mode">Same as the file name</span>{/if}
          <button class="btn-link" type="button" disabled={locked} onclick={editAddress}>Edit web address</button>
        {/if}
      </p>
    {/if}
    <!-- A global has no SEO or versions of its own: no tabs rather than three dead ones. -->
    <!-- Links, not a tablist: each is an address the back button lands on; keep the roles off. -->
    {#if !entry.singleton}
      <nav class="tabs" aria-label="Entry sections">
        <a href={sitePath(`/admin/c/${collection}/${slug}`)} aria-current={section === '' ? 'page' : undefined}>Content</a>
        {#if seoField}<a href={sitePath(`/admin/c/${collection}/${slug}/seo`)} aria-current={section === 'seo' ? 'page' : undefined}>SEO</a>{/if}
        <a href={sitePath(`/admin/c/${collection}/${slug}/history`)} aria-current={section === 'history' ? 'page' : undefined}>History</a>
      </nav>
    {/if}
  </header>
  {#if section === 'history'}
    <History
      {collection}
      {slug}
      {mediaBase}
      locales={entry.locales}
      drafted={entry.pending.length > 0}
      onrestored={(date) => {
        // The address changes first so the reload lands on the form the restore rewrote.
        onrestored?.(date);
        navigate(`/admin/c/${collection}/${slug}`);
        onchanged();
      }}
    />
  {:else}
  <!-- Stands where the form would be: every field belongs to a structure not yet agreed on. -->
  <div class="entry-body" class:has-pane={!entry.drift.length && (previewing || (!alone && shown !== undefined))} class:has-outline={!entry.drift.length && !alone && shown === undefined && !previewing && fields.length > 5}>
    {#if entry.drift.length}
      <DriftPanel
        {collection}
        {slug}
        drift={entry.drift}
        locales={entry.locales}
        onresolved={onchanged}
      />
    {:else}
      <!-- Not drawn when a translation is on its own. -->
      {#if !alone}
        <form class="form" onsubmit={(e) => e.preventDefault()}>
          <fieldset disabled={locked}>
            <Fields {fields} blocks={entry.blocks} {problems} {mediaBase} {locale} inheritedSeo={inherited(locale, data)} {site} servedAt={localeUrl(locale)} bind:root={entrySession.snapshots[entry.sourceLocale]!} />
          </fieldset>
        </form>
      {/if}
      <!-- Previewing beside a translation keeps that column. -->
      {#if previewing && !alone}
        {@render previewPane()}
      {:else if shown === undefined}
        {#if fields.length > 5}
          <nav class="editor-outline" aria-label="On this page">
            <p>On this page</p>
            {#each fields as field (field.path.join('.'))}
              <button type="button" onclick={() => focusField(field.path)}>{field.label || field.path.at(-1)}</button>
            {/each}
          </nav>
        {/if}
      {:else if untranslated(shown)}
        <!-- An empty form here would autosave a file nobody asked for. -->
        <section class="pane is-locale" aria-labelledby="pane-{shown}">
          <div class="pane-head"><h2 id="pane-{shown}">{language(shown)}</h2></div>
          <div class="empty">
            {#if off(shown)}
              <div class="is-wide">
                <p>
                  This entry is not offered in {language(shown)}. No {language(shown)} file is
                  written and the site does not link to one.
                </p>
                {#if putBack}
                  <p>
                    It was turned off here on {WHEN.format(putBack.at)}, and the {language(shown)}
                    words are still in the repository.
                  </p>
                  <button
                    class="btn btn-primary"
                    type="button"
                    disabled={busy || locked}
                    onclick={() =>
                      ask('/admin/api/restore', {
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ commit_sha: putBack?.commit_sha }),
                      })}
                  >
                    Bring the {language(shown)} words back
                  </button>
                  <p>
                    Or <button class="btn-link" type="button" disabled={busy || locked} onclick={() => offer(shown, true)}>turn {language(shown)} back on with an empty form</button>.
                  </p>
                {:else}
                  <button class="btn" type="button" disabled={busy || locked} onclick={() => offer(shown, true)}>
                    Turn {language(shown)} back on
                  </button>
                {/if}
              </div>
            {:else}
              <div class="is-wide">
                <p>
                  Creating it copies the structure and everything that reads the same in every
                  language. The text fields start empty.
                </p>
                <button class="btn btn-primary btn-create" type="button" disabled={busy || locked} onclick={() => createFrom(shown)}>
                  Create from {language(entry.sourceLocale)}
                </button>
                {#if entry.translator}
                  <button class="btn btn-fill" type="button" disabled={busy || locked} onclick={() => createFilled(shown)}>
                    Create and pre-fill
                  </button>
                {/if}
                {#if !entry.singleton}
                  <p>
                    Or <button class="btn-link" type="button" disabled={busy || locked} onclick={() => offer(shown, false)}>don't offer this entry in {language(shown)}</button> — no file is written for it.
                  </p>
                {/if}
              </div>
            {/if}
            {#if actionFailed}
              <div class="notice notice-danger" role="alert">{actionFailed}</div>
            {/if}
          </div>
        </section>
      {:else}
        <!-- Keyed: another language is another file, not the same one under a new name. -->
        {#key shown}
          <Translation
            bind:this={pane}
            {collection}
            {slug}
            locale={shown}
            session={entrySession}
            {fields}
            blocks={entry.blocks}
            bind:data={entrySession.snapshots[shown]!}
            problems={entrySession.positionalProblems(shown)}
            inheritedSeo={inherited(shown, entrySession.snapshot(shown))}
            source={entry.sourceLocale}
            {locked}
            stale={entry.stale.includes(shown)}
            translator={entry.translator}
            url={localeUrl(shown)}
            {site}
            onactivity={renew}
            onsaved={(pending) => {
              renew();
              if (pending !== translated) onpending?.();
              translated = pending;
              // The preview shows this language too, so a save here redraws it.
              savedAt = Date.now();
            }}
            {mediaBase}
            onclose={side ? () => leaving(() => (side = false)) : undefined}
            onturnoff={entry.singleton ? undefined : () => { actionFailed = ''; offing = shown; }}
          />
        {/key}
        {#if previewing}{@render previewPane()}{/if}
      {/if}
    {/if}
  </div>
  {/if}
  <!-- Publishes whole or not at all: picking languages is what the drawer is for. -->
  {#if confirming}
    <div class="scrim">
      <!-- Not aria-modal: the screen under it is not inert. -->
      <div class="dialog" role="dialog" aria-labelledby="publish-h" tabindex="-1" bind:this={publishPanel}>
        <h2 id="publish-h">Publish {title}?</h2>
        <p>
          This publishes it on its own. Anything else you have been working on stays unpublished.
        </p>
        {#if many && going.length}
          <ul class="publish-set">
            <li>
              <span class="visually-hidden">Languages:</span>
              <span class="chips">
                {#each going as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
              </span>
              {going.length === 1
                ? `The ${language(going[0] ?? '')} file`
                : `All ${going.length} language files`}
            </li>
          </ul>
        {/if}
        {#if checksFailed || lines.length}
          <section class="checks" aria-labelledby="publish-checks-h">
            <h3 class="group-title" id="publish-checks-h">Checks</h3>
            {#if checksFailed}
              <p class="checks-sum" role="status">
                The checks could not be run this time, so nothing here has been looked at.
              </p>
            {:else}
              <p class="checks-sum">{verdict(lines)}</p>
              <CheckLines {lines} chips={many} />
            {/if}
          </section>
        {/if}
        <p class="rebuild-note">
          One commit, then the site rebuilds — live in 1–3 minutes. The admin may reload while it
          deploys.
        </p>
        {#if publishFailed}<div class="notice notice-danger" role="alert">{publishFailed}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={closePublish}>Cancel</button>
          <button
            class="btn btn-primary"
            type="button"
            disabled={sending || errors.length > 0}
            onclick={publishEntry}
          >
            {#if sending}Publishing…
            {:else if errors.length}Fix {plural(errors.length, 'errors')} to publish
            {:else if warnings.length}Publish anyway ({plural(warnings.length, 'warnings')})
            {:else}Publish this entry{/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
  {#if hiding}
    <OffsiteDialog
      action="hide"
      what={title}
      {collection}
      index={entryUrl('default', routing, entry.index, '', locale) ?? undefined}
      {busy}
      error={statusFailed}
      onconfirm={(target: Target) => setStatus(true, target)}
      onclose={() => (hiding = false)}
    />
  {/if}
  {#if renaming}
    <div class="scrim">
      <div class="dialog" role="dialog" aria-labelledby="rename-h">
        <h2 id="rename-h">Rename {title}</h2>
        <form onsubmit={rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">File name</label></div>
            <input class="input filename" id="rename-to" type="text" bind:value={newName} aria-describedby="rename-hint" />
            <p class="hint" id="rename-hint">
              Saved as <span class="filename">{willBe}</span>. The old address redirects to the new
              one.
            </p>
          </div>
          {#if actionFailed}<div class="notice notice-danger" role="alert">{actionFailed}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={() => (renaming = false)}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Renaming…' : 'Rename'}</button>
          </div>
        </form>
      </div>
    </div>
  {/if}
  {#if deleting}
    <OffsiteDialog
      action="delete"
      what={title}
      {collection}
      index={entryUrl('default', routing, entry.index, '', locale) ?? undefined}
      {busy}
      error={actionFailed}
      onconfirm={remove}
      onhide={() => { deleting = false; hiding = true; }}
      onclose={() => (deleting = false)}
    />
  {/if}
  {#if offing}
    {@const going = offing}
    <OffsiteDialog
      action="off"
      language={language(going)}
      what={title}
      served={localeUrl(going)}
      {collection}
      index={localeIndex(going)}
      {busy}
      error={actionFailed}
      onconfirm={(target: Target) => turnOff(going, target)}
      onclose={() => (offing = undefined)}
    />
  {/if}
  {#if taking}
    <div class="scrim">
      <!-- Not aria-modal: the shell behind stays reachable, as on every other dialog here. -->
      <div class="dialog" role="dialog" aria-labelledby="take-h" tabindex="-1" bind:this={takePanel}>
        <h2 id="take-h">Take over editing from {holder}?</h2>
        <p>
          Nothing {holder} has written is lost — there is one shared draft and you carry on from
          where they left off.
        </p>
        <p>Their next save is refused and they are told you took over.</p>
        <div class="actions">
          <button class="btn" type="button" onclick={cancelTake}>Cancel</button>
          <button class="btn btn-primary" type="button" disabled={busy} onclick={takeOver}>Take over</button>
        </div>
      </div>
    </div>
  {/if}
</main>

<!-- Choosing a language here moves the whole screen, not only the frame. -->
{#snippet previewPane()}
  <PreviewPane
    url={localeUrl(locale) ?? ''}
    {locale}
    locales={previewLocales}
    onlocale={(of) => leaving(() => (locale = of))}
    enabled={preview}
    published={entry.published.includes(locale)}
    {hidden}
    stale={saveFailed}
    problems={previewProblems}
    ongo={goTo}
    {savedAt}
  />
{/snippet}
