<script lang="ts" module>
import type { UiMessage } from '../errors.js';

/** What one Create all did to each language it set out to make; the shell keeps it past the reload. */
export type CreatedAll = {
  targets: string[];
  done: Record<string, 'created' | 'filled'>;
  failed?: { locale: string; step: 'create' | 'fill'; message: UiMessage; unconfirmed: boolean };
};
</script>

<script lang="ts">
import {
  answeredCount,
  answeredPaths,
  answeredWork,
  entryName,
  entryUrl,
  fieldPosition,
  formIn,
  referenceText,
  resolveSeo,
} from '@handover/core';
import { onMount, tick } from 'svelte';
import CanvasWorkspace from '../canvas/CanvasWorkspace.svelte';
import type { CanvasRenderRequest } from '../canvas/canvas-renderer';
import OffsiteDialog, { type Target } from '../content/Offsite.svelte';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { messageText, responseMessage } from '../errors.js';
import { formatExactTime, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import {
  guardEntryActions,
  guardNavigation,
  navigate,
  navigateAfterAuthoritativeChange,
} from '../navigate';
import { type OwedRow, owes, queueQuery, rowTitle, workFrom } from '../owed.js';
import * as m from '../paraglide/messages.js';
import { type CheckItem, localeOf, merged } from '../publishing/CheckLines.svelte';
import DriftPanel from '../publishing/Drift.svelte';
import History from '../publishing/History.svelte';
import {
  request as fetch,
  previewPath,
  siteBase,
  sitePath,
  uncertainResponse,
} from '../request.js';
import { when } from '../shared/activity-line';
import Modal from '../shared/Modal.svelte';
import PublishConfirmation from './PublishConfirmation.svelte';
import {
  createEntrySession,
  type EntryProblem,
  type StructuralSaveEnvelope,
} from './entry-session.svelte';
import Fields from './fields/Fields.svelte';
import type { EditorEntry } from './entry-payload';
import SourceChange from './SourceChange.svelte';
import { classifyDraftSaveRefusal } from './save';
import { createEntryLock } from './entry-lock.svelte';
import { createPublishChoice, type Readiness } from './publish-choice.svelte';
import Translation from './Translation.svelte';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  entry,
  section = '',
  mediaBase = '',
  preview = false,
  userId = '',
  onchanged,
  onreload,
  onpending,
  oncommitted,
  onpublished,
  onrestored,
  restored,
  onsourcechanged,
  sourceChanged,
  oncreatedall,
  createdAll,
  site,
  uiLocale = 'en',
  onmode,
  ontitle,
}: {
  collection: string;
  slug: string;
  /** Who is signed in, so a lock held by the same person reads as their other tab. */
  userId?: string;
  /** Where a stored media key is served from; the image and file widgets draw from it. */
  mediaBase?: string;
  /** This build serves `/_preview`: without it the pane says so rather than framing a 404. */
  preview?: boolean;
  entry: EditorEntry;
  /** Which of the entry's tabs the address is on; empty is the form itself. */
  section?: string;
  /** The site's origin, for the SEO previews; none, and the panel draws none. */
  site?: string;
  uiLocale?: UiLocale;
  /** A file of this entry was made, removed or settled, so the entry has to be read again. */
  onchanged: () => void | Promise<void>;
  /** Re-read the whole entry without flushing the session whose authoritative data changed. */
  onreload?: () => void | Promise<void>;
  /** Fires only on the save that flips whether this entry has something to publish. */
  onpending?: () => void;
  /** A successful entry action made a repository commit outside the ordinary publish control. */
  oncommitted?: () => void | Promise<void>;
  /** This entry went out from its header, named the way the shell should say it. */
  onpublished?: (title: string) => void | Promise<void>;
  /** A version went into the drafts; the shell remembers its git date past the reload. */
  onrestored?: (date: string) => void;
  /** The date of the version the unpublished changes were restored from, while they wait. */
  restored?: string;
  /** The source was changed on purpose; the shell remembers the language past the reload. */
  onsourcechanged?: (locale: string) => void;
  /** The language this entry was just made to be written in, while that waits to publish. */
  sourceChanged?: string;
  /** A Create all finished or stopped; the shell keeps its report past the reload. */
  oncreatedall?: (report: CreatedAll | undefined) => void;
  /** The report of this entry's last Create all, until it is dismissed. */
  createdAll?: CreatedAll;
  /** Lets the application shell collapse its navigation only for full-width Canvas. */
  onmode?: (mode: EditorMode) => void;
  /** Hands the shell a live read of the title for its top-bar breadcrumb. */
  ontitle?: (read: () => string) => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const feedbackText = (message: UiMessage) => messageText(message, uiLocale);
const feedbackDetail = (message: UiMessage) =>
  message.detail ? m.common_technical_detail({ detail: message.detail }, options) : '';
async function retainedFailure(response: Response, fallback: string): Promise<UiMessage> {
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

// svelte-ignore state_referenced_locally -- the loaded files seed this opened entry's session
const entryForm = { fields: [...entry.fields], blocks: entry.blocks };
// svelte-ignore state_referenced_locally -- the loaded files seed this opened entry's session
const entrySession = createEntrySession({
  document: `${collection}/${slug}`,
  sourceLocale: entry.sourceLocale,
  data: entry.data,
  translations: entry.translations,
  revisions: entry.revisions,
  form: entryForm,
  problems: { [entry.sourceLocale]: entry.problems },
  drift: entry.drift,
  onactivity: renew,
  onreconciled: () => (onreload ? onreload() : onchanged()),
});
const data = $derived(entrySession.snapshot(entry.sourceLocale));
const saveState = $derived(entrySession.saveState(entry.sourceLocale));
// svelte-ignore state_referenced_locally -- the loaded entry seeds each file's live draft state
const pendingByLocale = $state<Record<string, boolean>>(
  Object.fromEntries(entry.locales.map((of) => [of, entry.pending.includes(of)])),
);
const saving = $derived(saveState.phase === 'saving');
const saveFailed = $derived(saveState.phase === 'failed');
let saveError = $state<UiMessage>();
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let held = $state(entry.held === true);
const schemaProblems = $derived(entrySession.positionalProblems(entry.sourceLocale, uiLocale));
/** What the pre-publish checks found over this entry: read when it opens and after every save. */
let checks = $state<CheckItem[]>([]);
// Only the source's check errors gate the header; a translation's are the dialog's to offer.
const checkProblems = $derived(
  Object.fromEntries(
    checks
      .filter((c) => c.severity === 'error' && localeOf(c.path) === entry.sourceLocale)
      .flatMap((c) => {
        const at = fieldPosition('default', c.fieldPath, data);
        return at ? [[at.join('.'), c.message]] : [];
      }),
  ),
);
const problems = $derived({ ...checkProblems, ...schemaProblems });
// svelte-ignore state_referenced_locally -- the language the entry is written in is where it opens
let locale = $state(entry.sourceLocale);
let canvasPane = $state<ReturnType<typeof CanvasWorkspace>>();
// Sticky panes below the header sit exactly under it, however many rows it wraps to.
let headerHeight = $state(0);

type EditorMode = 'form' | 'split' | 'canvas';
/** What sits beside the form: the page, the other language, or nothing. */
type Beside = 'page' | 'language' | 'none';
const BESIDE: Beside[] = ['page', 'language', 'none'];
// svelte-ignore state_referenced_locally -- one authenticated editor instance owns one preference key
// v3: Form and Split became one view, so earlier saved values mean nothing here.
const viewKey = `handover:editor-view:v3:${siteBase() || '/'}:${userId}`;
const readView = () => {
  try {
    return localStorage.getItem(viewKey);
  } catch {
    return null;
  }
};
const saved = readView();
let chosen = $state<Beside | undefined>(
  BESIDE.includes(saved as Beside) ? (saved as Beside) : undefined,
);
let canvasOpen = $state(saved === 'canvas');
// Saved as 'form': a page could be shown, but the editor folded it away for a full-width form.
let collapsed = $state(saved === 'form');
const canvasSupported = $derived(preview && Boolean(entry.route));
const pageShown = $derived(section === '' && canvasSupported);
const besideOptions = $derived(
  BESIDE.filter((of) => (of === 'page' ? pageShown : of === 'language' ? many : !pageShown)),
);
const beside = $derived<Beside>(
  chosen && besideOptions.includes(chosen) ? chosen : pageShown && !collapsed ? 'page' : 'none',
);
const side = $derived(beside === 'language');
const mode = $derived<EditorMode>(
  pageShown && canvasOpen ? 'canvas' : beside === 'page' ? 'split' : 'form',
);
let canvasVisited = $state(false);
let mobilePane = $state<'form' | 'page'>('form');
const canvasEpoch = crypto.randomUUID();

function remember(value: string) {
  try {
    localStorage.setItem(viewKey, value);
  } catch {
    // A blocked browser preference must never block editing.
  }
}
// A link that opens a language is for this visit; only the person's own choice is saved.
function setBeside(next: Beside, save = true) {
  if (next === 'none' && pageShown) next = 'page';
  chosen = next;
  collapsed = false;
  canvasOpen = false;
  if (save) remember(next);
}
function collapse() {
  chosen = undefined;
  collapsed = true;
  canvasOpen = false;
  remember('form');
}
function setCanvas(open: boolean) {
  if (open && !canvasSupported) return;
  canvasOpen = open;
  if (open) mobilePane = 'page';
  remember(open ? 'canvas' : collapsed && pageShown ? 'form' : beside);
  if (open && section !== '') navigate(`/admin/c/${collection}/${slug}${queueTail}`);
}

$effect(() => {
  if (mode !== 'form') canvasVisited = true;
  onmode?.(mode);
});

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
// Recounted from both columns on every keystroke; nothing is saved or reloaded to learn it.
const wholeForm = $derived({ fields: [...entry.fields], blocks: entry.blocks });
const sourceText = $derived(answeredPaths('default', wholeForm, data));
const translated = $derived(
  Object.fromEntries(
    others
      .filter((of) => entrySession.hasSnapshot(of))
      .map((of) => [of, answeredPaths('default', wholeForm, entrySession.snapshot(of))]),
  ),
);
const answered = $derived(
  Object.fromEntries(
    Object.entries(translated).map(([of, paths]) => [of, answeredCount(sourceText, paths, of)]),
  ),
);
// The pane's to-do list: the same paths the count is made of, in the form's own order.
const paneWork = $derived(
  shown && translated[shown] ? answeredWork(sourceText, translated[shown], shown) : undefined,
);
const partial = (of: string) => {
  const count = answered[of];
  return count && count.written < count.of ? count : undefined;
};

// The language read under each field of the pane; stored as chosen, drawn only while it is valid.
// svelte-ignore state_referenced_locally -- one authenticated editor instance owns one preference key
const referenceKey = `handover:editor-reference:v1:${siteBase() || '/'}:${userId}`;
let referenceChoice = $state(
  (() => {
    try {
      return localStorage.getItem(referenceKey) ?? '';
    } catch {
      return '';
    }
  })(),
);
function chooseReference(of: string | undefined) {
  referenceChoice = of ?? '';
  try {
    localStorage.setItem(referenceKey, referenceChoice);
  } catch {
    // A blocked browser preference must never block editing.
  }
}
// `snapshot()` throws without a file, so only languages the session holds are offered.
const references = $derived(
  entry.locales.filter(
    (of) => of !== entry.sourceLocale && of !== shown && entrySession.hasSnapshot(of),
  ),
);
const reference = $derived.by(() => {
  const of = referenceChoice;
  if (!references.includes(of)) return undefined;
  const form = { fields: [...entry.fields], blocks: entry.blocks };
  const text = referenceText('default', form, entrySession.snapshot(of), of);
  return { locale: of, label: language(of), ...text };
});

// The list's language filter, carried in the address so remounts and section links keep it.
const opening = new URLSearchParams(location.search);
// svelte-ignore state_referenced_locally -- read once per mount, like `?locale=`
const queue =
  !entry.singleton && entry.locales.length > 1 && entry.locales.includes(opening.get('queue') ?? '')
    ? (opening.get('queue') ?? undefined)
    : undefined;
const queueWork = workFrom(opening.get('owed'));
const queueTail = queueQuery(queue, queueWork);
let next = $state<
  { at: 'loading' | 'failed' | 'lost' | 'end' } | { at: 'entry'; id: string; title: string }
>({ at: 'loading' });

// Found in the unfiltered order: this entry may no longer owe the language it was queued for.
async function loadQueue() {
  if (!queue) return;
  next = { at: 'loading' };
  try {
    const res = await fetch(`/admin/api/entries/${collection}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const body = (await res.json()) as { entries: OwedRow[]; locales?: string[] };
    const here = body.entries.findIndex((row) => row.id === slug);
    const row =
      here < 0 ? undefined : body.entries.slice(here + 1).find((r) => owes(r, queue, queueWork));
    next =
      here < 0
        ? { at: 'lost' }
        : row
          ? { at: 'entry', id: row.id, title: rowTitle(row, body.locales ?? entry.locales) }
          : { at: 'end' };
  } catch {
    next = { at: 'failed' };
  }
}
let busy = $state(false);
const actionBusy = $derived(busy || entrySession.persistedActionPending());

// Both change which files the entry has, so the screen is read again rather than patched.
async function ask(url: string, init: RequestInit = {}) {
  if (!(await flush())) return false;
  busy = true;
  const res = await fetch(url, { method: 'POST', ...init });
  busy = false;
  if (res.ok) {
    await announceCommit(res);
    onchanged();
  } else actionFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
  return res.ok;
}

async function announceCommit(res: Response) {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { commit_sha?: unknown };
  if (typeof body.commit_sha === 'string' && body.commit_sha) await oncommitted?.();
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

let localeFailure = $state<{ locale: string; message: UiMessage }>();
async function createFrom(of: string) {
  if (!(await flush())) return;
  busy = true;
  localeFailure = undefined;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
  busy = false;
  if (!res.ok) {
    localeFailure = {
      locale: of,
      message: uncertainResponse(res)
        ? { code: 'TRANSLATION_CREATE_UNCONFIRMED', status: res.status }
        : await retainedFailure(res, 'TRANSLATION_CREATE_FAILED'),
    };
    return;
  }
  await announceCommit(res);
  onchanged();
}
// The file has to exist before a machine's draft can be written into it.
async function createFilled(of: string) {
  if (!(await flush())) return;
  busy = true;
  localeFailure = undefined;
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
    localeFailure = {
      locale: of,
      message: uncertainResponse(made)
        ? { code: 'TRANSLATION_CREATE_UNCONFIRMED', status: made.status }
        : await retainedFailure(made, 'TRANSLATION_CREATE_FAILED'),
    };
    return;
  }
  if (!filled?.ok) {
    const refusal = filled ?? new Response('', { status: 503 });
    localeFailure = {
      locale: of,
      message: uncertainResponse(refusal)
        ? { code: 'TRANSLATION_CREATED_FILL_UNCONFIRMED', status: refusal.status }
        : await retainedFailure(refusal, 'TRANSLATION_CREATED_FILL_FAILED'),
    };
    return;
  }
  onchanged();
}
// Offered languages with no file, in configured order; the source always has one.
const missingTargets = $derived(entry.locales.filter((of) => untranslated(of) && !off(of)));
let creatingAll = $state<string>();
let createAllFailure = $state<UiMessage>();
// A report this mount did not make comes from before the reload, so the files now answer it.
let reportedHere = $state(false);
async function createAll(fill: boolean) {
  const targets = [...missingTargets];
  const report: CreatedAll = { targets, done: {} };
  const failure = async (res: Response, locale: string, step: 'create' | 'fill') => {
    const unconfirmed = uncertainResponse(res);
    const fallback = step === 'create' ? 'TRANSLATION_CREATE_FAILED' : 'TRANSLATION_CREATED_FILL_FAILED';
    return { locale, step, unconfirmed, message: await retainedFailure(res, fallback) };
  };
  createAllFailure = undefined;
  const outcome = await entrySession.authoritativeChange(
    async () => {
      for (const of of targets) {
        creatingAll = of;
        const made = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
        if (!made.ok) {
          report.failed = await failure(made, of, 'create');
          break;
        }
        report.done[of] = 'created';
        if (!fill) continue;
        const filled = await fetch(`/admin/api/translate/${collection}/${slug}/${of}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!filled.ok) {
          report.failed = await failure(filled, of, 'fill');
          break;
        }
        report.done[of] = 'filled';
      }
      creatingAll = undefined;
      reportedHere = true;
      oncreatedall?.(report);
      // Not replayed: the reload is what says whether an unanswered request landed.
      if (report.failed?.unconfirmed) throw new TypeError('A language was not confirmed.');
      return Object.keys(report.done).length > 0;
    },
    () => (onreload ? onreload() : onchanged()),
  );
  creatingAll = undefined;
  if (outcome.ok || outcome.reason === 'refused') return;
  if (outcome.reason === 'save') createAllFailure = { code: 'CREATE_ALL_SAVE_FAILED' };
  else if (outcome.reason === 'reload' || outcome.reason === 'uncertain')
    createAllFailure = { code: 'CREATE_ALL_RELOAD_FAILED' };
  else createAllFailure = { code: 'ENTRY_ACTION_FAILED' };
}
function createdLine(of: string, report: CreatedAll) {
  const named = { language: language(of) };
  const failed = report.failed?.locale === of ? report.failed : undefined;
  if (failed?.step === 'fill')
    return failed.unconfirmed
      ? m.editor_created_all_fill_unconfirmed(named, options)
      : m.editor_created_all_not_filled(named, options);
  if (failed?.unconfirmed && reportedHere) return m.editor_created_all_unconfirmed(named, options);
  if (failed?.unconfirmed && entrySession.hasSnapshot(of))
    return m.editor_created_all_created(named, options);
  if (failed) return m.editor_created_all_not_created(named, options);
  if (report.done[of] === 'filled') return m.editor_created_all_filled(named, options);
  if (report.done[of]) return m.editor_created_all_created(named, options);
  return m.editor_created_all_not_attempted(named, options);
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
  if (res) {
    await announceCommit(res);
    onchanged();
  }
  return res !== undefined;
}

