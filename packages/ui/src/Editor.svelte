<script lang="ts">
import {
  type Drift,
  entryName,
  entryUrl,
  type Field,
  LOCK_TTL,
  resolveSeo,
  type SeoDefaultsValue,
} from '@handover/core';
import { tick } from 'svelte';
import DriftPanel from './Drift.svelte';
import Fields from './Fields.svelte';
import History from './History.svelte';
import { navigate } from './navigate';
import OffsiteDialog, { type Target } from './Offsite.svelte';
import PreviewPane from './Preview.svelte';
import Translation from './Translation.svelte';

type Data = Record<string, unknown>;
type Problem = { path: string; message: string };
const byPath = (problems: Problem[]) =>
  Object.fromEntries(problems.map((p) => [p.path, p.message]));
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
    /** The languages whose file this entry has a draft ahead of in git. */
    pending: string[];
    /** The languages the repository already has a file for; the rest are only in the preview. */
    published: string[];
    /** Somebody marked it "Not ready yet" — the toggle opens pressed, whoever they were. */
    held?: boolean;
    /** Off the site. The entry's, not one language's: `_status` is shared across the files. */
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
    /** The one this entry's structure is edited in, and the one a translation is made from:
        the site default only where the entry has a file in it. */
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
  /** A file of this entry was made, removed or settled: it has to be read again, screen with it. */
  onchanged: () => void;
  /**
   * This entry has something waiting to be published that it did not have a moment ago. The
   * drawer counts entries, so it hears about the save that flips that and about no other —
   * and unlike `onchanged` nothing on this screen is thrown away, since the person is typing.
   */
  onpending?: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// The last shape the draft row holds; the loaded data is already in it, hence no write on open.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let saved = $state(JSON.stringify(entry.data));
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending.includes(entry.sourceLocale));
let saving = $state(false);
let saveFailed = $state(false);
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let held = $state(entry.held === true);
// A draft stores whatever was typed, so what the schema still wants is the server's answer to
// every save rather than a reason to refuse one; the publish is where it blocks.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let problems = $state(byPath(entry.problems));
// Which language the switcher has, and whether the second column is open. Two independent
// things: the second column is always the default language beside a translation.
// svelte-ignore state_referenced_locally -- the language the entry is written in is where it opens
let locale = $state(entry.sourceLocale);
let side = $state(false);
// The pane is one thing at a time: the preview, or the second language.
let previewing = $state(false);
let savedAt = $state(0);
let pane = $state<ReturnType<typeof Translation>>();
// A second language stored ahead of the repository. It lives here rather than in the column,
// which is thrown away whenever the screen changes and would take the fact with it.
let translated = $state(false);

// Every control below is about having more than one language, so a site that declares one
// draws none of them — not greyed, not always-1-of-1, absent.
const many = $derived(entry.locales.length > 1);
const others = $derived(entry.locales.filter((l) => l !== entry.sourceLocale));
// The column beside the language the entry is written in: the one the switcher has, or the
// first other language when the switcher is on that one.
const target = $derived(locale === entry.sourceLocale ? others[0] : locale);
const shown = $derived(side ? target : locale === entry.sourceLocale ? undefined : locale);
// A translation on its own: the switcher is on another language and the second column is shut.
const alone = $derived(!side && shown !== undefined);
// The entry always has the file it was opened on; the others are the ones that can be absent.
const untranslated = (of: string) => of !== entry.sourceLocale && !(of in entry.translations);
// Turned off for this entry: no file is written for it and the site does not offer it.
const off = (of: string) => !entry.offered.includes(of);
let busy = $state(false);

// The two answers to a language with no file. Both change which files the entry has, so the
// screen is read again rather than patched here.
async function ask(url: string, init: RequestInit = {}) {
  busy = true;
  const res = await fetch(url, { method: 'POST', ...init });
  busy = false;
  if (res.ok) onchanged();
  return res.ok;
}

