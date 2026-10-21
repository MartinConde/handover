<script lang="ts" module>
import type { UiMessage } from '../errors.js';

// What one Create all did to each language it set out to make; the shell keeps it past the reload.
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
  entryPageUrl,
  entryUrl,
  fieldPosition,
  formIn,
  referenceText,
  resolveSeo,
} from '@handover/core';
import { onMount, type Snippet, tick, untrack } from 'svelte';
import CanvasWorkspace from '../canvas/CanvasWorkspace.svelte';
import type { CanvasSelection } from '../canvas/canvas-protocol';
import type { CanvasRenderRequest } from '../canvas/canvas-renderer';
import OffsiteDialog, { type Target } from '../content/Offsite.svelte';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { messageDetail, messageText, retainedFailure } from '../errors.js';
import { formatExactTime, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import {
  guardEntryActions,
  guardNavigation,
  navigate,
  navigateAfterAuthoritativeChange,
} from '../navigate';
import { type OwedRow, owes, queueQuery, rowTitle, workFrom } from '../owed.js';
import * as m from '../paraglide/messages.js';
import { checkText, localeOf } from '../publishing/CheckLines.svelte';
import DriftPanel from '../publishing/Drift.svelte';
import History from '../publishing/History.svelte';
import {
  request as fetch,
  postJson,
  previewPath,
  siteBase,
  sitePath,
} from '../request.js';
import AutosaveStatus from '../shared/AutosaveStatus.svelte';
import Modal from '../shared/Modal.svelte';
import PublishConfirmation from './PublishConfirmation.svelte';
import {
  createEntrySession,
  type EntryProblem,
  type StructuralSaveEnvelope,
} from './entry-session.svelte';
import EntryBanners from './EntryBanners.svelte';
import Fields from './fields/Fields.svelte';
import type { EditorEntry } from './entry-payload';
import SourceChange from './SourceChange.svelte';
import { classifyDraftSaveRefusal } from './save';
import { createEntryActions } from './entry-actions.svelte';
import { createEntryCreate } from './entry-create.svelte';
import { createEntryLock } from './entry-lock.svelte';
import { createEntryPublish } from './entry-publish.svelte';
import { drawn, focusField, land, revealField } from './field-reveal';
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
  onconflict,
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
  ontopbar,
}: {
  collection: string;
  slug: string;
  // Who is signed in, so a lock held by the same person reads as their other tab.
  userId?: string;
  // Where a stored media key is served from; the image and file widgets draw from it.
  mediaBase?: string;
  // This build serves `/_preview`: without it the editor offers Form only, never Canvas.
  preview?: boolean;
  entry: EditorEntry;
  // Which of the entry's tabs the address is on; empty is the form itself.
  section?: string;
  // The site's origin, for the SEO previews; none, and the panel draws none.
  site?: string;
  uiLocale?: UiLocale;
  // A file of this entry was made, removed or settled, so the entry has to be read again.
  onchanged: () => void | Promise<void>;
  // Re-read the whole entry without flushing the session whose authoritative data changed.
  onreload?: () => void | Promise<void>;
  // Fires only on the save that flips whether this entry has something to publish.
  onpending?: () => void;
  // A successful entry action made a repository commit outside the ordinary publish control.
  oncommitted?: () => void | Promise<void>;
  // This entry went out from its header, named the way the shell should say it.
  onpublished?: (title: string) => void | Promise<void>;
  // Its header publish was refused over a file changed in the repository; the drawer resolves it.
  onconflict?: () => void;
  // A version went into the drafts; the shell remembers its git date past the reload.
  onrestored?: (date: string) => void;
  // The date of the version the unpublished changes were restored from, while they wait.
  restored?: string;
  // The source was changed on purpose; the shell remembers the language past the reload.
  onsourcechanged?: (locale: string) => void;
  // The language this entry was just made to be written in, while that waits to publish.
  sourceChanged?: string;
  // A Create all finished or stopped; the shell keeps its report past the reload.
  oncreatedall?: (report: CreatedAll | undefined) => void;
  // The report of this entry's last Create all, until it is dismissed.
  createdAll?: CreatedAll;
  // Lets the application shell collapse its navigation only for full-width Canvas.
  onmode?: (mode: EditorMode) => void;
  // Hands the shell a live read of the title for its top-bar breadcrumb.
  ontitle?: (read: () => string) => void;
  // Hands the shell the address and actions to draw in its top bar; the cleanup takes them back.
  ontopbar: (parts: { lead: Snippet; actions: Snippet }) => () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const feedbackText = (message: UiMessage) => messageText(message, uiLocale);
function reload() {
  return onreload ? onreload() : onchanged();
}

// The loaded files seed this opened entry's session.
const entryForm = untrack(() => ({ fields: [...entry.fields], blocks: entry.blocks }));
const entrySession = untrack(() =>
  createEntrySession({
    document: `${collection}/${slug}`,
    sourceLocale: entry.sourceLocale,
    data: entry.data,
    translations: entry.translations,
    revisions: entry.revisions,
    form: entryForm,
    problems: { [entry.sourceLocale]: entry.problems },
    drift: entry.drift,
    onactivity: () => entryLock.renew(),
    onreconciled: reload,
  }),
);
const data = $derived(entrySession.snapshot(entry.sourceLocale));
const saveState = $derived(entrySession.saveState(entry.sourceLocale));
// The loaded entry seeds each file's live draft state.
const pendingByLocale = $state<Record<string, boolean>>(
  untrack(() => Object.fromEntries(entry.locales.map((of) => [of, entry.pending.includes(of)]))),
);
const saving = $derived(saveState.phase === 'saving');
const saveFailed = $derived(saveState.phase === 'failed');
let saveError = $state<UiMessage>();
const schemaProblems = $derived(entrySession.positionalProblems(entry.sourceLocale, uiLocale));
const entryPublish = untrack(() =>
  createEntryPublish({
    key: `${collection}/${slug}`,
    session: entrySession,
    pending: () => entry.locales.filter((of) => pendingByLocale[of]),
    many: () => many,
    reload,
    onpublished: () => onpublished?.(title),
    onconflict: () => onconflict?.(),
    focusPanel: () => publishPanel?.focus(),
  }),
);
// Only the source's check errors gate the header; a translation's are the dialog's to offer.
const checkProblems = $derived(
  Object.fromEntries(
    entryPublish.checks
      .filter((c) => c.severity === 'error' && localeOf(c.path) === entry.sourceLocale)
      .flatMap((c) => {
        const at = fieldPosition(c.fieldPath, data);
        return at ? [[at.join('.'), checkText(c, uiLocale)]] : [];
      }),
  ),
);
const problems = $derived({ ...checkProblems, ...schemaProblems });
// The language the entry is written in is where it opens.
let locale = $state(untrack(() => entry.sourceLocale));
let canvasPane = $state<ReturnType<typeof CanvasWorkspace>>();
// Sticky panes below the header sit exactly under it, however many rows it wraps to.
let headerHeight = $state(0);

type EditorMode = 'form' | 'split' | 'canvas';
type Beside = 'page' | 'language' | 'none';
const BESIDE: Beside[] = ['page', 'language', 'none'];
// v3: Form and Split became one view, so earlier saved values mean nothing here.
const viewKey = untrack(() => `handover:editor-view:v3:${siteBase() || '/'}:${userId}`);
// A blocked browser preference must never block editing.
function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept for this visit only.
  }
}
const saved = readPreference(viewKey);
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