const sourceUnsaved = $derived(entrySession.unsaved(entry.sourceLocale));
const missing = $derived(Object.keys(problems));
const named = $derived(data[entry.titleField ?? 'title']);
const title = $derived(
  entry.labels?.[uiLocale] ?? entry.label ?? (typeof named === 'string' && named ? named : slug),
);
onMount(() => ontitle?.(() => title));
// The SEO panel is its own tab, so the Content form omits the field; a global has no tabs.
const seoField = $derived(!entry.singleton && entry.fields.some((f) => f.type === 'seo'));
/** The key the seo field sits under, which is what a problem on it is named by. */
const seoAt = $derived(entry.fields.find((f) => f.type === 'seo')?.path[0]);
// Named again when the interface language changes, without reading the entry again.
const shownForm = $derived(
  formIn(
    { fields: [...entry.fields], blocks: entry.blocks, blockLabels: entry.blockLabels },
    uiLocale,
  ),
);
const fields = $derived(
  !seoField
    ? shownForm.fields
    : section === 'seo'
      ? shownForm.fields.filter((f) => f.type === 'seo')
      : shownForm.fields.filter((f) => f.type !== 'seo'),
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
const hasPending = () => Object.values(pendingByLocale).some(Boolean);
// The shell counts pending entries, while this editor owns the live state of every loaded file.
function setPending(of: string, pending: boolean) {
  if (pendingByLocale[of] === pending) return;
  const hadPending = hasPending();
  pendingByLocale[of] = pending;
  if (hadPending !== hasPending()) onpending?.();
}
const dirty = $derived(hasPending() || entrySession.unsaved());
const language = (of: string) => formatLanguageName(of, uiLocale);
// A stale mark naming another language: there is no change of the source to point at.
const otherSource = (of: string) => {
  const from = (entry.translations[of]?._i18n as { sourceLocale?: unknown } | undefined)
    ?.sourceLocale;
  return typeof from === 'string' && from !== entry.sourceLocale ? from : undefined;
};

// svelte-ignore state_referenced_locally -- the opened entry owns this lock until remount
const entryLock = createEntryLock({
  collection,
  slug,
  userId,
  onlost: () => entrySession.closeSaveGate(),
  onchanged,
  failure: retainedFailure,
});
const tab = entryLock.tab;
const lock = $derived(entryLock.lock);
const lost = $derived(entryLock.lost);
const locked = $derived(entryLock.locked);
const holderName = $derived(entryLock.holderName);
const otherTab = $derived(entryLock.otherTab);
const idle = $derived(entryLock.idle);
const taking = $derived(entryLock.taking);
const lockFailed = $derived(entryLock.takeFailure);
const takeBusy = $derived(entryLock.takeBusy);
let takeTrigger = $state<HTMLButtonElement>();
const loseLock = entryLock.lose;
function renew() { entryLock.renew(); }
const recheck = entryLock.recheck;
const cancelTake = entryLock.cancelTake;
const takeOver = entryLock.takeOver;

entrySession.configureAutosave((of, snapshot, revision, contentVersion, structure) =>
  of === entry.sourceLocale
    ? writeSourceSave(snapshot, revision, contentVersion, structure)
    : writeTranslationSave(of, snapshot, revision, contentVersion),
);

async function writeSourceSave(
  sent: string,
  revision: string | undefined,
  contentVersion: number,
  structure?: StructuralSaveEnvelope,
): Promise<boolean> {
  saveError = undefined;
  try {
    const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: JSON.parse(sent),
        tab,
        revision,
        ...(structure ? { structure } : {}),
      }),
    });
    if (!res.ok) {
      saveError = await retainedFailure(res, 'EDITOR_SAVE_REFUSED');
      const refusal = await classifyDraftSaveRefusal(res.clone());
      if (refusal.kind === 'lock') loseLock(refusal.lock);
      else if (refusal.kind === 'revision') {
        entrySession.freezeHistory();
        saveError = {
          code: 'EDITOR_SAVE_REVISION',
          status: res.status,
          ...(refusal.error ? { detail: refusal.error } : {}),
        };
      }
      return false;
    }
    const body = (await res.json()) as {
      pending: boolean;
      problems: EntryProblem[];
      revisions?: Record<string, string>;
    };
    entrySession.mergeRevisions(body.revisions);
    renew();
    setPending(entry.sourceLocale, body.pending);
    invalidateEntryDirectory();
    entrySession.acceptProblems(entry.sourceLocale, body.problems, sent, contentVersion);
    // The checks read the draft rows, so a save that left nothing pending has nothing to lint.
    if (body.pending) void lint();
    else checks = [];
    return true;
  } catch {
    saveError = { code: 'EDITOR_SAVE_CONNECTION' };
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
      else if (refusal.kind === 'revision') entrySession.freezeHistory();
      return false;
    }
    const body = (await res.json()) as {
      pending: boolean;
      problems: EntryProblem[];
      revision?: string;
    };
    if (body.revision) entrySession.setRevision(of, body.revision);
    entrySession.acceptProblems(of, body.problems, sent, contentVersion);
    renew();
    setPending(of, body.pending);
    invalidateEntryDirectory();
    // A new revision makes an open dialog's readiness stale.
    if (confirming) void lint();
    return true;
  } catch {
    return false;
  }
}