/**
 * The turn-off this language can be brought back from, when the CMS is what turned it off.
 * Without it *Turn German back on* re-offers the language and hands over an empty form, and the
 * German words are only in the repository — which is the whole difference between the two.
 */
let putBack = $state<{ commit_sha: string; at: number }>();
$effect(() => {
  const of = shown;
  putBack = undefined;
  // A global has no languages to turn off, and its collection is not one the route knows.
  if (of && off(of) && !entry.singleton) findRestore(of);
});

async function findRestore(of: string) {
  // A nicety, not the way in: if the log cannot be asked, the offer is simply not made and
  // *Turn German back on* stands where it did.
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
// Create from English and then a machine's first draft of it, as one answer to the offer: the
// file has to exist before anything can be written into it.
async function createFilled(of: string) {
  busy = true;
  const made = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
  if (made.ok)
    await fetch(`/admin/api/translate/${collection}/${slug}/${of}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  busy = false;
  if (made.ok) onchanged();
}
const offer = (of: string, on: boolean) =>
  ask(`/admin/api/entries/${collection}/${slug}/locales`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      locales: on
        ? entry.locales.filter((l) => l === of || !off(l))
        : entry.offered.filter((l) => l !== of),
    }),
  });

const json = $derived(JSON.stringify(data));
const missing = $derived(Object.keys(problems));
const named = $derived(data[entry.titleField ?? 'title']);
const title = $derived(entry.label ?? (typeof named === 'string' && named ? named : slug));
// The SEO panel is a tab of its own, so the field is taken out of the form the Content tab
// draws: one `seo` field, one set of ids on the screen. A `seo` field nested inside a group is
// an ordinary widget there — the tab is the entry's own.
// A global has no tab bar, so its panel stays in its one form rather than behind a tab nothing
// draws.
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
/** What one language's page would say with nothing typed: the build's own resolution, run here. */
const inherited = (of: string, values: Data) =>
  entry.fields.some((f) => f.type === 'seo')
    ? resolveSeo(
        undefined,
        entry.seoDefaults?.[of],
        String(values[entry.titleField ?? 'title'] ?? ''),
      )
    : undefined;
// A language other than the one this screen's form saves, already ahead of the repository when
// the entry was read. It stands until the entry is read again: a false offer costs an empty
// drawer, a false refusal loses the draft behind a disabled button.
const elsewhere = $derived(entry.pending.some((l) => l !== entry.sourceLocale));
// The second column is its own file, so an edit only made there is still something to publish.
const dirty = $derived(
  drafted || elsewhere || translated || json !== saved || (pane?.unsaved() ?? false),
);
const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const language = (of: string) => {
  try {
    return LANGUAGES.of(of) ?? of;
  } catch {
    return of;
  }
};

/**
 * The soft lock on this entry — every language of it at once, since they share a structure.
 * `undefined` until the first answer comes back; the tab that has it edits, the tab that has
 * not reads.
 */
type Lock = {
  held_by: { id: string; name: string | null } | null;
  mine: boolean;
  expires_at: number | null;
};
let lock = $state<Lock>();
// The lock is the tab's, not the person's, and this is what tells the tabs apart: a token made
// up once per browser tab and sent with every beat and every save. Session storage is per tab
// and survives moving between entries, so a tab that comes back to an entry is still itself.
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
// A save came back refused: somebody took the entry over while this tab had it. Its own state
// rather than the lock's, because the two banners say different things about the same fact.
let lost = $state(false);
let taking = $state(false);
let takePanel = $state<HTMLElement>();
let takeTrigger = $state<HTMLButtonElement>();
$effect(() => {
  if (taking) takePanel?.focus();
});
// Cancel gives focus back to the button that opened it; taking over reads the entry again and
// there is no banner left to go back to.
function cancelTake() {
  taking = false;
  takeTrigger?.focus();
}
// When the last answer came back, and when this tab last extended a lock of its own.
let asked = $state(0);
let beatAt = 0;
const locked = $derived(lock !== undefined && !lock.mine);
const holder = $derived(lock?.held_by?.name || 'Somebody else');
// The holder is this same person, in another tab.
const otherTab = $derived(lock?.held_by?.id !== undefined && lock?.held_by?.id === userId);
// How long ago the holder last typed: the lock is taken by a beat and beats ride on the
// autosave, so the expiry it carries is that keystroke plus one lifetime.
const idle = $derived(lock?.expires_at ? asked - (lock.expires_at - LOCK_TTL) : 0);

$effect(() => {
  void beat(true);
});

// While somebody else has it, the banner has to age and the lock has to be seen running out.
// The poll only reads: an entry changes hands when somebody presses Take over, not because a
// tab was watching when the last beat lapsed.
$effect(() => {
  if (!locked) return;
  const timer = setInterval(() => beat(false), 30000);
  return () => clearInterval(timer);
});

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
  lock = (await res.json()) as Lock;
  asked = Date.now();
  if (lock.mine) beatAt = asked;
}

// Autosave. The wait restarts on every keystroke, so a burst of typing is one write.
$effect(() => {
  if (json === saved) return;
  const timer = setTimeout(autosave, 2000);
  return () => clearTimeout(timer);
});

async function autosave() {
  const sent = json;
  saving = true;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, tab }),
  });
  saving = false;
  // Somebody pressed Take over. The words are not lost — they are in the shared draft the new
  // holder is carrying on from — but this tab is reading from here on.
  if (res.status === 409) {
    lost = true;
    lock = (await res.json()) as Lock;
    return;
  }
  saveFailed = !res.ok;
  if (res.ok) {
    // Typing is what holds the entry, and this is where the CMS hears it. Once every three
    // quarters of a lifetime, so a fast typist is not a write per pause. A refused save is not
    // a beat: the lock it would push out is not ours any more.
    if (Date.now() - beatAt >= 45000) void beat(true);
    saved = sent;
    // What the preview renders is the stored draft, so a settled save is when it is worth
    // asking the site to draw the page again.
    savedAt = Date.now();
    // Whether the stored draft differs from the file in git is the server's answer, not ours.
    const body = (await res.json()) as { pending: boolean; problems: Problem[] };
    if (body.pending !== drafted) onpending?.();
    drafted = body.pending;
    problems = byPath(body.problems);
  }
}

// The one thing that takes somebody else's work away, so it confirms first. The entry is read
// again afterwards: there is one shared draft, and carrying on from it means loading what they
// left rather than saving this tab's form over it.
async function takeOver() {
  busy = true;
  const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ take: true, tab }),
  });
  busy = false;
  taking = false;
  if (!res.ok) return;
  lock = (await res.json()) as Lock;
  onchanged();
}

// On the site or off it. Hiding has a consequence outside the CMS, so it asks where the page's
// readers should go before it writes anything; showing it again just writes.
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
  if (json !== saved) await autosave();
  if (pane?.unsaved()) await pane.flush();
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

// The overflow menu: what the list row offers, from inside the entry. A rename opens the entry
// under its new name and a delete goes back to the list, so neither needs the screen after.
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

// A 409 is the server's own sentence — "publish this first", "somebody else has it" — and
// reads better than anything this screen could say about it.
async function act(url: string, init: RequestInit) {
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

// "Not ready yet". The flag lives on the draft rows, so whatever is in the form is stored
// first — otherwise the entry is held back and the words that made somebody hold it are not.
async function toggleHold() {
  const next = !held;
  busy = true;
  if (json !== saved) await autosave();
  if (saveFailed || lost) {
    busy = false;
    return;
  }
  if (pane?.unsaved()) await pane.flush();
  const res = await fetch(`/admin/api/hold/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hold: next }),
  });
  busy = false;
  if (res.ok) held = ((await res.json()) as { held: unknown }).held === true;
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function land(field: HTMLElement | null) {
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}
function goTo(path: string | undefined) {
  const field = document.getElementById(`f-${path}`);
  // A field the other tab draws is not on screen at all, and a jump that lands nowhere reads as
  // a broken count. Go to the tab that has it, then land on it once — and once only: a second
  // miss is a field nothing draws, and looking again would never stop.
  if (!field && path && seoField && path.split('.')[0] === seoAt) {
    navigate(`/admin/c/${collection}/${slug}/seo`);
    void tick().then(() => land(document.getElementById(`f-${path}`)));
    return;
  }
  land(field);
}
const goToFirst = () => goTo(missing[0]);