// A link that opens a language is for this visit; only the person's own choice is saved.
function setBeside(next: Beside, save = true) {
  if (next === 'none' && pageShown) next = 'page';
  chosen = next;
  collapsed = false;
  canvasOpen = false;
  if (save) savePreference(viewKey, next);
}
function collapse() {
  chosen = undefined;
  collapsed = true;
  canvasOpen = false;
  savePreference(viewKey, 'form');
}
function setCanvas(open: boolean) {
  if (open && !canvasSupported) return;
  canvasOpen = open;
  if (open) mobilePane = 'page';
  savePreference(viewKey, open ? 'canvas' : collapsed && pageShown ? 'form' : beside);
  if (open && section !== '') navigate(`/admin/c/${collection}/${slug}${queueTail}`);
}

$effect(() => {
  if (mode !== 'form') canvasVisited = true;
  onmode?.(mode);
});

// A site with one language draws none of the language controls.
const many = $derived(entry.locales.length > 1);
const drifted = $derived(entry.drift.length > 0);
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
const sourceText = $derived(answeredPaths(wholeForm, data));
const translated = $derived(
  Object.fromEntries(
    others
      .filter((of) => entrySession.hasSnapshot(of))
      .map((of) => [of, answeredPaths(wholeForm, entrySession.snapshot(of))]),
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
const referenceKey = untrack(() => `handover:editor-reference:v1:${siteBase() || '/'}:${userId}`);
let referenceChoice = $state(readPreference(referenceKey) ?? '');
function chooseReference(of: string | undefined) {
  referenceChoice = of ?? '';
  savePreference(referenceKey, referenceChoice);
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
  const text = referenceText(wholeForm, entrySession.snapshot(of), of);
  return { locale: of, label: language(of), ...text };
});

// The list's language filter, carried in the address so remounts and section links keep it.
const opening = new URLSearchParams(location.search);
// Read once per mount, like `?locale=`.
const queue = untrack(() =>
  !entry.singleton && entry.locales.length > 1 && entry.locales.includes(opening.get('queue') ?? '')
    ? (opening.get('queue') ?? undefined)
    : undefined,
);
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
// The turn-off this language can be brought back from, when the CMS is what turned it off.
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


const sourceUnsaved = $derived(entrySession.unsaved(entry.sourceLocale));
const missing = $derived(Object.keys(problems));
const named = $derived(data[entry.titleField ?? 'title']);
const title = $derived(
  entry.labels?.[uiLocale] ?? entry.label ?? (typeof named === 'string' && named ? named : slug),
);
onMount(() => ontitle?.(() => title));
onMount(() => ontopbar({ lead: topbarLead, actions: topbarActions }));
// The SEO panel is its own tab, so the Content form omits the field; a global has no tabs.
const seoField = $derived(!entry.singleton && entry.fields.some((f) => f.type === 'seo'));
// The key the seo field sits under, which is what a problem on it is named by.
const seoAt = $derived(entry.fields.find((f) => f.type === 'seo')?.path[0]);
// Named again when the interface language changes, without reading the entry again.
const shownForm = $derived(
  formIn({ ...wholeForm, blockLabels: entry.blockLabels }, uiLocale),
);
const fields = $derived(
  !seoField
    ? shownForm.fields
    : section === 'seo'
      ? shownForm.fields.filter((f) => f.type === 'seo')
      : shownForm.fields.filter((f) => f.type !== 'seo'),
);
// What one language's page would say with nothing typed: the build's own resolution.
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

// The opened entry owns this lock until remount.
const entryLock = untrack(() =>
  createEntryLock({
    collection,
    slug,
    userId,
    onlost: () => entrySession.closeSaveGate(),
    onchanged,
    failure: retainedFailure,
  }),
);
const entryActions = untrack(() =>
  createEntryActions({
    collection,
    slug,
    queueTail,
    entry: () => entry,
    session: entrySession,
    lock: entryLock,
    present: () => present,
    hidden: entry.hidden === true,
    held: entry.held === true,
    reload,
    onchanged: () => onchanged(),
    oncommitted: () => oncommitted?.(),
    onsourcechanged: (to) => onsourcechanged?.(to),
  }),
);
const actionBusy = $derived(entryActions.busy || entrySession.persistedActionPending());
const entryCreate = untrack(() =>
  createEntryCreate({
    collection,
    slug,
    entry: () => entry,
    session: entrySession,
    actions: entryActions,
    untranslated,
    reload,
    onchanged: () => onchanged(),
    oncreatedall: (report) => oncreatedall?.(report),
  }),
);
let takeTrigger = $state<HTMLButtonElement>();
const canPublish = $derived(dirty && !saving && !missing.length && !drifted && !entryLock.locked && !actionBusy);

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
    const res = await postJson(`/admin/api/drafts/${collection}/${slug}`, {
      data: JSON.parse(sent),
      tab: entryLock.tab,
      revision,
      ...(structure ? { structure } : {}),
    }, 'PUT');
    if (!res.ok) {
      saveError = await retainedFailure(res, 'EDITOR_SAVE_REFUSED');
      const refusal = await classifyDraftSaveRefusal(res.clone());
      if (refusal.kind === 'lock') entryLock.lose(refusal.lock);
      else if (refusal.kind === 'revision') {
        entrySession.freezeHistory();
        // No server detail: its sentence repeats this one.
        saveError = { code: 'EDITOR_SAVE_REVISION', status: res.status };
      }
      return false;
    }
    const body = (await res.json()) as {
      pending: boolean;
      problems: EntryProblem[];
      revisions?: Record<string, string>;
    };
    entrySession.mergeRevisions(body.revisions);
    entryLock.renew();
    setPending(entry.sourceLocale, body.pending);
    invalidateEntryDirectory();
    entrySession.acceptProblems(entry.sourceLocale, body.problems, sent, contentVersion);
    // The checks read the draft rows, so a save that left nothing pending has nothing to lint.
    if (body.pending) void entryPublish.lint();
    else entryPublish.clear();
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
    const res = await postJson(`/admin/api/drafts/${collection}/${slug}/${of}`, { data: JSON.parse(sent), tab: entryLock.tab, revision }, 'PUT');
    if (!res.ok) {
      const refusal = await classifyDraftSaveRefusal(res);
      if (refusal.kind === 'lock') entryLock.lose(refusal.lock);
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
    entryLock.renew();
    setPending(of, body.pending);
    invalidateEntryDirectory();
    // A new revision makes an open dialog's readiness stale.
    if (entryPublish.confirming) void entryPublish.lint();
    return true;
  } catch {
    return false;
  }
}