export function flush(): Promise<boolean> {
  return entrySession.flush();
}
const unsaved = () => entrySession.unsaved();
const warn = (event: BeforeUnloadEvent) => {
  if (unsaved()) {
    event.preventDefault();
    event.returnValue = '';
  }
};
onMount(() => {
  const release = guardNavigation(flush);
  const reloadAfterExternalAction = () => (onreload ? onreload() : onchanged());
  const releaseActions = guardEntryActions({
    key: `${collection}/${slug}`,
    publish: (request) => entrySession.finalPublish(request, reloadAfterExternalAction),
    replace: (request) => entrySession.authoritativeChange(request, reloadAfterExternalAction),
  });
  return () => {
    entrySession.closeSaveGate();
    releaseActions();
    release();
  };
});

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let hidden = $state(entry.hidden === true);
let statusMenu = $state(false);
let hiding = $state(false);
let statusFailed = $state<UiMessage>();

async function setStatus(next: boolean, redirect?: Target) {
  statusMenu = false;
  busy = true;
  statusFailed = undefined;
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
    statusFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
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
let actionTrigger = $state<HTMLElement>();
let newName = $state('');
let actionFailed = $state<UiMessage>();
let holdFailed = $state<UiMessage>();
const willBe = $derived(entryName('default', newName, []));

function openRename() {
  rememberActionTrigger();
  moreMenu = false;
  newName = slug;
  actionFailed = undefined;
  renaming = true;
}

function rememberActionTrigger() {
  const here = document.activeElement as HTMLElement | null;
  actionTrigger = here?.closest('.pop-anchor')?.querySelector('button') ?? here ?? undefined;
}

function startHiding() {
  rememberActionTrigger();
  statusMenu = false;
  moreMenu = false;
  hiding = true;
}

function startDeleting() {
  rememberActionTrigger();
  moreMenu = false;
  actionFailed = undefined;
  deleting = true;
}

// Every language with a file: the source always, the rest once loaded.
const present = $derived(
  entry.locales.filter((of) => of === entry.sourceLocale || entrySession.hasSnapshot(of)),
);
const saveBroken = $derived(present.some((of) => entrySession.saveState(of).phase === 'failed'));
const sourceBlocked = $derived(
  entry.drift.length
    ? m.editor_change_source_drift({}, options)
    : saveBroken
      ? m.editor_change_source_unsaved({}, options)
      : undefined,
);
let changingSource = $state(false);
let sendingSource = $state(false);
let sourceFailure = $state<UiMessage>();
let sourceFiles = $state<Record<string, Data>>({});

function openSourceChange() {
  rememberActionTrigger();
  moreMenu = false;
  sourceFailure = undefined;
  sourceFiles = Object.fromEntries(
    present.map((of) => [of, $state.snapshot(entrySession.snapshot(of))]),
  );
  changingSource = true;
}

async function changeSourceTo(to: string) {
  sendingSource = true;
  sourceFailure = undefined;
  let res: Response | undefined;
  const outcome = await entrySession.authoritativeChange(
    async () => {
      // Read after the drain, which is what moves each language's revision on.
      const revisions = Object.fromEntries(
        entry.locales.flatMap((of) => {
          const revision = entrySession.revision(of);
          return revision ? [[of, revision]] : [];
        }),
      );
      res = await fetch(`/admin/api/entries/${collection}/${slug}/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: to, tab, revisions }),
      });
      if (uncertainResponse(res))
        throw new TypeError('The source change response was not confirmed.');
      return res.ok;
    },
    async (outcome) => {
      // Unconfirmed: this session stays closed and only the dialog's Reload goes on from here.
      if (outcome === 'uncertain') return;
      onsourcechanged?.(to);
      await (onreload ? onreload() : onchanged());
    },
  );
  sendingSource = false;
  if (outcome.ok) return;
  if (outcome.reason === 'save') sourceFailure = { code: 'SOURCE_CHANGE_SAVE_FAILED' };
  else if (outcome.reason === 'uncertain') sourceFailure = { code: 'SOURCE_CHANGE_RESPONSE_LOST' };
  else if (outcome.reason === 'reload') sourceFailure = { code: 'SOURCE_CHANGE_RELOAD_FAILED' };
  else if (res && !res.ok) {
    const refusal = await classifyDraftSaveRefusal(res.clone());
    if (refusal.kind === 'lock') {
      changingSource = false;
      loseLock(refusal.lock);
    } else sourceFailure = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
  } else sourceFailure = { code: 'ENTRY_ACTION_FAILED' };
}

// A 409 body is the server's own sentence, which reads better than a generic one.
async function act(url: string, init: RequestInit) {
  if (!(await flush())) return undefined;
  busy = true;
  actionFailed = undefined;
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  actionFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
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
  await announceCommit(res);
  const { slug: to } = (await res.json()) as { slug: string };
  invalidateEntryDirectory();
  navigate(`/admin/c/${collection}/${to}${queueTail}`);
}

async function remove(redirect: Target) {
  const res = await act(`/admin/api/entries/${collection}/${slug}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect }),
  });
  if (res) {
    await announceCommit(res);
    invalidateEntryDirectory();
    navigate(`/admin/c/${collection}`);
  }
}