// Publishing is the drawer's job, over every draft at once; the entry's own edit only has
// to be in D1 before it opens, so a click inside the autosave window is not lost.
// The header's half of publishing: this entry, whole, and nothing else anybody has been
// working on. It commits, so it confirms first.
let confirming = $state(false);
let sending = $state(false);
let publishFailed = $state('');
// Somebody committed to one of this entry's files after it was opened. Detection only: taking
// theirs whole is the drawer's Discard, and choosing field by field is the three-way view.
let conflicted = $state(false);
let publishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();
$effect(() => {
  if (confirming) publishPanel?.focus();
});

// The languages this publish would write. `drafted` is the live answer for the one the form
// saves; the rest are as the entry was read, plus whatever the second column has since sent.
const going = $derived(
  entry.locales.filter(
    (of) =>
      (of === entry.sourceLocale ? drafted : entry.pending.includes(of)) ||
      (of === target && translated),
  ),
);

async function askToPublish() {
  if (json !== saved) await autosave();
  if (saveFailed) return;
  // The other language is its own file and its own row, and the publish reads the rows.
  if (pane && !(await pane.flush())) return;
  publishFailed = '';
  confirming = true;
}

function closePublish() {
  confirming = false;
  publishButton?.focus();
}

async function publishEntry() {
  sending = true;
  publishFailed = '';
  const res = await fetch('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [`${collection}/${slug}`] }),
  });
  sending = false;
  if (res.ok) {
    confirming = false;
    // The rows are re-seeded on the commit and a hold comes off with them, so the screen is
    // read again rather than patched here.
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
    // Drift is the panel this screen already draws; a file somebody else changed is not, and
    // the way out of that one is in the drawer.
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

// The second column holds one language and goes when the screen changes under it — closed, or
// pointed at another language. Its wait would go with it, so whatever is in it is sent before
// the change; the request outlives the component, and the screen does not wait on it.
function leaving(change: () => void) {
  if (pane?.unsaved()) pane.flush();
  change();
}

// The address the language on screen serves this entry at. Its own control and its own write:
// unlike a field it is validated and has to be unique, and moving a published one owes a
// redirect. The file name never moves with it — renaming is the other action.
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

// Turning a language off commits, and the screen is read again afterwards: whatever is in the
// other form goes into its row first, the way an address change stores everything before it
// writes. The column's own draft is not flushed — it goes with the file.
async function turnOff(): Promise<boolean> {
  if (json !== saved) await autosave();
  return shown !== undefined && (await offer(shown, false));
}

// What the second column's Turn-off dialog names: the URL that language serves this entry at,
// and where its readers go afterwards — nothing when the collection has no page above it.
const localeUrl = (of: string) =>
  entryUrl('default', routing, entry.route, entry.addresses?.[of] || slug, of) ?? undefined;
const localeIndex = (of: string) => entryUrl('default', routing, entry.index, '', of) ?? undefined;

// What the preview pane is offered for: a collection with no route renders nowhere, so there is
// no page to frame — which is every global, and is why Preview is absent rather than refusing.
const previewable = $derived(Boolean(entry.route));
// The languages it can be previewed in are the ones it has a file in: a language with none is an
// offer to create one, not a page.
const previewLocales = $derived(
  entry.locales
    .filter((of) => of === entry.sourceLocale || !untranslated(of))
    .map((of) => ({ locale: of, label: language(of), url: localeUrl(of) ?? '' })),
);
// A field's own label, so the card says "Price" and not "price". Nested paths answer under the
// field they are inside, which is where the form scrolls to anyway.
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

// Everything on screen is stored first: this write goes into the same rows, and the screen is
// read again afterwards so both columns come back with the address the server settled on.
async function saveAddress() {
  busy = true;
  if (json !== saved) await autosave();
  if (pane?.unsaved()) await pane.flush();
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
/>

<main class="main main-editor">
  {#each entry.offerProblems ?? [] as problem (problem)}
    <div class="lock-banner is-offer">
      This entry's file says something its languages contradict — {problem}. Fix it in the
      repository; until then the files are what counts.
    </div>
  {/each}
  {#if lost}
    <!-- Leads with where the work went, because the fear is that it is gone: the draft rows are
         in D1 and the new holder carries on from them, so "lost" is never true of the words. -->
    <div class="lock-banner is-lost">
      {#if otherTab}
        Your other tab has this entry now. Everything you wrote is in the shared draft — that tab is
        carrying on from it.
      {:else}
        {holder} took over this entry. Everything you wrote is in the shared draft — {holder} is carrying
        on from it.
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
  {#if entry.drift.length}
    <div class="lock-banner is-drift">
      The languages of this entry disagree about its blocks — publishing is blocked until that is
      settled.
    </div>
  {/if}
  <header class="entry-header" class:is-held={held}>
    <div class="crumbs">
      <span>{entry.singleton ? 'Site settings' : capitalise(collection)}</span><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={saving} class:is-offline={saveFailed}>
        {#if saving}Saving…{:else if saveFailed}Not saved{:else if json !== saved}Unsaved changes{:else}Saved{/if}
      </span>
    </div>
    <div class="title-row">
      <h1>{title}</h1>
      <div class="meta">
        <!-- A global is one file the schema names and nothing lists it: there is nothing to
             take it off the site from, so it has no status at all. -->
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
    <!-- A global holds the site-wide SEO defaults rather than having its own, and there is no
         second version of a file the schema names: no tabs at all rather than three dead ones. -->
    <!-- Links and not a `role="tablist"`, which the mockup draws: each of these is an address
         the browser's back button and a shared link both have to land on, and a tab that
         navigates is not the widget that role claims. 4.16 must not port the roles back. -->
    {#if !entry.singleton}
      <nav class="tabs" aria-label="Entry sections">
        <a href="/admin/c/{collection}/{slug}" aria-current={section === '' ? 'page' : undefined}>Content</a>
        {#if seoField}<a href="/admin/c/{collection}/{slug}/seo" aria-current={section === 'seo' ? 'page' : undefined}>SEO</a>{/if}
        <a href="/admin/c/{collection}/{slug}/history" aria-current={section === 'history' ? 'page' : undefined}>History</a>
      </nav>
    {/if}
  </header>
  {#if section === 'history'}
    <History
      {collection}
      {slug}
      locales={entry.locales}
      drafted={entry.pending.length > 0}
      onrestored={() => {
        // The Content tab and a fresh read of the entry: the address changes first so the
        // reload lands on the form the restore has just rewritten.
        navigate(`/admin/c/${collection}/${slug}`);
        onchanged();
      }}
    />
  {:else}
  <!-- A decision to make, not a form to fill: the panel stands where the form would be, because
       every field on it belongs to a structure the languages have not agreed on yet. -->
  <div class="entry-body" class:has-pane={!entry.drift.length && (!alone || previewing)}>
    {#if entry.drift.length}
      <DriftPanel
        {collection}
        {slug}
        drift={entry.drift}
        locales={entry.locales}
        onresolved={onchanged}
      />
    {:else}
      <!-- The default language's form is the one the structure is edited in, so it is not
           drawn when the switcher is on another language and the second column is shut. -->
      {#if !alone}
        <form class="form" onsubmit={(e) => e.preventDefault()}>
          <fieldset disabled={locked}>
            <Fields {fields} blocks={entry.blocks} {problems} {mediaBase} {locale} inheritedSeo={inherited(locale, data)} bind:root={data} />
          </fieldset>
        </form>
      {/if}
      <!-- The pane holds one thing: the preview, or the second language. Previewing beside a
           translation keeps that column, since it is the only form on screen. -->
      {#if previewing && !alone}
        {@render previewPane()}
      {:else if shown === undefined}
        <aside class="pane" aria-label="Right pane">
          <div><strong>Right pane</strong>Preview to see the page, or Side by side for another language.</div>
        </aside>
      {:else if untranslated(shown)}
        <!-- An empty form here would autosave a file nobody asked for, so the language with no
             file is an offer instead: make one from the source language, or say the entry is
             not offered in it at all. -->
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
            {tab}
            {fields}
            blocks={entry.blocks}
            data={entry.translations[shown] ?? {}}
            inheritedSeo={inherited(shown, entry.translations[shown] ?? {})}
            source={entry.sourceLocale}
            {locked}
            stale={entry.stale.includes(shown)}
            translator={entry.translator}
            url={localeUrl(shown)}
            redirect={localeIndex(shown)}
            onsaved={(pending) => {
              if (pending !== translated) onpending?.();
              translated = pending;
              // This column has its own file and its own autosave, and the preview renders
              // whichever language is on screen: a save here is a page to draw again too.
              savedAt = Date.now();
            }}
            onrefused={(taken) => {
              lost = true;
              lock = taken as Lock;
            }}
            {mediaBase}
            onclose={side ? () => leaving(() => (side = false)) : undefined}
            onturnoff={entry.singleton ? undefined : turnOff}
          />
        {/key}
        {#if previewing}{@render previewPane()}{/if}
      {/if}
    {/if}
  </div>
  {/if}
  <!-- It commits, so it confirms — and it names everything that goes with the entry, which is
       every language file. What it never offers is a choice of what to include: an entry
       publishes whole or not at all, and picking is what the drawer is for. -->
  {#if confirming}
    <div class="scrim">
      <!-- Not aria-modal: the screen under it is not inert, and claiming a trap that is not
           there is worse than not claiming it. -->
      <div class="dialog" role="dialog" aria-labelledby="publish-h" tabindex="-1" bind:this={publishPanel}>
        <h2 id="publish-h">Publish {title}?</h2>
        <p>
          This publishes it on its own. Anything else you have been working on stays unpublished.
        </p>
        {#if many && going.length}
          <ul class="publish-set">
            <li>
              <span class="chips" aria-label="Languages">
                {#each going as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
              </span>
              {going.length === 1
                ? `The ${language(going[0] ?? '')} file`
                : `All ${going.length} language files`}
            </li>
          </ul>
        {/if}
        <p class="rebuild-note">
          One commit, then the site rebuilds — live in 1–3 minutes. The admin may reload while it
          deploys.
        </p>
        {#if publishFailed}<div class="notice notice-danger" role="alert">{publishFailed}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={closePublish}>Cancel</button>
          <button class="btn btn-primary" type="button" disabled={sending} onclick={publishEntry}>
            {sending ? 'Publishing…' : 'Publish this entry'}
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
  {#if taking}
    <div class="scrim">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="take-h" tabindex="-1" bind:this={takePanel}>
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

<!-- The pane, wherever it lands: beside the source form, or beside a translation being edited
     on its own. Its language is the one on screen, and choosing another moves the whole screen
     rather than only the frame — one entry, one language at a time. -->
{#snippet previewPane()}
  <PreviewPane
    url={localeUrl(locale) ?? ''}
    {locale}
    locales={previewLocales}
    onlocale={(of) => leaving(() => (locale = of))}
    enabled={preview}
    published={entry.published.includes(locale)}
    stale={saveFailed}
    problems={previewProblems}
    ongo={goTo}
    {savedAt}
  />
{/snippet}