function flush(): Promise<boolean> {
  return entrySession.flush();
}
const warn = (event: BeforeUnloadEvent) => {
  if (entrySession.unsaved()) {
    event.preventDefault();
    event.returnValue = '';
  }
};
onMount(() => {
  const release = guardNavigation(flush);
  const releaseActions = guardEntryActions({
    key: `${collection}/${slug}`,
    publish: (request) => entrySession.finalPublish(request, reload),
    replace: (request) => entrySession.authoritativeChange(request, reload),
  });
  return () => {
    entrySession.closeSaveGate();
    releaseActions();
    release();
  };
});

let publishMenu = $state(false);

// Every language with a file: the source always, the rest once loaded.
const present = $derived(
  entry.locales.filter((of) => of === entry.sourceLocale || entrySession.hasSnapshot(of)),
);
const saveBroken = $derived(present.some((of) => entrySession.saveState(of).phase === 'failed'));
const sourceBlocked = $derived(
  drifted
    ? m.editor_change_source_drift({}, options)
    : saveBroken
      ? m.editor_change_source_unsaved({}, options)
      : undefined,
);
async function goTo(path: string | undefined) {
  const field = drawn('f', path);
  // A field on the other tab is not on screen: go to that tab, then look for it once only.
  if (!field && path && seoField && path.split('.')[0] === seoAt) {
    // As in `jumpTo`: the shell redraws the section from the address, so the move has to land first.
    if (!(await navigate(`/admin/c/${collection}/${slug}/seo${queueTail}`))) return;
    await tick();
    await land('f', path);
    return;
  }
  await land('f', path);
}

let revealingForm = 0;
let formSelection = 0;
function revealPreview(path: readonly string[], of: string) {
  if (mode !== 'split' || revealingForm || of !== locale) return;
  const address = entrySession.addressForPath(of, path.join('.'));
  if (address) canvasPane?.selectForm(address);
}

async function selectForm(selection: CanvasSelection) {
  const target = selection.target;
  if (
    mode !== 'split' || target.document.collection !== collection ||
    target.document.id !== slug || target.locale !== locale || !entrySession.hasSnapshot(locale)
  ) return;
  const at = fieldPosition(target.address, entrySession.snapshot(locale), wholeForm);
  if (!at) return;
  const request = ++formSelection;
  const of = locale;
  mobilePane = 'form';
  const prefix = locale === entry.sourceLocale ? 'f' : 't';
  revealingForm++;
  try {
    await revealField(prefix, at.join('.'), () => request === formSelection && of === locale && mode === 'split');
  } finally {
    revealingForm--;
  }
}

// The pane's to-do jump: bring the field this source path names on screen and focus it.
async function jumpTo(path: string): Promise<boolean> {
  const of = shown;
  if (!of || !entrySession.hasSnapshot(of)) return false;
  const at = fieldPosition(path, entrySession.snapshot(of));
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
  return focusField(`t-${at.join('.')}`);
}

const goToFirst = () => {
  if (mode === 'canvas') {
    setCanvas(false);
    locale = entry.sourceLocale;
    void tick().then(() => goTo(missing[0]));
  } else return goTo(missing[0]);
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
    if (of === entry.sourceLocale) return goTo(path);
    return land('t', path);
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
  const at = fieldPosition(field, inColumn ? entrySession.snapshot(of) : data);
  if (!at) return;
  void tick().then(() => land(inColumn ? 't' : 'f', at.join('.')));
}
onMount(() => {
  fromAddress();
  void loadQueue();
  // Only a draft gets linted, so an entry with nothing pending is not asked about.
  if (entry.pending.length) void entryPublish.lint();
});

let publishButton = $state<HTMLButtonElement>();
let canvasPublishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();

// Keep the pane mounted until all its changes have been saved.
async function leaving(change: () => void) {
  if (entrySession.unsaved() && !(await flush())) return;
  change();
}

// Five languages and up in the header, two others and up in the pane:
// a disclosure, not role="menu", as on the entry list rows.
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
const url = $derived(
  entryPageUrl(routing, entry, slug, address || slug, locale) ?? '',
);
// The part in front of the address, so what is being typed reads as the URL it will be.
const before = $derived(entryUrl(routing, entry.route, '', locale) ?? '');