// The flag lives on the draft rows, so the form is stored first or the hold outruns the words.
async function toggleHold() {
  const next = !held;
  busy = true;
  holdFailed = undefined;
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
  else holdFailed = await retainedFailure(res, 'EDITOR_HOLD_FAILED');
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function land(field: HTMLElement | null) {
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
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
async function goTo(path: string | undefined) {
  const field = drawn('f', path);
  // A field on the other tab is not on screen: go to that tab, then look for it once only.
  if (!field && path && seoField && path.split('.')[0] === seoAt) {
    // As in `jumpTo`: the shell redraws the section from the address, so the move has to land first.
    if (!(await navigate(`/admin/c/${collection}/${slug}/seo${queueTail}`))) return;
    await tick();
    land(drawn('f', path));
    return;
  }
  land(field);
}
const focusable = (node: Element) =>
  node.matches('input, textarea, select, [contenteditable="true"]');
// A folded block draws no fields at all, so the way in is the fold button of each closed card.
async function unfolded(id: string) {
  for (let guard = 0; guard < 10; guard++) {
    const field = document.getElementById(id);
    if (field) return field;
    const steps = id.split('.');
    let card: HTMLElement | undefined;
    for (steps.pop(); steps.length && !card; steps.pop()) {
      const found = document.getElementById(steps.join('.'));
      if (found?.classList.contains('is-folded')) card = found;
    }
    if (!card) return null;
    card.querySelector<HTMLButtonElement>('button.fold')?.click();
    await tick();
  }
  return null;
}

/** The pane's to-do jump: bring the field this source path names on screen and focus it. */
async function jumpTo(path: string): Promise<boolean> {
  const of = shown;
  if (!of || !entrySession.hasSnapshot(of)) return false;
  const at = fieldPosition('default', path, entrySession.snapshot(of));
  if (!at) return false;
  const wanted = seoField && at[0] === seoAt ? 'seo' : '';
  if (section !== wanted) {
    // The shell redraws the section from the address, so the move has to land before the look-up.
    if (!(await navigate(`/admin/c/${collection}/${slug}${wanted ? `/${wanted}` : ''}${queueTail}`)))
      return false;
    await tick();
  }
  // On a narrow screen the two columns are tabs, and this one is the tab being worked in.
  if (side && !alone) mobilePane = 'page';
  const input = await unfolded(`t-${at.join('.')}`);
  // The nearest drawn ancestor is not this field: a container taking focus is not a visit.
  if (!input || !focusable(input)) return false;
  for (let node = input.parentElement; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement) node.open = true;
  await tick();
  input.scrollIntoView({ block: 'center' });
  input.focus();
  return document.activeElement === input || input.getAttribute('contenteditable') === 'true';
}

const goToFirst = () => {
  if (mode === 'canvas') {
    setCanvas(false);
    locale = entry.sourceLocale;
    void tick().then(() => goTo(missing[0]));
  } else goTo(missing[0]);
};

function reviewCanvasProblems() {
  const of = locale;
  const path = Object.keys({
    ...entrySession.incompleteFields(of),
    ...(of === entry.sourceLocale ? problems : entrySession.positionalProblems(of, uiLocale)),
  })[0];
  setCanvas(false);
  if (of !== entry.sourceLocale) setBeside('language');
  void tick().then(() => {
    if (of === entry.sourceLocale) goTo(path);
    else land(drawn('t', path));
  });
}

// The drawer's `?field=…&locale=…`: open the column first, then look for the control once drawn.
function fromAddress() {
  const query = new URLSearchParams(location.search);
  const field = query.get('field');
  const requestedLocale = query.get('locale');
  // The queue's language opens beside the source, with its create pane when it has no file.
  if (!field && !requestedLocale && queue && query.get('queue') === queue) {
    leaving(() => {
      if (queue !== entry.sourceLocale) locale = queue;
      setBeside('language', false);
    });
    return;
  }
  if (!field && !requestedLocale) return;
  const of = requestedLocale || entry.sourceLocale;
  const inColumn = of !== entry.sourceLocale && entry.locales.includes(of) && !untranslated(of);
  if (inColumn && shown !== of) {
    leaving(() => {
      locale = of;
      setBeside('language', false);
    });
  } else if (!inColumn && alone) {
    leaving(() => {
      locale = entry.sourceLocale;
    });
  }
  if (!field) return;
  const at = fieldPosition('default', field, inColumn ? entrySession.snapshot(of) : data);
  if (!at) return;
  void tick().then(() => land(drawn(inColumn ? 't' : 'f', at.join('.'))));
}
onMount(() => {
  fromAddress();
  void loadQueue();
  // Only a draft gets linted, so an entry with nothing pending is not asked about.
  if (entry.pending.length) void lint();
});

// This entry and nothing else, less any new language left for later; it commits, so it confirms first.
let confirming = $state(false);
let sending = $state(false);
let publishFailed = $state<UiMessage>();
/** The pass could not be run at all — which holds nothing back: it is a lint, not a gate. */
let checksFailed = $state(false);
const publishChoice = createPublishChoice(
  () => entry.locales.filter((of) => pendingByLocale[of]),
  () => many,
);
let pass = 0;
const lines = $derived(merged(checks));
const errors = $derived(lines.filter((c) => c.severity === 'error'));
// Detection only; resolving it is the drawer's job.
let conflicted = $state(false);
let publishButton = $state<HTMLButtonElement>();
let canvasPublishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();

const leftOut = $derived(publishChoice.leftOut);
const unready = $derived(publishChoice.unready);
const selection = (key: string, without: string[]) =>
  JSON.stringify(
    without.length
      ? { entries: [key], without: without.map((of) => `${key}:${of}`) }
      : { entries: [key] },
  );

async function askToPublish() {
  if (!(await flush())) return;
  publishFailed = undefined;
  publishChoice.reset();
  confirming = true;
  void lint();
}

function publishLater(of: string) {
  publishChoice.toggle(of);
  void lint();
}

/** The drawer's lint over this one entry; an answer that never comes holds nothing back. */
async function lint() {
  const key = `${collection}/${slug}`;
  const mine = ++pass;
  const sent = leftOut;
  const res = await fetch('/admin/api/publish/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: selection(key, sent),
  }).catch(() => undefined);
  const body = res?.ok
    ? ((await res.json()) as {
        results?: CheckItem[];
        readiness?: Record<string, Record<string, Readiness>>;
      })
    : undefined;
  // A save or another choice since asked again; the older answer would put back what the newer one cleared.
  if (mine !== pass) return;
  checksFailed = !res?.ok;
  // The daily hidden check's note about some other page is the drawer's to list, not this entry's.
  checks = (body?.results ?? []).filter((c) => c.entry === key);
  publishChoice.receive(body?.readiness?.[key], checksFailed);
  // The answer changed what can wait, so these checks were over another set of files.
  if (confirming && sent.join() !== leftOut.join()) void lint();
}

function closePublish() {
  if (sending) return;
  confirming = false;
}

async function publishEntry() {
  if (entrySession.persistedActionPending()) return;
  sending = true;
  publishFailed = undefined;
  let res: Response | undefined;
  let checksBlocked = false;
  const outcome = await entrySession.finalPublish(
    async () => {
      // Again after reserving the session: the dialog may have been open while more was typed.
      const chosen = leftOut;
      await lint();
      if (errors.length || unready.length || chosen.join() !== leftOut.join()) {
        checksBlocked = true;
        return false;
      }
      res = await fetch('/admin/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: selection(`${collection}/${slug}`, leftOut),
      });
      if (uncertainResponse(res)) throw new TypeError('The publish response was not confirmed.');
      if (res.ok) await onpublished?.(title);
      return res.ok;
    },
    () => (onreload ? onreload() : onchanged()),
  );
  sending = false;
  if (outcome.ok) {
    confirming = false;
    return;
  }
  if (outcome.reason === 'save') {
    publishFailed = { code: 'PUBLISH_SAVE_FAILED' };
    publishPanel?.focus();
    return;
  }
  if (checksBlocked) {
    // A disabled button drops the focus that pressed it.
    publishFailed = { code: 'PUBLISH_CHECKS_BLOCKED' };
    publishPanel?.focus();
    return;
  }
  if (outcome.reason === 'uncertain') {
    publishFailed = { code: 'PUBLISH_ENTRY_RESPONSE_LOST' };
    return;
  }
  if (outcome.reason === 'reload') {
    publishFailed = { code: 'PUBLISH_ENTRY_RELOAD_FAILED' };
    return;
  }
  if (!res) {
    publishFailed = { code: 'PUBLISH_FAILED' };
    return;
  }
  const code = res.headers.get('x-handover-error-code') ?? '';
  if (code === 'PUBLISH_SELECTION_INVALID' || code.startsWith('PUBLISH_EXCLUDE_')) {
    publishFailed = await retainedFailure(res, 'PUBLISH_FAILED');
    return;
  }
  if (res.status === 422) {
    publishFailed = { code: 'PUBLISH_ENTRY_INCOMPLETE' };
    return;
  }
  if (res.status === 409) {
    const parsed = (await res
      .clone()
      .json()
      .catch(() => ({}))) as {
      paths?: unknown;
      reason?: string;
    };
    // Drift has a panel on this screen; a file somebody else changed is handled in the drawer.
    if (parsed.reason === 'drift') {
      publishFailed = { code: 'PUBLISH_ENTRY_DRIFT' };
      return;
    }
    if (Array.isArray(parsed.paths) && parsed.paths.length) {
      closePublish();
      conflicted = true;
      return;
    }
    publishFailed = await retainedFailure(res, 'PUBLISH_REF_MOVED');
    return;
  }
  publishFailed = await retainedFailure(res, 'PUBLISH_FAILED');
}

// Keep the pane mounted until all its changes have been saved.
async function leaving(change: () => void) {
  if (unsaved() && !(await flush())) return;
  change();
}

// Five languages and up in the header, two others and up in the pane: a disclosure, not role="menu", as on the entry list rows.
let languageMenu = $state<'header' | 'pane'>();
let languageTrigger = $state<HTMLButtonElement>();
// Rebound when the pane remounts on its new language, so focus returns to the pane on screen.
let paneTrigger = $state<HTMLButtonElement>();

async function chooseLanguage(of: string) {
  await leaving(() => (locale = of));
  await closeLanguages();
}

async function closeLanguages() {
  const pane = languageMenu === 'pane';
  languageMenu = undefined;
  await tick();
  (pane ? paneTrigger : languageTrigger)?.focus();
}

// Unlike a field, an address is validated, unique and owes a redirect when it moves.
let editing = $state(false);
let typed = $state('');
let addressFailed = $state<UiMessage>();
let addressInput = $state<HTMLInputElement>();
let addressTrigger = $state<HTMLButtonElement>();
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

const canvasRequest = (): CanvasRenderRequest => ({
  url: previewPath(localeUrl(locale) ?? '/'),
  snapshot: {
    mode: 'canvas',
    protocol: 1,
    epoch: canvasEpoch,
    entry: { collection, id: slug },
    locale,
    contentVersion: entrySession.contentVersion(locale),
    snapshots: entrySession.renderSnapshots(),
  },
});

function canvasCompleted() {
  if (mode !== 'split') return;
  void tick().then(() => canvasPane?.schedule());
}

function navigateCanvasEntry(target: {
  collection: string;
  id: string;
  locale: string;
  href: string;
}) {
  if (target.collection !== collection || target.id !== slug) {
    const query = new URLSearchParams({ locale: target.locale });
    navigateAfterAuthoritativeChange(
      `/admin/c/${target.collection}/${target.id}?${query.toString()}`,
    );
    return;
  }
  if (!entry.locales.includes(target.locale) || untranslated(target.locale)) return;
  locale = target.locale;
  if (mode === 'split') mobilePane = 'page';
  void tick().then(() => canvasPane?.schedule());
}

function editAddress() {
  typed = address;
  addressFailed = undefined;
  editing = true;
  void tick().then(() => {
    addressInput?.focus();
    addressInput?.select();
  });
}

async function cancelAddress() {
  editing = false;
  await tick();
  addressTrigger?.focus();
}

function addressKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!busy) void saveAddress();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (!busy) void cancelAddress();
  }
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
    addressFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
    return;
  }
  await cancelAddress();
  invalidateEntryDirectory();
  onchanged();
}
</script>

<svelte:window
  onclick={(e) => languageMenu && !(e.target as HTMLElement).closest('.language-pick') && (languageMenu = undefined)}
  onkeydown={(e) => e.key === 'Escape' && languageMenu && (e.target as HTMLElement).closest('.language-pick') && void closeLanguages()}
  onfocus={recheck}
  onpopstate={fromAddress}
  onbeforeunload={warn}
/>
<svelte:document onvisibilitychange={recheck} />