// What the Turn-off dialog names; no index when the collection has no page above it.
const localeUrl = (of: string) =>
  entryPageUrl(routing, entry, slug, entry.addresses?.[of] || slug, of) ?? undefined;
const localeIndex = (of: string) => entryUrl(routing, entry.index, '', of) ?? undefined;

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
    if (!entryActions.busy) void saveAddress();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (!entryActions.busy) void cancelAddress();
  }
}

// The screen is read again afterwards so both columns get the address the server settled on.
async function saveAddress() {
  entryActions.busy = true;
  if (!(await flush())) {
    entryActions.busy = false;
    return;
  }
  const res = await postJson(`/admin/api/entries/${collection}/${slug}/address/${locale}`, { address: typed.trim() });
  entryActions.busy = false;
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
  onfocus={entryLock.recheck}
  onpopstate={fromAddress}
  onbeforeunload={warn}
/>
<svelte:document onvisibilitychange={entryLock.recheck} />

{#snippet feedback(message: UiMessage)}{feedbackText(message)} {messageDetail(message, uiLocale)}{/snippet}

{#snippet languageMark(of: string)}
  {#if off(of)}
    <span class="visually-hidden"> — {m.editor_language_off_a11y({}, options)}</span>
  {:else if untranslated(of)}
    <span class="visually-hidden"> — {m.editor_language_untranslated_a11y({}, options)}</span
    ><span class="mark is-empty" aria-hidden="true"></span>
  {:else if entry.stale.includes(of)}
    <span class="visually-hidden">
      — {otherSource(of)
        ? m.editor_language_other_source_a11y(
            { language: language(otherSource(of) ?? ''), source: language(entry.sourceLocale) },
            options,
          )
        : m.editor_language_stale_a11y({ source: language(entry.sourceLocale) }, options)}</span
    ><span class="mark" aria-hidden="true"></span>
  {:else if partial(of)}
    {@const count = partial(of)}
    <span class="visually-hidden">
      — {m.editor_language_partial_a11y(
        { written: count?.written ?? 0, count: count?.of ?? 0 },
        options,
      )}</span
    ><span class="mark is-partial" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet paneHeading(of: string)}
  {#if side && others.length > 1}
    <div class="pop-anchor language-pick">
      <h2 id="pane-{of}">
        <button
          class="btn btn-sm"
          type="button"
          aria-expanded={languageMenu === 'pane'}
          aria-controls="pane-languages"
          bind:this={paneTrigger}
          onclick={(e) => {
            languageMenu = languageMenu === 'pane' ? undefined : 'pane';
            e.currentTarget.focus();
          }}
        >
          <span class="visually-hidden"
            >{`${m.editor_pane_language({ source: language(entry.sourceLocale) }, options)}: `}</span
          >{language(of)}{@render languageMark(of)}
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
  <select
    class="canvas-locale"
    aria-label={m.editor_language({}, options)}
    value={locale}
    onchange={(event) => {
      const nextLocale = event.currentTarget.value;
      void leaving(() => (locale = nextLocale));
    }}
  >
    {#each entry.locales as of (of)}
      <option value={of}
        >{of.toUpperCase()}{off(of)
          ? ` · ${m.editor_language_off({}, options)}`
          : untranslated(of)
            ? ` · ${m.editor_language_new({}, options)}`
            : entry.stale.includes(of)
              ? ` · ${m.editor_language_changed({}, options)}`
              : partial(of)
                ? ` · ${m.editor_language_partial({}, options)}`
                : ''}</option
      >
    {/each}
  </select>
  <AutosaveStatus
    saving={entrySession.saveState(locale).phase === 'saving'}
    failed={entrySession.saveState(locale).phase === 'failed'}
    unsaved={entrySession.unsaved(locale)}
    {uiLocale}
    short
    announce
  />
{/snippet}

{#snippet canvasPublish()}
  <button class="btn btn-primary canvas-publish" type="button" aria-haspopup="dialog" aria-expanded={entryPublish.confirming}
    disabled={!canPublish}
    onclick={entryPublish.open} bind:this={canvasPublishButton}>{m.editor_publish_short({}, options)}</button>
{/snippet}

{#snippet addressRow()}
  <!-- Every entry but a global can be renamed, so the row is there even where the address is not editable. -->
  {#if addressable || !entry.singleton}
    <div class={['slug-row', { 'is-editing': addressable && editing }]}>
      {#if addressable && editing}
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
          <button
            class="btn btn-sm slug-action slug-save"
            type="button"
            aria-label={m.editor_address_save({}, options)}
            title={m.editor_address_save({}, options)}
            disabled={entryActions.busy}
            onclick={saveAddress}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.3 3.5 3.5L16 5.7" /></svg>
          </button>
          <button
            class="btn btn-ghost btn-sm slug-action slug-cancel"
            type="button"
            aria-label={m.editor_address_cancel({}, options)}
            title={m.editor_address_cancel({}, options)}
            disabled={entryActions.busy}
            onclick={cancelAddress}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10m0-10L5 15" /></svg>
          </button>
        </span>
        {#if addressFailed}<span class="mode is-bad">{@render feedback(addressFailed)}</span>{/if}
      {:else}
        {#if addressable}
          <button
            class="btn-link url slug-edit"
            type="button"
            bind:this={addressTrigger}
            disabled={entryLock.locked}
            aria-label={`${m.editor_address_edit({}, options)}: ${url}`}
            onclick={editAddress}>{url}</button
          >
          {#if !address}<span class="mode">{m.editor_address_file_name({}, options)}</span>{/if}
        {:else if url}
          <span class="url">{url}</span>
        {/if}
        {#if !entry.singleton}{#if addressable || url}<span class="sep" aria-hidden="true">·</span
            >{/if}<button
            class="btn-link slug-rename"
            type="button"
            disabled={entryLock.locked || actionBusy}
            onclick={entryActions.openRename}>{m.editor_change_file_name({}, options)}</button
          >{/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet topbarLead()}
  {#if entryActions.hidden && !entry.singleton}<span class="badge">{m.editor_status_hidden({}, options)}</span>{/if}
  {#if entryPublish.conflicted}<span class="badge badge-danger">{m.pending_changed_repository({}, options)}</span>{/if}
{/snippet}

{#snippet topbarActions()}
  {#if missing.length}
    <button class="problems" type="button" onclick={goToFirst}>
      {m.editor_problem_count({ count: missing.length }, options)}
    </button>
  {/if}
  <AutosaveStatus {saving} failed={saveFailed} unsaved={sourceUnsaved} {uiLocale} />
  <div class="publish-split pop-anchor">
    <button
      class="btn btn-primary"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={entryPublish.confirming}
      disabled={!canPublish}
      title={entryLock.locked
        ? m.editor_publish_disabled_locked({}, options)
        : drifted
        ? m.editor_publish_disabled_drift({}, options)
        : missing.length
          ? m.editor_publish_disabled_missing({}, options)
          : undefined}
      onclick={entryPublish.open}
      bind:this={publishButton}
    >{m.editor_publish({}, options)}</button>
    <button
      class="btn btn-primary publish-more"
      type="button"
      aria-haspopup="menu"
      aria-expanded={publishMenu}
      aria-label={m.editor_ready_to_publish({}, options)}
      disabled={entryLock.locked ||
        actionBusy ||
        (entry.singleton && (entryLock.lost || (!dirty && !entryActions.held)))}
      onclick={() => (publishMenu = !publishMenu)}
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></button
    >
    {#if publishMenu}
      <div
        class="menu publish-menu"
        role="menu"
        aria-label={m.editor_ready_to_publish({}, options)}
      >
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={!entryActions.held}
          aria-describedby={dirty || entryActions.held ? undefined : 'hold-unavailable'}
          disabled={entryLock.lost || (!dirty && !entryActions.held)}
          onclick={() => {
            publishMenu = false;
            void entryActions.toggleHold();
          }}
        >
          <span class="check" aria-hidden="true"
            ><svg viewBox="0 0 20 20"><path d="m4 10.3 3.5 3.5L16 5.7" /></svg></span
          >
          {m.editor_ready_to_publish({}, options)}
          {#if !dirty && !entryActions.held}<span class="sub" id="hold-unavailable"
              >{m.editor_hold_unavailable({}, options)}</span
            >{/if}
        </button>
        <!-- Nothing lists a global, so there is nothing to take it off the site from. -->
        {#if !entry.singleton}
          <button
            type="button"
            role="menuitem"
            onclick={() => {
              publishMenu = false;
              if (entryActions.hidden) entryActions.setStatus(false);
              else entryActions.startHiding();
            }}
          >
            <span class="check" aria-hidden="true"></span>
            {entryActions.hidden ? m.editor_show_on_site({}, options) : m.editor_hide_from_site({}, options)}
          </button>
        {/if}
        {#if hasPending()}
          <button type="button" role="menuitem" onclick={() => { publishMenu = false; entryActions.startDiscarding(); }}>
            <span class="check" aria-hidden="true"></span>
            {m.editor_discard_changes({}, options)}
          </button>
        {/if}
      </div>
    {/if}
  </div>
  {#if !entry.singleton}
    <button
      class="btn btn-ghost more-actions delete-entry"
      type="button"
      aria-label={m.editor_delete({}, options)}
      title={m.editor_delete({}, options)}
      disabled={entryLock.locked || actionBusy}
      onclick={entryActions.startDeleting}
      ><svg viewBox="0 0 24 24" aria-hidden="true"
        ><path
          d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        /></svg
      ></button
    >
  {/if}
{/snippet}

<main
  class={['main main-editor', { 'is-canvas-fullscreen': mode === 'canvas' }]}
  style:--entry-header-h={`calc(var(--topbar-stuck, 0px) + ${headerHeight}px)`}
>
  {#if entryActions.actionFailed && !entryActions.renaming && !entryActions.deleting && !entryActions.offing && !entryActions.discarding}<p
      class="notice notice-danger"
      role="alert"
    >
      {@render feedback(entryActions.actionFailed)}
    </p>{/if}
  {#if entryActions.holdFailed}<p class="notice notice-danger" role="alert">
      {@render feedback(entryActions.holdFailed)}
    </p>{/if}
  {#if saveError}<p class="notice notice-danger" role="alert">
      {@render feedback(saveError)}
      <button class="btn-link" type="button" onclick={() => flush()}
        >{m.editor_save_retry({}, options)}</button
      >
    </p>{/if}
  <EntryBanners
    {entry}
    {entryLock}
    {uiLocale}
    {drifted}
    {restored}
    {sourceChanged}
    {createdAll}
    reportedHere={entryCreate.reportedHere}
    hasSnapshot={entrySession.hasSnapshot}
    bind:takeTrigger
    {reload}
    {oncreatedall}
    {feedback}
  />
  <header class={['entry-header', { 'is-held': entryActions.held }]} bind:offsetHeight={headerHeight}>
    <h1 class="visually-hidden">{title}</h1>
    {#if entryPublish.conflicted}
      <p class="subline">{m.editor_conflict_guidance({}, options)}</p>
    {/if}
    {#if entryActions.held}
      <p class="subline">{m.editor_hold_active({}, options)}</p>
    {/if}
    {#if entryActions.hidden}
      {@const hiddenRedirect = entry.redirects?.[locale]}
      <p class="subline">
        {#if hiddenRedirect}{m.editor_hidden_redirecting({ address: hiddenRedirect }, options)}{:else}{m.editor_hidden_not_found({}, options)}{/if}
      </p>
    {/if}
    {#if entryActions.statusFailed}<p class="subline is-bad" role="alert">{@render feedback(entryActions.statusFailed)}</p>{/if}
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
              <button
                class="btn"
                type="button"
                aria-expanded={languageMenu === 'header'}
                aria-controls="entry-languages"
                bind:this={languageTrigger}
                onclick={(e) => {
                  languageMenu = languageMenu === 'header' ? undefined : 'header';
                  e.currentTarget.focus();
                }}
              >
                <span class="visually-hidden">{`${m.editor_language({}, options)}: `}</span
                >{language(locale)}{@render languageMark(locale)}
              </button>
              {#if languageMenu === 'header'}
                <div class="menu language-menu" id="entry-languages">
                  {#each entry.locales as of (of)}
                    <button
                      type="button"
                      class={{ 'is-off': off(of) }}
                      aria-pressed={locale === of}
                      onclick={() => chooseLanguage(of)}
                      >{language(of)}{@render languageMark(of)}</button
                    >
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
        {#if besideOptions.length > 1 || pageShown || (!entry.singleton && canvasSupported)}
          <div class="seg editor-beside" role="group" aria-label={m.editor_beside({}, options)}>
            {#if besideOptions.length > 1 || pageShown}
              {#each besideOptions.filter((of) => of !== 'none') as of (of)}
                {@const label = of === 'page' ? m.editor_workspace_preview({}, options) : m.editor_workspace_translate({}, options)}
                <button
                  type="button"
                  class={{ 'btn-sbs': of === 'language' }}
                  title={label}
                  aria-pressed={beside === of && mode !== 'canvas'}
                  disabled={drifted}
                  onclick={() =>
                    leaving(() =>
                      of === 'page' && beside === 'page'
                        ? collapse()
                        : setBeside(!pageShown && side && of === 'language' ? 'none' : of),
                    )}
                  ><svg class="workspace-icon" viewBox="0 0 20 20" aria-hidden="true"
                    ><rect x="3" y="3" width="14" height="14" rx="2" />{#if of === 'page'}<path
                        d="M9 3v14M12 7h2M12 10h2"
                      />{:else}<path d="M10 3v14M5 7h2M13 7h2M5 10h2M13 10h2" />{/if}</svg
                  ><span class="visually-hidden">{label}</span></button
                >
              {/each}
            {/if}
            {#if !entry.singleton && canvasSupported}
              <button
                class="canvas-open"
                type="button"
                title={m.editor_view_canvas({}, options)}
                disabled={drifted}
                onclick={() => setCanvas(true)}
                ><svg class="workspace-icon" viewBox="0 0 20 20" aria-hidden="true"
                  ><path d="M7.5 3H3v4.5M12.5 3H17v4.5M7.5 17H3v-4.5M12.5 17H17v-4.5" /></svg
                ><span class="visually-hidden">{m.editor_view_canvas({}, options)}</span></button
              >
            {/if}
          </div>
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
        await reload();
      }}
    />
  {:else}
    <div
      class={[
        'entry-body',
        {
          'has-pane':
            !drifted && (mode === 'split' || (mode === 'form' && !alone && shown !== undefined)),
          'is-canvas': mode === 'canvas',
          'is-split': mode === 'split',
          'is-full': pageShown && beside === 'none' && !alone,
        },
      ]}
    >
      {#if drifted}
        <!-- Stands where the form would be: every field belongs to a structure not yet agreed on. -->
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
          <div
            class="canvas-mobile-tabs seg"
            role="group"
            aria-label={m.editor_split_pane({}, options)}
          >
            <button
              type="button"
              aria-pressed={mobilePane === 'form'}
              onclick={() => (mobilePane = 'form')}
              >{side ? language(entry.sourceLocale) : m.editor_split_form({}, options)}</button
            >
            <button
              type="button"
              aria-pressed={mobilePane === 'page'}
              onclick={() => (mobilePane = 'page')}
              >{side && shown ? language(shown) : m.editor_split_page({}, options)}</button
            >
          </div>
        {/if}
        <!-- Not drawn when a translation is on its own. -->
        {#if mode !== 'canvas' && !alone}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <form
            class={[
              'form',
              { 'is-mobile-hidden': (mode === 'split' || side) && mobilePane === 'page' },
            ]}
            onsubmit={(e) => e.preventDefault()}
            onfocusout={canvasCompleted}
          >
            <div class="editor-form-heading">
              <div
                ><span class="editor-language-code">{entry.sourceLocale.toUpperCase()}</span><h2
                  >{language(entry.sourceLocale)}</h2
                ></div
              >
              <span class="editor-source-label">
                {m.editor_workspace_source({}, options)}
                <!-- The source is a property of this form, so it is changed from the form's own heading. -->
                {#if many && present.length > 1}
                  <span class="sep" aria-hidden="true">·</span>
                  <button
                    class="btn-link"
                    type="button"
                    disabled={sourceBlocked !== undefined || entryLock.locked}
                    title={sourceBlocked ??
                      m.editor_change_source_sub(
                        { language: language(entry.sourceLocale) },
                        options,
                      )}
                    onclick={entryActions.openSourceChange}>{m.editor_change_source({}, options)}</button
                  >
                {/if}
              </span>
            </div>
            <fieldset
              disabled={entryLock.locked || entrySession.localeMutationBlocked(entry.sourceLocale)}
            >
              <Fields
                {fields}
                onreveal={(path) => revealPreview(path, entry.sourceLocale)}
                blocks={shownForm.blocks}
                blockLabels={shownForm.blockLabels}
                {problems}
                {mediaBase}
                locale={entry.sourceLocale}
                {uiLocale}
                session={entrySession}
                inheritedSeo={inherited(entry.sourceLocale, data)}
                {site}
                servedAt={localeUrl(entry.sourceLocale)}
                bind:root={entrySession.snapshots[entry.sourceLocale]!}
                structureLocked={entrySession.structureMutationBlocked()}
                textOnly={entrySession.sourceTextOnly(entry.sourceLocale)}
                afterTitle={locale === entry.sourceLocale ? addressRow : undefined}
                titleKey={entry.titleField}
              />
            </fieldset>
          </form>
        {/if}
        <!-- Split replaces a comparison pane rather than adding a third column. -->
        {#if mode !== 'canvas' && !(mode === 'split' && !alone) && shown && untranslated(shown)}
          <!-- An empty form here would autosave a file nobody asked for. -->
          <section
            class={[
              'pane is-locale',
              {
                'is-mobile-hidden':
                  (mode === 'split' && mobilePane === 'page') ||
                  (side && !alone && mobilePane === 'form'),
              },
            ]}
            aria-labelledby="pane-{shown}"
            onfocusout={canvasCompleted}
          >
            <div class="pane-head"
              >{@render paneHeading(shown)}<span class="spacer"></span>{@render queueNext()}</div
            >
            <div class="empty">
              {#if off(shown)}
                <div class="is-wide">
                  <p>{m.editor_not_offered({ language: language(shown) }, options)}</p>
                  {#if putBack}
                    <p>
                      {m.editor_turned_off_before({}, options)}
                      <time datetime={new Date(putBack.at).toISOString()}
                        >{formatExactTime(putBack.at, uiLocale)}</time
                      >{m.editor_turned_off_after({ language: language(shown) }, options)}
                    </p>
                    <button
                      class="btn btn-primary"
                      type="button"
                      disabled={actionBusy || entryLock.locked}
                      onclick={() => entryActions.ask('/admin/api/restore', { commit_sha: putBack?.commit_sha })}
                    >
                      {m.editor_restore_words({ language: language(shown) }, options)}
                    </button>
                    <p>
                      {m.editor_or({}, options)}
                      <button
                        class="btn-link"
                        type="button"
                        disabled={actionBusy || entryLock.locked}
                        onclick={() => entryActions.offer(shown, true)}
                        >{m.editor_restore_empty({ language: language(shown) }, options)}</button
                      >.
                    </p>
                  {:else}
                    <button
                      class="btn"
                      type="button"
                      disabled={actionBusy || entryLock.locked}
                      onclick={() => entryActions.offer(shown, true)}
                    >
                      {m.editor_turn_back_on({ language: language(shown) }, options)}
                    </button>
                  {/if}
                </div>
              {:else}
                <div class="is-wide">
                  <p>{m.editor_create_translation_intro({}, options)}</p>
                  <button
                    class="btn btn-primary btn-create"
                    type="button"
                    disabled={actionBusy || entryLock.locked}
                    onclick={() => entryCreate.createInPane(shown, false)}
                  >
                    {m.editor_create_from({ language: language(entry.sourceLocale) }, options)}
                  </button>
                  {#if entry.translator}
                    <button
                      class="btn btn-fill"
                      type="button"
                      disabled={actionBusy || entryLock.locked}
                      onclick={() => entryCreate.createInPane(shown, true)}
                    >
                      {m.editor_create_prefill({}, options)}
                    </button>
                  {/if}
                  {#if entryCreate.missingTargets.length > 1}
                    <p>
                      <button
                        class="btn btn-create-all"
                        type="button"
                        disabled={actionBusy || entryLock.locked}
                        onclick={() => entryCreate.createAll(false)}
                      >
                        {m.editor_create_all({ count: entryCreate.missingTargets.length }, options)}
                      </button>
                      {#if entry.translator}
                        <button
                          class="btn btn-fill-all"
                          type="button"
                          disabled={actionBusy || entryLock.locked}
                          onclick={() => entryCreate.createAll(true)}
                        >
                          {m.editor_create_all_prefill({ count: entryCreate.missingTargets.length }, options)}
                        </button>
                      {/if}
                    </p>
                  {/if}
                  {#if entryCreate.creatingAll}
                    <p role="status"
                      >{m.editor_creating_language({ language: language(entryCreate.creatingAll) }, options)}</p
                    >
                  {/if}
                  {#if !entry.singleton}
                    <p>
                      {m.editor_or({}, options)}
                      <button
                        class="btn-link"
                        type="button"
                        disabled={actionBusy || entryLock.locked}
                        onclick={() => entryActions.offer(shown, false)}
                        >{m.editor_do_not_offer({ language: language(shown) }, options)}</button
                      >
                      {m.editor_no_file_written({}, options)}
                    </p>
                  {/if}
                </div>
              {/if}
              {#if entryActions.actionFailed}
                <div class="notice notice-danger" role="alert">{@render feedback(entryActions.actionFailed)}</div
                >
              {/if}
              {#if entryCreate.createAllFailure}
                <div class="notice notice-danger" role="alert">
                  {feedbackText(entryCreate.createAllFailure)}
                  {#if entryCreate.createAllFailure.code === 'CREATE_ALL_RELOAD_FAILED'}
                    <button class="btn-link" type="button" onclick={() => void reload()}
                      >{m.editor_lock_reload({}, options)}</button
                    >
                  {/if}
                </div>
              {/if}
              {#if entryCreate.localeFailure?.locale === shown}
                <div class="notice notice-danger" role="alert"
                  >{@render feedback(entryCreate.localeFailure.message)}</div
                >
              {/if}
            </div>
          </section>
        {:else if mode !== 'canvas' && !(mode === 'split' && !alone) && shown}
          <!-- Keyed: another language is another file, not the same one under a new name. -->
          {#key shown}
            <div
              class={[
                'canvas-form-surface',
                {
                  'is-mobile-hidden':
                    (mode === 'split' && mobilePane === 'page') ||
                    (side && !alone && mobilePane === 'form'),
                },
              ]}
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
                locked={entryLock.locked}
                stale={entry.stale.includes(shown)}
                answered={answered[shown]}
                work={paneWork}
                onjump={jumpTo}
                onreveal={(path) => revealPreview(path, shown)}
                translator={entry.translator}
                actionBlocked={entryActions.busy || entryPublish.sending}
                url={localeUrl(shown)}
                {site}
                {uiLocale}
                onsaved={(pending) => {
                  entryLock.renew();
                  setPending(shown, pending);
                }}
                {mediaBase}
                heading={paneHeading}
                afterTitle={shown === locale ? addressRow : undefined}
                titleKey={entry.titleField}
                next={queue ? queueNext : undefined}
                {reference}
                {references}
                mark={languageMark}
                onreference={chooseReference}
                onclose={side ? () => leaving(() => setBeside('none')) : undefined}
                onturnoff={entry.singleton
                  ? undefined
                  : () => entryActions.startOffing(shown)}
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
            problems={locale === entry.sourceLocale
              ? problems
              : entrySession.positionalProblems(locale, uiLocale)}
            onreviewproblems={reviewCanvasProblems}
            onselectform={selectForm}
            {mediaBase}
            {site}
            servedAt={localeUrl(locale)}
            locked={entryLock.locked}
            onform={() => setCanvas(false)}
            onnavigateentry={navigateCanvasEntry}
            mobileHidden={mode === 'split' && mobilePane === 'form'}
          />
        {/if}
      {/if}
    </div>
  {/if}
  {#if entryPublish.confirming}
    <PublishConfirmation
      {title}
      {many}
      choice={entryPublish.choice}
      lines={entryPublish.lines}
      checksFailed={entryPublish.checksFailed}
      sending={entryPublish.sending}
      failed={entryPublish.failed}
      {uiLocale}
      returnTo={mode === 'canvas' ? canvasPublishButton : publishButton}
      bind:panel={publishPanel}
      onclose={entryPublish.close}
      onchoose={entryPublish.later}
      onretry={() => void entryPublish.lint()}
      onpublish={entryPublish.send}
      pending={() => entrySession.persistedActionPending()}
    />
  {/if}
  {#if entryActions.hiding}
    <OffsiteDialog
      action="hide"
      what={title}
      {collection}
      index={entryUrl(routing, entry.index, '', locale) ?? undefined}
      busy={entryActions.busy}
      {uiLocale}
      error={entryActions.statusFailed}
      returnTo={entryActions.actionTrigger}
      onconfirm={(target: Target) => entryActions.setStatus(true, target)}
      onclose={() => (entryActions.hiding = false)}
    />
  {/if}
  {#if entryActions.changingSource}
    <SourceChange
      locales={entry.locales}
      source={entry.sourceLocale}
      files={entryActions.sourceFiles}
      offered={entry.offered}
      stale={entry.stale}
      fields={shownForm.fields}
      blocks={shownForm.blocks}
      {uiLocale}
      sending={entryActions.sendingSource}
      failure={entryActions.sourceFailure}
      returnTo={entryActions.actionTrigger}
      onconfirm={entryActions.changeSourceTo}
      onclose={() => (entryActions.changingSource = false)}
      onreload={() => void reload()}
    />
  {/if}
  {#if entryActions.renaming}
    <Modal labelledby="rename-h" initialFocus="#rename-to" returnTo={entryActions.actionTrigger} dismissible={!entryActions.busy} onclose={() => (entryActions.renaming = false)}>
        <h2 id="rename-h">{m.entry_list_rename_question({ title }, options)}</h2>
        <form onsubmit={entryActions.rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">{m.entry_list_file_name({}, options)}</label></div>
            <input class="input filename" id="rename-to" type="text" bind:value={entryActions.newName} aria-describedby="rename-hint" />
            <p class="hint" id="rename-hint">
              {m.entry_list_saved_as({}, options)} <span class="filename">{entryActions.willBe}</span>. {m.entry_list_rename_hint({}, options)}
            </p>
          </div>
          {#if entryActions.actionFailed}<div class="notice notice-danger" role="alert">{@render feedback(entryActions.actionFailed)}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" disabled={entryActions.busy} onclick={() => (entryActions.renaming = false)}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-primary" type="submit" disabled={entryActions.busy}>{entryActions.busy ? m.entry_list_renaming({}, options) : m.editor_rename({}, options)}</button>
          </div>
        </form>
    </Modal>
  {/if}
  {#if entryActions.deleting}
    <OffsiteDialog
      action="delete"
      what={title}
      {collection}
      index={entryUrl(routing, entry.index, '', locale) ?? undefined}
      busy={entryActions.busy}
      {uiLocale}
      error={entryActions.actionFailed}
      returnTo={entryActions.actionTrigger}
      onconfirm={entryActions.remove}
      onhide={() => { entryActions.deleting = false; entryActions.hiding = true; }}
      onclose={() => (entryActions.deleting = false)}
    />
  {/if}
  {#if entryActions.discarding}
    <Modal labelledby="discard-h" returnTo={entryActions.actionTrigger} dismissible={!entryActions.discardBusy} onclose={() => (entryActions.discarding = false)}>
        <h2 id="discard-h">{m.pending_discard_question({ title }, options)}</h2>
        <p>{entry.published.length ? m.pending_discard_explanation({}, options) : m.pending_discard_created({}, options)}</p>
        {#if entryActions.actionFailed}<div class="notice notice-danger" role="alert">{@render feedback(entryActions.actionFailed)}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={entryActions.discardBusy} onclick={() => (entryActions.discarding = false)}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-danger" type="button" disabled={entryActions.discardBusy} onclick={entryActions.discardDraft}>
            {entryActions.discardBusy ? m.pending_discarding({}, options) : m.pending_discard_changes({}, options)}
          </button>
        </div>
    </Modal>
  {/if}
  {#if entryActions.offing}
    {@const going = entryActions.offing}
    <OffsiteDialog
      action="off"
      language={language(going)}
      what={title}
      served={localeUrl(going)}
      {collection}
      index={localeIndex(going)}
      busy={entryActions.busy}
      {uiLocale}
      error={entryActions.actionFailed}
      returnTo={entryActions.actionTrigger}
      onconfirm={(target: Target) => entryActions.turnOff(going, target)}
      onclose={() => (entryActions.offing = undefined)}
    />
  {/if}
  {#if entryLock.taking}
    <Modal labelledby="take-h" returnTo={takeTrigger} dismissible={!entryLock.takeBusy} onclose={entryLock.cancelTake}>
        <h2 id="take-h">{entryLock.holderName
          ? m.editor_lock_take_question({ holder: entryLock.holderName }, options)
          : m.editor_lock_take_question_anonymous({}, options)}</h2>
        <p>{entryLock.holderName
          ? m.editor_lock_take_shared({ holder: entryLock.holderName }, options)
          : m.editor_lock_take_shared_anonymous({}, options)}</p>
        <p>{m.editor_lock_take_refusal({}, options)}</p>
        {#if entryLock.takeFailure}<p class="notice notice-danger" role="alert">{@render feedback(entryLock.takeFailure)}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={entryLock.takeBusy} onclick={entryLock.cancelTake}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="button" disabled={entryLock.takeBusy} onclick={entryLock.takeOver}>{m.editor_lock_take_over({}, options)}</button>
        </div>
    </Modal>
  {/if}
</main>