{#snippet languageMark(of: string)}
  {#if off(of)}<span class="visually-hidden"> — {m.editor_language_off_a11y({}, options)}</span>{:else if untranslated(of)}<span class="visually-hidden"> — {m.editor_language_untranslated_a11y({}, options)}</span><span class="mark is-empty" aria-hidden="true"></span>{:else if entry.stale.includes(of)}<span class="visually-hidden"> — {otherSource(of) ? m.editor_language_other_source_a11y({ language: language(otherSource(of) ?? ''), source: language(entry.sourceLocale) }, options) : m.editor_language_stale_a11y({ source: language(entry.sourceLocale) }, options)}</span><span class="mark" aria-hidden="true"></span>{:else if partial(of)}{@const count = partial(of)}<span class="visually-hidden"> — {m.editor_language_partial_a11y({ written: count?.written ?? 0, count: count?.of ?? 0 }, options)}</span><span class="mark is-partial" aria-hidden="true"></span>{/if}
{/snippet}

{#snippet paneHeading(of: string)}
  {#if side && others.length > 1}
    <div class="pop-anchor language-pick">
      <h2 id="pane-{of}">
        <button class="btn btn-sm" type="button" aria-expanded={languageMenu === 'pane'} aria-controls="pane-languages" bind:this={paneTrigger} onclick={(e) => { languageMenu = languageMenu === 'pane' ? undefined : 'pane'; e.currentTarget.focus(); }}>
          <span class="visually-hidden">{`${m.editor_pane_language({ source: language(entry.sourceLocale) }, options)}: `}</span>{language(of)}{@render languageMark(of)}
        </button>
      </h2>
      {#if languageMenu === 'pane'}
        <div class="menu language-menu" id="pane-languages">
          {#each others as other (other)}
            <button type="button" class={{ 'is-off': off(other) }} aria-pressed={of === other} onclick={() => chooseLanguage(other)}>{language(other)}{@render languageMark(other)}</button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <h2 id="pane-{of}">{language(of)}</h2>
  {/if}
{/snippet}

<!-- A link, so the shell drains unsaved typing before it leaves, as it does for every address. -->
{#snippet queueNext()}
  {#if queue}
    {@const scope = m.editor_queue_scope({}, options)}
    {@const detail = next.at === 'entry' ? `${m.editor_queue_next_detail({ title: next.title }, options)} ${scope}` : scope}
    <span class="queue-next" title={detail}>
      {#if next.at === 'entry'}
        <a class="btn btn-sm" href={sitePath(`/admin/c/${collection}/${next.id}${queueTail}`)} aria-describedby="queue-scope">{m.editor_queue_next({ language: language(queue) }, options)}</a>
      {:else if next.at === 'failed'}
        {m.editor_queue_failed({}, options)} <button class="btn-link" type="button" onclick={loadQueue}>{m.common_retry({}, options)}</button>
      {:else}
        {next.at === 'loading' ? m.editor_queue_loading({}, options) : next.at === 'lost' ? m.editor_queue_lost({}, options) : m.editor_queue_end({}, options)}
      {/if}
      <span class="visually-hidden" id="queue-scope">{detail}</span>
    </span>
  {/if}
{/snippet}

{#snippet canvasEntryActions()}
  <select class="canvas-locale" aria-label={m.editor_language({}, options)} value={locale}
    onchange={(event) => { const nextLocale = event.currentTarget.value; void leaving(() => (locale = nextLocale)); }}>
    {#each entry.locales as of (of)}
      <option value={of}>{of.toUpperCase()}{off(of) ? ` · ${m.editor_language_off({}, options)}` : untranslated(of) ? ` · ${m.editor_language_new({}, options)}` : entry.stale.includes(of) ? ` · ${m.editor_language_changed({}, options)}` : partial(of) ? ` · ${m.editor_language_partial({}, options)}` : ''}</option>
    {/each}
  </select>
  <span class={[
    'autosave',
    {
      'is-saving': entrySession.saveState(locale).phase === 'saving',
      'is-offline': entrySession.saveState(locale).phase === 'failed',
    },
  ]} role="status">
    {entrySession.saveState(locale).phase === 'saving'
      ? m.editor_save_saving({}, options)
      : entrySession.saveState(locale).phase === 'failed'
        ? m.editor_save_not_saved({}, options)
        : entrySession.unsaved(locale)
          ? m.editor_save_unsaved({}, options)
          : m.editor_save_saved({}, options)}
  </span>
{/snippet}

{#snippet canvasPublish()}
  <button class="btn btn-primary canvas-publish" type="button" aria-haspopup="dialog" aria-expanded={confirming}
    disabled={!dirty || saving || missing.length > 0 || entry.drift.length > 0 || locked || actionBusy}
    onclick={askToPublish} bind:this={canvasPublishButton}>{m.editor_publish_short({}, options)}</button>
{/snippet}

<main class={['main main-editor', { 'is-canvas-fullscreen': mode === 'canvas' }]} style:--entry-header-h={`${headerHeight}px`}>
  {#if actionFailed && !renaming && !deleting && !offing}<p class="notice notice-danger" role="alert">{feedbackText(actionFailed)} {feedbackDetail(actionFailed)}</p>{/if}
  {#if holdFailed}<p class="notice notice-danger" role="alert">{feedbackText(holdFailed)} {feedbackDetail(holdFailed)}</p>{/if}
  {#if saveError}<p class="notice notice-danger" role="alert">{feedbackText(saveError)} {feedbackDetail(saveError)} <button class="btn-link" type="button" onclick={() => flush()}>{m.editor_save_retry({}, options)}</button></p>{/if}
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
        {m.editor_lock_lost_other_tab({}, options)}
      {:else if holderName}
        {m.editor_lock_lost_taken({ holder: holderName }, options)}
      {:else}
        {m.editor_lock_lost_taken_anonymous({}, options)}
      {/if}
      <button class="btn-link" type="button" onclick={() => void (onreload ? onreload() : onchanged())}>{m.editor_lock_reload({}, options)}</button>
    </div>
  {:else if locked}
    <div class="lock-banner">
      {#if otherTab}
        {m.editor_lock_other_tab({}, options)}
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={entryLock.openTake}>{m.editor_lock_edit_here({}, options)}</button>
      {:else if lock?.held_by}
        {#if holderName}
          {m.editor_lock_held_by({ holder: holderName }, options)}
        {:else}
          {m.editor_lock_held_anonymous({}, options)}
        {/if}
        <span class="when">
          {idle >= 60000
            ? m.editor_lock_idle({}, options)
            : m.editor_lock_active({}, options)}
        </span>
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={entryLock.openTake}>{m.editor_lock_take_over({}, options)}</button>
      {:else}
        {m.editor_lock_nobody({}, options)}
        <button class="btn-link" type="button" onclick={() => void (onreload ? onreload() : onchanged())}>{m.editor_lock_reload({}, options)}</button>
      {/if}
    </div>
  {/if}
  {#if restored && entry.pending.length}
    <!-- The restore is over by the time this draws, so this is what says what just happened. -->
    <div class={['lock-banner', { 'is-drift': entry.drift.length > 0 }]} role="status">
      <span>
        <b>{m.editor_restored_version({ date: when(Date.parse(restored)).toLowerCase() }, options)}</b>
        {#if entry.drift.length}
          {m.editor_restored_drift({}, options)}
        {:else}
          {m.editor_restored_unpublished({}, options)}
        {/if}
      </span>
    </div>
  {:else if entry.drift.length}
    <div class="lock-banner is-drift">{m.editor_drift_blocked({}, options)}</div>
  {:else if sourceChanged === entry.sourceLocale && entry.pending.length}
    <div class="lock-banner" role="status">{m.editor_source_changed({ language: language(entry.sourceLocale) }, options)}</div>
  {/if}
  {#if createdAll}
    <div class={['lock-banner created-all', { 'is-offer': createdAll.failed }]} role="status">
      <ul>
        {#each createdAll.targets as of (of)}
          <li>{createdLine(of, createdAll)}</li>
        {/each}
      </ul>
      {#if createdAll.failed && !(createdAll.failed.unconfirmed && !reportedHere)}
        <p>{feedbackText(createdAll.failed.message)} {feedbackDetail(createdAll.failed.message)}</p>
      {/if}
      <button class="btn-link" type="button" onclick={() => oncreatedall?.(undefined)}>{m.editor_created_all_dismiss({}, options)}</button>
    </div>
  {/if}
  <header class={['entry-header', { 'is-held': held }]} bind:offsetHeight={headerHeight}>
    <div class="heading-row">
      <div class="title-row">
        <div class="title-stack">
          <h1>{title}</h1>
          {#if addressable}
            <div class={['slug-row', { 'is-editing': editing }]}>
              {#if editing}
                <span class="url">{before}</span>
                <label class="visually-hidden" for="entry-address">{m.editor_address_label({ language: formatLanguageName(locale, uiLocale) }, options)}</label>
                <input
                  class="slug-input"
                  id="entry-address"
                  type="text"
                  style={`width: ${Math.max(4, Math.min(28, typed.length + 1))}ch`}
                  bind:this={addressInput}
                  bind:value={typed}
                  placeholder={slug}
                  onkeydown={addressKeydown}
                />
                <span class="slug-actions">
                  <button class="btn btn-sm slug-action slug-save" type="button" aria-label={m.editor_address_save({}, options)} title={m.editor_address_save({}, options)} disabled={busy} onclick={saveAddress}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.3 3.5 3.5L16 5.7" /></svg>
                  </button>
                  <button class="btn btn-ghost btn-sm slug-action slug-cancel" type="button" aria-label={m.editor_address_cancel({}, options)} title={m.editor_address_cancel({}, options)} disabled={busy} onclick={cancelAddress}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10m0-10L5 15" /></svg>
                  </button>
                </span>
                {#if addressFailed}<span class="mode is-bad">{feedbackText(addressFailed)} {feedbackDetail(addressFailed)}</span>{/if}
              {:else}
                <button
                  class="btn-link url slug-edit"
                  type="button"
                  bind:this={addressTrigger}
                  disabled={locked}
                  aria-label={`${m.editor_address_edit({}, options)}: ${url}`}
                  onclick={editAddress}
                >{url}</button>
                {#if !address}<span class="mode">{m.editor_address_file_name({}, options)}</span>{/if}
              {/if}
            </div>
          {/if}
        </div>
        <div class="meta">
          <!-- Nothing lists a global, so there is nothing to take it off the site from. -->
          {#if !entry.singleton}
            <div class="pop-anchor">
              <button
                class={['status', { 'status-hidden': hidden }]}
                type="button"
                aria-haspopup="menu"
                aria-expanded={statusMenu}
                disabled={locked || actionBusy}
                onclick={() => (statusMenu = !statusMenu)}
              >
                <span class="status-value"><span class="dot" aria-hidden="true"></span>{hidden ? m.editor_status_hidden({}, options) : m.editor_status_live({}, options)}</span>
                <span class="status-chevron" aria-hidden="true">
                  <svg viewBox="0 0 16 16"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>
                </span>
              </button>
              {#if statusMenu}
                <div class="menu status-menu" role="menu" aria-label={m.editor_status_menu({}, options)}>
                  <button type="button" role="menuitem" aria-current={hidden ? undefined : 'true'} onclick={() => (hidden ? setStatus(false) : (statusMenu = false))}>
                    <span class="dot dot-live" aria-hidden="true"></span> {m.editor_status_live({}, options)}
                    <span class="sub">{url ? m.editor_status_live_detail({ url }, options) : m.editor_status_live_no_url({}, options)}</span>
                  </button>
                  <button type="button" role="menuitem" aria-current={hidden ? 'true' : undefined} onclick={() => { if (!hidden) startHiding(); else statusMenu = false; }}>
                    <span class="dot dot-hidden" aria-hidden="true"></span> {m.editor_status_hidden({}, options)}
                    <span class="sub">{m.editor_status_hidden_detail({}, options)}</span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
          {#if conflicted}
            <span class="badge badge-danger">{m.pending_changed_repository({}, options)}</span>
          {/if}
          <button
            class="hold-toggle"
            type="button"
            role="switch"
            aria-checked={!held}
            disabled={locked || lost || actionBusy || (!dirty && !held)}
            title={dirty || held ? undefined : m.editor_hold_unavailable({}, options)}
            onclick={toggleHold}
          ><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>{m.editor_ready_to_publish({}, options)}</span></button>
          {#if missing.length}
            <button class="problems" type="button" onclick={goToFirst}>
              {m.editor_problem_count({ count: missing.length }, options)}
            </button>
          {/if}
        </div>
      </div>
      <div class="actions">
        <span class={['autosave', { 'is-saving': saving, 'is-offline': saveFailed }]}>
          {#if saving}{m.editor_save_saving({}, options)}{:else if saveFailed}{m.editor_save_not_saved({}, options)}{:else if sourceUnsaved}{m.editor_save_unsaved_changes({}, options)}{:else}{m.editor_save_saved({}, options)}{/if}
        </span>
        <button
          class="btn btn-primary"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={confirming}
          disabled={!dirty || saving || missing.length > 0 || entry.drift.length > 0 || locked || actionBusy}
          title={locked
            ? m.editor_publish_disabled_locked({}, options)
            : entry.drift.length
            ? m.editor_publish_disabled_drift({}, options)
            : missing.length
              ? m.editor_publish_disabled_missing({}, options)
              : undefined}
          onclick={askToPublish}
          bind:this={publishButton}
        >{m.editor_publish({}, options)}</button>
        {#if !entry.singleton}
          <div class="pop-anchor">
            <button
              class="btn btn-ghost more-actions"
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreMenu}
              aria-label={m.editor_more_actions({}, options)}
              disabled={locked || actionBusy}
              onclick={() => (moreMenu = !moreMenu)}
            ><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1.25" /><circle cx="9" cy="9" r="1.25" /><circle cx="14" cy="9" r="1.25" /></svg></button>
            {#if moreMenu}
              <div class={['menu', { 'source-menu': many && present.length > 1 }]} role="menu" aria-label={m.editor_more_actions({}, options)}>
                <button type="button" role="menuitem" onclick={openRename}>{m.editor_rename({}, options)}</button>
                {#if many && present.length > 1}
                  <hr />
                  <button type="button" role="menuitem" aria-describedby="change-source-sub" disabled={sourceBlocked !== undefined} onclick={openSourceChange}>
                    {m.editor_change_source({}, options)}
                    <span class="sub" id="change-source-sub">{sourceBlocked ?? m.editor_change_source_sub({ language: language(entry.sourceLocale) }, options)}</span>
                  </button>
                  <hr />
                {/if}
                <button type="button" role="menuitem" onclick={() => { if (hidden) { moreMenu = false; setStatus(false); } else startHiding(); }}>
                  {hidden ? m.editor_show({}, options) : m.editor_hide({}, options)}
                </button>
                <button type="button" role="menuitem" onclick={startDeleting}>{m.editor_delete({}, options)}</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
    {#if conflicted}
      <p class="subline">{m.editor_conflict_guidance({}, options)}</p>
    {/if}
    {#if held}
      <p class="subline">{m.editor_hold_active({}, options)}</p>
    {/if}
    {#if hidden}
      {@const hiddenRedirect = entry.redirects?.[locale]}
      <p class="subline">
        {#if hiddenRedirect}{m.editor_hidden_redirecting({ address: hiddenRedirect }, options)}{:else}{m.editor_hidden_not_found({}, options)}{/if}
      </p>
    {/if}
    {#if statusFailed}<p class="subline is-bad" role="alert">{feedbackText(statusFailed)} {feedbackDetail(statusFailed)}</p>{/if}
    <div class="workspace-toolbar">
      <div class="toolbar-start">
        <!-- A global has no SEO or versions of its own: no dead section controls. -->
        <!-- Links, not a tablist: each is an address the back button lands on; keep the roles off. -->
        {#if !entry.singleton}
          <nav class="tabs seg editor-sections" aria-label={m.editor_sections({}, options)}>
            <a href={sitePath(`/admin/c/${collection}/${slug}${queueTail}`)} aria-current={section === '' ? 'page' : undefined}>{m.editor_section_content({}, options)}</a>
            {#if seoField}<a href={sitePath(`/admin/c/${collection}/${slug}/seo${queueTail}`)} aria-current={section === 'seo' ? 'page' : undefined}>{m.editor_section_seo({}, options)}</a>{/if}
            <a href={sitePath(`/admin/c/${collection}/${slug}/history${queueTail}`)} aria-current={section === 'history' ? 'page' : undefined}>{m.editor_section_history({}, options)}</a>
          </nav>
        {/if}
      </div>
      <div class="toolbar-center">
        {#if besideOptions.length > 1 || pageShown}
          <div class="seg editor-beside" role="group" aria-label={m.editor_beside({}, options)}>
            {#each besideOptions.filter((of) => of !== 'none') as of (of)}
              <button
                type="button"
                class={{ 'btn-sbs': of === 'language' }}
                aria-pressed={beside === of && mode !== 'canvas'}
                disabled={entry.drift.length > 0}
                onclick={() => leaving(() => (of === 'page' && beside === 'page' ? collapse() : setBeside(!pageShown && side && of === 'language' ? 'none' : of)))}
              ><svg class="workspace-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" />{#if of === 'page'}<path d="M9 3v14M12 7h2M12 10h2" />{:else if of === 'language'}<path d="M10 3v14M5 7h2M13 7h2M5 10h2M13 10h2" />{:else}<path d="M6 7h8M6 10h8M6 13h5" />{/if}</svg><span>{of === 'page' ? m.editor_workspace_preview({}, options) : m.editor_workspace_translate({}, options)}</span></button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="toolbar-end">
        {#if many}
          {#if entry.locales.length < 5}
            <div class="seg" role="group" aria-label={m.editor_language({}, options)}>
              {#each entry.locales as of (of)}
                <button type="button" class={{ 'is-off': off(of) }} aria-pressed={locale === of} onclick={() => leaving(() => (locale = of))}>
                  {of.toUpperCase()}{@render languageMark(of)}
                </button>
              {/each}
            </div>
          {:else}
            <div class="pop-anchor language-pick">
              <button class="btn" type="button" aria-expanded={languageMenu === 'header'} aria-controls="entry-languages" bind:this={languageTrigger} onclick={(e) => { languageMenu = languageMenu === 'header' ? undefined : 'header'; e.currentTarget.focus(); }}>
                <span class="visually-hidden">{`${m.editor_language({}, options)}: `}</span>{language(locale)}{@render languageMark(locale)}
              </button>
              {#if languageMenu === 'header'}
                <div class="menu language-menu" id="entry-languages">
                  {#each entry.locales as of (of)}
                    <button type="button" class={{ 'is-off': off(of) }} aria-pressed={locale === of} onclick={() => chooseLanguage(of)}>{language(of)}{@render languageMark(of)}</button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
        {#if !entry.singleton && canvasSupported}
          <button class="btn canvas-open" type="button" disabled={entry.drift.length > 0} onclick={() => setCanvas(true)}>{m.editor_view_canvas({}, options)}</button>
        {/if}
      </div>
    </div>
  </header>
  {#if section === 'history'}
    <History
      {collection}
      {slug}
      {mediaBase}
      locales={entry.locales}
      drafted={entry.pending.length > 0}
      {uiLocale}
      onrestore={entrySession.historicalRestore}
      onrestored={async (date, outcome) => {
        if (outcome === 'restored') onrestored?.(date);
        // The old session is already closed, so this authoritative replacement bypasses its
        // navigation guard and lands on Content before the parent re-reads every locale.
        navigateAfterAuthoritativeChange(`/admin/c/${collection}/${slug}${queueTail}`);
        await (onreload ? onreload() : onchanged());
      }}
    />
  {:else}
  <!-- Stands where the form would be: every field belongs to a structure not yet agreed on. -->
  <div
    class={[
      'entry-body',
      {
        'has-pane': !entry.drift.length && (mode === 'split' || (mode === 'form' && !alone && shown !== undefined)),
        'is-canvas': mode === 'canvas',
        'is-split': mode === 'split' && !alone,
        'is-full': pageShown && beside === 'none' && !alone,
      },
    ]}
  >
    {#if entry.drift.length}
      <DriftPanel
        {collection}
        {slug}
        drift={entry.drift}
        locales={entry.locales}
        {uiLocale}
        onresolved={entrySession.afterReconciliation}
      />
    {:else}
      {#if mode === 'split' || (mode === 'form' && side && shown && !alone)}
        <div class="canvas-mobile-tabs seg" role="group" aria-label={m.editor_split_pane({}, options)}>
          <button type="button" aria-pressed={mobilePane === 'form'} onclick={() => (mobilePane = 'form')}>{side ? language(entry.sourceLocale) : m.editor_split_form({}, options)}</button>
          <button type="button" aria-pressed={mobilePane === 'page'} onclick={() => (mobilePane = 'page')}>{side && shown ? language(shown) : m.editor_split_page({}, options)}</button>
        </div>
      {/if}
      <!-- Not drawn when a translation is on its own. -->
      {#if mode !== 'canvas' && !alone}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          class={['form', { 'is-mobile-hidden': (mode === 'split' || side) && mobilePane === 'page' }]}
          onsubmit={(e) => e.preventDefault()}
          onfocusout={canvasCompleted}
        >
          <div class="editor-form-heading">
            <div><span class="editor-language-code">{entry.sourceLocale.toUpperCase()}</span><h2>{language(entry.sourceLocale)}</h2></div>
            <span class="editor-source-label">{m.editor_workspace_source({}, options)}</span>
          </div>
          <fieldset disabled={locked || entrySession.localeMutationBlocked(entry.sourceLocale)}>
            <Fields {fields} blocks={shownForm.blocks} blockLabels={shownForm.blockLabels} {problems} {mediaBase} locale={entry.sourceLocale} {uiLocale} session={entrySession} inheritedSeo={inherited(entry.sourceLocale, data)} {site} servedAt={localeUrl(entry.sourceLocale)} bind:root={entrySession.snapshots[entry.sourceLocale]!} structureLocked={entrySession.structureMutationBlocked()} textOnly={entrySession.sourceTextOnly(entry.sourceLocale)} />
          </fieldset>
        </form>
      {/if}
      <!-- Split replaces a comparison pane rather than adding a third column. -->
      {#if mode !== 'canvas' && !(mode === 'split' && !alone) && shown && untranslated(shown)}
        <!-- An empty form here would autosave a file nobody asked for. -->
        <section
          class={['pane is-locale', { 'is-mobile-hidden': (mode === 'split' && mobilePane === 'page') || (side && !alone && mobilePane === 'form') }]}
          aria-labelledby="pane-{shown}"
          onfocusout={canvasCompleted}
        >
          <div class="pane-head">{@render paneHeading(shown)}<span class="spacer"></span>{@render queueNext()}</div>
          <div class="empty">
            {#if off(shown)}
              <div class="is-wide">
                <p>{m.editor_not_offered({ language: language(shown) }, options)}</p>
                {#if putBack}
                  <p>
                    {m.editor_turned_off_before({}, options)} <time datetime={new Date(putBack.at).toISOString()}>{formatExactTime(putBack.at, uiLocale)}</time>{m.editor_turned_off_after({ language: language(shown) }, options)}
                  </p>
                  <button
                    class="btn btn-primary"
                    type="button"
                    disabled={actionBusy || locked}
                    onclick={() =>
                      ask('/admin/api/restore', {
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ commit_sha: putBack?.commit_sha }),
                      })}
                  >
                    {m.editor_restore_words({ language: language(shown) }, options)}
                  </button>
                  <p>
                    {m.editor_or({}, options)} <button class="btn-link" type="button" disabled={actionBusy || locked} onclick={() => offer(shown, true)}>{m.editor_restore_empty({ language: language(shown) }, options)}</button>.
                  </p>
                {:else}
                  <button class="btn" type="button" disabled={actionBusy || locked} onclick={() => offer(shown, true)}>
                    {m.editor_turn_back_on({ language: language(shown) }, options)}
                  </button>
                {/if}
              </div>
            {:else}
              <div class="is-wide">
                <p>{m.editor_create_translation_intro({}, options)}</p>
                <button class="btn btn-primary btn-create" type="button" disabled={actionBusy || locked} onclick={() => createFrom(shown)}>
                  {m.editor_create_from({ language: language(entry.sourceLocale) }, options)}
                </button>
                {#if entry.translator}
                  <button class="btn btn-fill" type="button" disabled={actionBusy || locked} onclick={() => createFilled(shown)}>
                    {m.editor_create_prefill({}, options)}
                  </button>
                {/if}
                {#if missingTargets.length > 1}
                  <p class="create-all">
                    <button class="btn btn-create-all" type="button" disabled={actionBusy || locked} onclick={() => createAll(false)}>
                      {m.editor_create_all({ count: missingTargets.length }, options)}
                    </button>
                    {#if entry.translator}
                      <button class="btn btn-fill-all" type="button" disabled={actionBusy || locked} onclick={() => createAll(true)}>
                        {m.editor_create_all_prefill({ count: missingTargets.length }, options)}
                      </button>
                    {/if}
                  </p>
                {/if}
                {#if creatingAll}
                  <p role="status">{m.editor_creating_language({ language: language(creatingAll) }, options)}</p>
                {/if}
                {#if !entry.singleton}
                  <p>
                    {m.editor_or({}, options)} <button class="btn-link" type="button" disabled={actionBusy || locked} onclick={() => offer(shown, false)}>{m.editor_do_not_offer({ language: language(shown) }, options)}</button> {m.editor_no_file_written({}, options)}
                  </p>
                {/if}
              </div>
            {/if}
            {#if actionFailed}
              <div class="notice notice-danger" role="alert">{feedbackText(actionFailed)} {feedbackDetail(actionFailed)}</div>
            {/if}
            {#if createAllFailure}
              <div class="notice notice-danger" role="alert">
                {feedbackText(createAllFailure)}
                {#if createAllFailure.code === 'CREATE_ALL_RELOAD_FAILED'}
                  <button class="btn-link" type="button" onclick={() => void (onreload ? onreload() : onchanged())}>{m.editor_lock_reload({}, options)}</button>
                {/if}
              </div>
            {/if}
            {#if localeFailure?.locale === shown}
              <div class="notice notice-danger" role="alert">{feedbackText(localeFailure.message)} {feedbackDetail(localeFailure.message)}</div>
            {/if}
          </div>
        </section>
      {:else if mode !== 'canvas' && !(mode === 'split' && !alone) && shown}
        <!-- Keyed: another language is another file, not the same one under a new name. -->
        {#key shown}
          <div
            class={['canvas-form-surface', { 'is-mobile-hidden': (mode === 'split' && mobilePane === 'page') || (side && !alone && mobilePane === 'form') }]}
            onfocusout={canvasCompleted}
          >
            <Translation
              {collection}
              {slug}
              locale={shown}
              session={entrySession}
              {fields}
              blocks={shownForm.blocks}
              blockLabels={shownForm.blockLabels}
              bind:data={entrySession.snapshots[shown]!}
              problems={entrySession.positionalProblems(shown, uiLocale)}
              inheritedSeo={inherited(shown, entrySession.snapshot(shown))}
              source={entry.sourceLocale}
              {locked}
              stale={entry.stale.includes(shown)}
              answered={answered[shown]}
              work={paneWork}
              onjump={jumpTo}
              translator={entry.translator}
              actionBlocked={busy || sending}
              url={localeUrl(shown)}
              {site}
              {uiLocale}
              onsaved={(pending) => {
                renew();
                setPending(shown, pending);
              }}
              {mediaBase}
              heading={paneHeading}
              next={queue ? queueNext : undefined}
              {reference}
              {references}
              mark={languageMark}
              onreference={chooseReference}
              onclose={side ? () => leaving(() => setBeside('none')) : undefined}
              onturnoff={entry.singleton ? undefined : () => { rememberActionTrigger(); actionFailed = undefined; offing = shown; }}
            />
          </div>
        {/key}
      {/if}
      {#if canvasVisited}
        <CanvasWorkspace
          bind:this={canvasPane}
          fullscreen={mode === 'canvas'}
          entryActions={canvasEntryActions}
          publishAction={canvasPublish}
          active={mode === 'split' || mode === 'canvas'}
          {locale}
          {uiLocale}
          {url}
          request={canvasRequest}
          currentVersion={() => entrySession.contentVersion(locale)}
          entryDocument={{ collection, id: slug }}
          ownerLabel={title}
          sourceLocale={entry.sourceLocale}
          session={entrySession}
          blocks={shownForm.blocks}
          blockLabels={shownForm.blockLabels}
          problems={locale === entry.sourceLocale ? problems : entrySession.positionalProblems(locale, uiLocale)}
          onreviewproblems={reviewCanvasProblems}
          {mediaBase}
          {site}
          servedAt={localeUrl(locale)}
          {locked}
          onform={() => setCanvas(false)}
          onnavigateentry={navigateCanvasEntry}
          mobileHidden={mode === 'split' && mobilePane === 'form'}
        />
      {/if}
    {/if}
  </div>
  {/if}
  {#if confirming}
    <PublishConfirmation
      {title}
      {many}
      choice={publishChoice}
      {lines}
      {checksFailed}
      {sending}
      failed={publishFailed}
      {uiLocale}
      returnTo={mode === 'canvas' ? canvasPublishButton : publishButton}
      bind:panel={publishPanel}
      onclose={closePublish}
      onchoose={publishLater}
      onretry={() => void lint()}
      onpublish={publishEntry}
      pending={() => entrySession.persistedActionPending()}
    />
  {/if}
  {#if hiding}
    <OffsiteDialog
      action="hide"
      what={title}
      {collection}
      index={entryUrl('default', routing, entry.index, '', locale) ?? undefined}
      {busy}
      {uiLocale}
      error={statusFailed}
      returnTo={actionTrigger}
      onconfirm={(target: Target) => setStatus(true, target)}
      onclose={() => (hiding = false)}
    />
  {/if}
  {#if changingSource}
    <SourceChange
      locales={entry.locales}
      source={entry.sourceLocale}
      files={sourceFiles}
      offered={entry.offered}
      stale={entry.stale}
      fields={shownForm.fields}
      blocks={shownForm.blocks}
      {uiLocale}
      sending={sendingSource}
      failure={sourceFailure}
      returnTo={actionTrigger}
      onconfirm={changeSourceTo}
      onclose={() => (changingSource = false)}
      onreload={() => void (onreload ? onreload() : onchanged())}
    />
  {/if}
  {#if renaming}
    <Modal labelledby="rename-h" initialFocus="#rename-to" returnTo={actionTrigger} dismissible={!busy} onclose={() => (renaming = false)}>
        <h2 id="rename-h">{m.entry_list_rename_question({ title }, options)}</h2>
        <form onsubmit={rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">{m.entry_list_file_name({}, options)}</label></div>
            <input class="input filename" id="rename-to" type="text" bind:value={newName} aria-describedby="rename-hint" />
            <p class="hint" id="rename-hint">
              {m.entry_list_saved_as({}, options)} <span class="filename">{willBe}</span>. {m.entry_list_rename_hint({}, options)}
            </p>
          </div>
          {#if actionFailed}<div class="notice notice-danger" role="alert">{feedbackText(actionFailed)} {feedbackDetail(actionFailed)}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" disabled={busy} onclick={() => (renaming = false)}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? m.entry_list_renaming({}, options) : m.editor_rename({}, options)}</button>
          </div>
        </form>
    </Modal>
  {/if}
  {#if deleting}
    <OffsiteDialog
      action="delete"
      what={title}
      {collection}
      index={entryUrl('default', routing, entry.index, '', locale) ?? undefined}
      {busy}
      {uiLocale}
      error={actionFailed}
      returnTo={actionTrigger}
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
      {uiLocale}
      error={actionFailed}
      returnTo={actionTrigger}
      onconfirm={(target: Target) => turnOff(going, target)}
      onclose={() => (offing = undefined)}
    />
  {/if}
  {#if taking}
    <Modal labelledby="take-h" returnTo={takeTrigger} dismissible={!takeBusy} onclose={cancelTake}>
        <h2 id="take-h">{holderName
          ? m.editor_lock_take_question({ holder: holderName }, options)
          : m.editor_lock_take_question_anonymous({}, options)}</h2>
        <p>{holderName
          ? m.editor_lock_take_shared({ holder: holderName }, options)
          : m.editor_lock_take_shared_anonymous({}, options)}</p>
        <p>{m.editor_lock_take_refusal({}, options)}</p>
        {#if lockFailed}<p class="notice notice-danger" role="alert">{feedbackText(lockFailed)} {feedbackDetail(lockFailed)}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={takeBusy} onclick={cancelTake}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="button" disabled={takeBusy} onclick={takeOver}>{m.editor_lock_take_over({}, options)}</button>
        </div>
    </Modal>
  {/if}
</main>
