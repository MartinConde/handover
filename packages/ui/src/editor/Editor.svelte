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
} from '@handover/core';
import { onMount, tick } from 'svelte';
import CanvasWorkspace from '../canvas/CanvasWorkspace.svelte';
import type { CanvasRenderRequest } from '../canvas/canvas-renderer';
import OffsiteDialog, { type Target } from '../content/Offsite.svelte';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatExactTime, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import {
  guardEntryActions,
  guardNavigation,
  navigate,
  navigateAfterAuthoritativeChange,
} from '../navigate';
import * as m from '../paraglide/messages.js';
import CheckLines, {
  type CheckItem,
  merged,
  plural,
  verdict,
} from '../publishing/CheckLines.svelte';
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
import {
  createEntrySession,
  type EntryProblem,
  type StructuralSaveEnvelope,
} from './entry-session.svelte';
import Fields from './fields/Fields.svelte';
import { classifyDraftSaveRefusal } from './save';
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
  site,
  uiLocale = 'en',
  onmode,
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
    problems: EntryProblem[];
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
  /** Lets the application shell collapse its navigation only for full-width Canvas. */
  onmode?: (mode: EditorMode) => void;
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
let canvasPane = $state<ReturnType<typeof CanvasWorkspace>>();

type EditorMode = 'form' | 'split' | 'canvas';
const MODES: EditorMode[] = ['form', 'split', 'canvas'];
const modeLabel = (value: EditorMode) =>
  value === 'form'
    ? m.editor_view_form({}, options)
    : value === 'split'
      ? m.editor_view_split({}, options)
      : m.editor_view_canvas({}, options);
// svelte-ignore state_referenced_locally -- one authenticated editor instance owns one preference key
const modeKey = `handover:canvas-mode:v1:${siteBase() || '/'}:${userId}`;
const readMode = (): EditorMode => {
  try {
    const value = localStorage.getItem(modeKey);
    return MODES.includes(value as EditorMode) ? (value as EditorMode) : 'form';
  } catch {
    return 'form';
  }
};
let preferredMode = $state<EditorMode>(readMode());
const canvasSupported = $derived(preview && Boolean(entry.route));
const mode = $derived(section === '' && canvasSupported ? preferredMode : ('form' as EditorMode));
let canvasVisited = $state(false);
let mobilePane = $state<'form' | 'page'>('form');
const canvasEpoch = crypto.randomUUID();

function setMode(next: EditorMode) {
  if (next !== 'form' && !canvasSupported) return;
  preferredMode = next;
  if (next !== 'form') {
    canvasVisited = true;
    mobilePane = next === 'canvas' ? 'page' : mobilePane;
  }
  try {
    localStorage.setItem(modeKey, next);
  } catch {
    // A blocked browser preference must never block editing.
  }
  if (section !== '') navigate(`/admin/c/${collection}/${slug}`);
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
  } else actionFailed = await res.text();
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
let takeTrigger = $state<HTMLButtonElement>();
function cancelTake() {
  taking = false;
  lockFailed = undefined;
}
// When the last answer came back, and when this tab last extended a lock of its own.
let asked = $state(0);
let beatAt = 0;
const locked = $derived(lost || (lock !== undefined && !lock.mine));
const holderName = $derived(lock?.held_by?.name);
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
  const reloadAfterExternalAction = () => (onreload ? onreload() : onchanged());
  const releaseActions = guardEntryActions({
    key: `${collection}/${slug}`,
    publish: (request) => entrySession.finalPublish(request, reloadAfterExternalAction),
    replace: (request) => entrySession.authoritativeChange(request, reloadAfterExternalAction),
  });
  const warn = (event: BeforeUnloadEvent) => {
    if (unsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  addEventListener('beforeunload', warn);
  return () => {
    entrySession.closeSaveGate();
    releaseActions();
    release();
    removeEventListener('beforeunload', warn);
  };
});

// The entry is read again afterwards: carrying on means loading the shared draft they left.
async function takeOver() {
  busy = true;
  lockFailed = undefined;
  const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ take: true, tab }),
  });
  busy = false;
  if (!res.ok) {
    lockFailed = await retainedFailure(res, 'EDITOR_LOCK_TAKE_FAILED');
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
let actionTrigger = $state<HTMLElement>();
let newName = $state('');
let actionFailed = $state('');
let lockFailed = $state<UiMessage>();
let holdFailed = $state<UiMessage>();
const willBe = $derived(entryName('default', newName, []));

function openRename() {
  rememberActionTrigger();
  moreMenu = false;
  newName = slug;
  actionFailed = '';
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
  actionFailed = '';
  deleting = true;
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
  await announceCommit(res);
  const { slug: to } = (await res.json()) as { slug: string };
  invalidateEntryDirectory();
  navigate(`/admin/c/${collection}/${to}`);
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
const goToFirst = () => {
  if (mode === 'canvas') {
    setMode('form');
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
  setMode('form');
  if (of !== entry.sourceLocale) side = true;
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
  if (!field && !requestedLocale) return;
  const of = requestedLocale || entry.sourceLocale;
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
  if (!field) return;
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
let canvasPublishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();

const going = $derived(entry.locales.filter((of) => pendingByLocale[of]));

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
  if (sending) return;
  confirming = false;
}

async function publishEntry() {
  if (entrySession.persistedActionPending()) return;
  sending = true;
  publishFailed = '';
  let res: Response | undefined;
  let checksBlocked = false;
  const outcome = await entrySession.finalPublish(
    async () => {
      // Again after reserving the session: the dialog may have been open while more was typed.
      await lint();
      if (errors.length) {
        checksBlocked = true;
        return false;
      }
      res = await fetch('/admin/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: [`${collection}/${slug}`] }),
      });
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
    publishFailed =
      'Nothing was published. Your latest changes could not be saved — check your connection and try again.';
    publishPanel?.focus();
    return;
  }
  if (checksBlocked) {
    // A disabled button drops the focus that pressed it.
    publishFailed =
      'Nothing was published. The checks found something in the way just now — it is listed above.';
    publishPanel?.focus();
    return;
  }
  if (outcome.reason === 'uncertain') {
    publishFailed =
      'The publish response was lost, so this entry is being reloaded before you continue.';
    return;
  }
  if (outcome.reason === 'reload') {
    publishFailed = 'The entry was published, but this screen could not reload. Reload the page.';
    return;
  }
  if (!res) {
    publishFailed = 'Nothing was published. Try again.';
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
  side = target.locale !== entry.sourceLocale;
  if (mode === 'split') mobilePane = 'page';
  void tick().then(() => canvasPane?.schedule());
}

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
  invalidateEntryDirectory();
  onchanged();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<svelte:window
  onfocus={recheck}
  onpopstate={fromAddress}
/>
<svelte:document onvisibilitychange={recheck} />

{#snippet canvasEntryActions()}
  <select class="canvas-locale" aria-label={m.editor_language({}, options)} value={locale}
    onchange={(event) => { const nextLocale = event.currentTarget.value; void leaving(() => (locale = nextLocale)); }}>
    {#each entry.locales as of (of)}
      <option value={of}>{of.toUpperCase()}{off(of) ? ` · ${m.editor_language_off({}, options)}` : untranslated(of) ? ` · ${m.editor_language_new({}, options)}` : entry.stale.includes(of) ? ` · ${m.editor_language_changed({}, options)}` : ''}</option>
    {/each}
  </select>
  <span class="autosave" class:is-saving={entrySession.saveState(locale).phase === 'saving'}
    class:is-offline={entrySession.saveState(locale).phase === 'failed'} role="status">
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

<main class="main main-editor" class:is-canvas-fullscreen={mode === 'canvas'}>
  {#if actionFailed && !renaming && !deleting && !offing}<p class="notice notice-danger" role="alert">{actionFailed}</p>{/if}
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
      {:else if !lock?.held_by}
        {m.editor_lock_lost_expired({}, options)}
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
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={() => (taking = true)}>{m.editor_lock_edit_here({}, options)}</button>
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
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={() => (taking = true)}>{m.editor_lock_take_over({}, options)}</button>
      {:else}
        {m.editor_lock_nobody({}, options)}
        <button class="btn-link" type="button" onclick={() => void (onreload ? onreload() : onchanged())}>{m.editor_lock_reload({}, options)}</button>
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
      <a href={sitePath(entry.singleton ? '/admin/site' : `/admin/c/${collection}`)}>{entry.singleton ? m.editor_site_settings({}, options) : capitalise(collection)}</a><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={saving} class:is-offline={saveFailed}>
        {#if saving}{m.editor_save_saving({}, options)}{:else if saveFailed}{m.editor_save_not_saved({}, options)}{:else if sourceUnsaved}{m.editor_save_unsaved_changes({}, options)}{:else}{m.editor_save_saved({}, options)}{/if}
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
                disabled={locked || actionBusy}
                onclick={() => (statusMenu = !statusMenu)}
              ><span class="dot" aria-hidden="true"></span> {hidden ? m.editor_status_hidden({}, options) : m.editor_status_live({}, options)} ▾</button>
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
            <span class="badge badge-danger">Changed in the repository since you opened it</span>
          {/if}
          <button
            class="hold-toggle"
            type="button"
            aria-pressed={held}
            disabled={locked || lost || actionBusy || (!dirty && !held)}
            title={dirty || held ? undefined : m.editor_hold_unavailable({}, options)}
            onclick={toggleHold}
          ><span class="dot" aria-hidden="true"></span> {m.editor_hold({}, options)}</button>
          {#if missing.length}
            <button class="problems" type="button" onclick={goToFirst}>
              {m.editor_problem_count({ count: missing.length }, options)}
            </button>
          {/if}
        </div>
      </div>
      <div class="actions">
        {#if many}
          {#if entry.locales.length < 5}
            <div class="seg" role="group" aria-label={m.editor_language({}, options)}>
              {#each entry.locales as of (of)}
                <button type="button" class:is-off={off(of)} aria-pressed={locale === of} onclick={() => leaving(() => (locale = of))}>
                  {of.toUpperCase()}{#if off(of)}<span class="visually-hidden"> — {m.editor_language_off_a11y({}, options)}</span>{:else if untranslated(of)}<span class="visually-hidden"> — {m.editor_language_untranslated_a11y({}, options)}</span><span class="mark is-empty" aria-hidden="true"></span>{:else if entry.stale.includes(of)}<span class="visually-hidden"> — {m.editor_language_stale_a11y({ source: language(entry.sourceLocale) }, options)}</span><span class="mark" aria-hidden="true"></span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <label class="visually-hidden" for="entry-locale">{m.editor_language({}, options)}</label>
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
          {#if mode === 'form'}
            <button class="btn btn-sbs" type="button" aria-pressed={side} onclick={() => leaving(() => (side = !side))}>{m.editor_side_by_side({}, options)}</button>
          {/if}
        {/if}
        {#if !entry.singleton}
          <div class="seg editor-modes" role="group" aria-label={m.editor_view({}, options)}>
            {#each MODES as item (item)}
              <button
                type="button"
                aria-pressed={mode === item}
                disabled={entry.drift.length > 0 || (item !== 'form' && !canvasSupported)}
                title={item !== 'form' && !canvasSupported
                  ? m.editor_canvas_unavailable({}, options)
                  : undefined}
                onclick={() => setMode(item)}
              >{modeLabel(item)}</button>
            {/each}
          </div>
        {/if}
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
              class="btn btn-ghost"
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreMenu}
              aria-label={m.editor_more_actions({}, options)}
              disabled={locked || actionBusy}
              onclick={() => (moreMenu = !moreMenu)}
            >⋯</button>
            {#if moreMenu}
              <div class="menu" role="menu" aria-label={m.editor_more_actions({}, options)}>
                <button type="button" role="menuitem" onclick={openRename}>{m.editor_rename({}, options)}</button>
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
      <p class="subline">
        Somebody changed this in the repository after you opened it. Open Unpublished changes to
        resolve it field by field, or to discard yours and take what is there now.
      </p>
    {/if}
    {#if held}
      <p class="subline">{m.editor_hold_active({}, options)}</p>
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
          <label class="visually-hidden" for="entry-address">{m.editor_address_label({ language: formatLanguageName(locale, uiLocale) }, options)}</label>
          <input class="input" id="entry-address" type="text" bind:value={typed} placeholder={slug} />
          <button class="btn btn-sm" type="button" disabled={busy} onclick={saveAddress}>{m.editor_address_save({}, options)}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => (editing = false)}>{m.editor_address_cancel({}, options)}</button>
          {#if addressFailed}<span class="mode is-bad">{addressFailed}</span>{/if}
        {:else}
          <span class="url">{url}</span>
          {#if !address}<span class="mode">{m.editor_address_file_name({}, options)}</span>{/if}
          <button class="btn-link" type="button" disabled={locked} onclick={editAddress}>{m.editor_address_edit({}, options)}</button>
        {/if}
      </p>
    {/if}
    <!-- A global has no SEO or versions of its own: no tabs rather than three dead ones. -->
    <!-- Links, not a tablist: each is an address the back button lands on; keep the roles off. -->
    {#if !entry.singleton}
      <nav class="tabs" aria-label={m.editor_sections({}, options)}>
        <a href={sitePath(`/admin/c/${collection}/${slug}`)} aria-current={section === '' ? 'page' : undefined}>{m.editor_section_content({}, options)}</a>
        {#if seoField}<a href={sitePath(`/admin/c/${collection}/${slug}/seo`)} aria-current={section === 'seo' ? 'page' : undefined}>{m.editor_section_seo({}, options)}</a>{/if}
        <a href={sitePath(`/admin/c/${collection}/${slug}/history`)} aria-current={section === 'history' ? 'page' : undefined}>{m.editor_section_history({}, options)}</a>
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
      onrestore={entrySession.historicalRestore}
      onrestored={async (date, outcome) => {
        if (outcome === 'restored') onrestored?.(date);
        // The old session is already closed, so this authoritative replacement bypasses its
        // navigation guard and lands on Content before the parent re-reads every locale.
        navigateAfterAuthoritativeChange(`/admin/c/${collection}/${slug}`);
        await (onreload ? onreload() : onchanged());
      }}
    />
  {:else}
  <!-- Stands where the form would be: every field belongs to a structure not yet agreed on. -->
  <div
    class="entry-body"
    class:has-pane={!entry.drift.length && (mode === 'split' || (mode === 'form' && !alone && shown !== undefined))}
    class:has-outline={!entry.drift.length && mode === 'form' && !alone && shown === undefined && fields.length > 5}
    class:is-canvas={mode === 'canvas'}
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
      {#if mode === 'split'}
        <div class="canvas-mobile-tabs seg" role="group" aria-label={m.editor_split_pane({}, options)}>
          <button type="button" aria-pressed={mobilePane === 'form'} onclick={() => (mobilePane = 'form')}>{m.editor_split_form({}, options)}</button>
          <button type="button" aria-pressed={mobilePane === 'page'} onclick={() => (mobilePane = 'page')}>{m.editor_split_page({}, options)}</button>
        </div>
      {/if}
      <!-- Not drawn when a translation is on its own. -->
      {#if mode !== 'canvas' && !alone}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          class="form"
          class:is-mobile-hidden={mode === 'split' && mobilePane === 'page'}
          onsubmit={(e) => e.preventDefault()}
          onfocusout={canvasCompleted}
        >
          <fieldset disabled={locked || entrySession.localeMutationBlocked(entry.sourceLocale)}>
            <Fields {fields} blocks={entry.blocks} {problems} {mediaBase} locale={entry.sourceLocale} {uiLocale} session={entrySession} inheritedSeo={inherited(entry.sourceLocale, data)} {site} servedAt={localeUrl(entry.sourceLocale)} bind:root={entrySession.snapshots[entry.sourceLocale]!} structureLocked={entrySession.structureMutationBlocked()} textOnly={entrySession.sourceTextOnly(entry.sourceLocale)} />
          </fieldset>
        </form>
      {/if}
      <!-- Split replaces a comparison pane rather than adding a third column. -->
      {#if mode !== 'canvas' && !(mode === 'split' && !alone) && shown === undefined}
        {#if fields.length > 5}
          <nav class="editor-outline" aria-label={m.editor_outline({}, options)}>
            <p>{m.editor_outline({}, options)}</p>
            {#each fields as field (field.path.join('.'))}
              <button type="button" onclick={() => focusField(field.path)}>{field.label || field.path.at(-1)}</button>
            {/each}
          </nav>
        {/if}
      {:else if mode !== 'canvas' && !(mode === 'split' && !alone) && shown && untranslated(shown)}
        <!-- An empty form here would autosave a file nobody asked for. -->
        <section
          class="pane is-locale"
          class:is-mobile-hidden={mode === 'split' && mobilePane === 'page'}
          aria-labelledby="pane-{shown}"
          onfocusout={canvasCompleted}
        >
          <div class="pane-head"><h2 id="pane-{shown}">{language(shown)}</h2></div>
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
                {#if !entry.singleton}
                  <p>
                    {m.editor_or({}, options)} <button class="btn-link" type="button" disabled={actionBusy || locked} onclick={() => offer(shown, false)}>{m.editor_do_not_offer({ language: language(shown) }, options)}</button> {m.editor_no_file_written({}, options)}
                  </p>
                {/if}
              </div>
            {/if}
            {#if actionFailed}
              <div class="notice notice-danger" role="alert">{actionFailed}</div>
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
            class="canvas-form-surface"
            class:is-mobile-hidden={mode === 'split' && mobilePane === 'page'}
            onfocusout={canvasCompleted}
          >
            <Translation
              {collection}
              {slug}
              locale={shown}
              session={entrySession}
              {fields}
              blocks={entry.blocks}
              bind:data={entrySession.snapshots[shown]!}
              problems={entrySession.positionalProblems(shown, uiLocale)}
              inheritedSeo={inherited(shown, entrySession.snapshot(shown))}
              source={entry.sourceLocale}
              {locked}
              stale={entry.stale.includes(shown)}
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
              onclose={side ? () => leaving(() => (side = false)) : undefined}
              onturnoff={entry.singleton ? undefined : () => { rememberActionTrigger(); actionFailed = ''; offing = shown; }}
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
          blocks={entry.blocks}
          problems={locale === entry.sourceLocale ? problems : entrySession.positionalProblems(locale, uiLocale)}
          onreviewproblems={reviewCanvasProblems}
          {mediaBase}
          {site}
          servedAt={localeUrl(locale)}
          {locked}
          onform={() => setMode('form')}
          onnavigateentry={navigateCanvasEntry}
          mobileHidden={mode === 'split' && mobilePane === 'form'}
        />
      {/if}
    {/if}
  </div>
  {/if}
  <!-- Publishes whole or not at all: picking languages is what the drawer is for. -->
  {#if confirming}
    <Modal
      labelledby="publish-h"
      returnTo={mode === 'canvas' ? canvasPublishButton : publishButton}
      dismissible={!sending}
      bind:panel={publishPanel}
      onclose={closePublish}
    >
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
          <button class="btn" type="button" disabled={sending} onclick={closePublish}>Cancel</button>
          <button
            class="btn btn-primary"
            type="button"
            disabled={sending || errors.length > 0 || entrySession.persistedActionPending()}
            onclick={publishEntry}
          >
            {#if sending}Publishing…
            {:else if errors.length}Fix {plural(errors.length, 'errors')} to publish
            {:else if warnings.length}Publish anyway ({plural(warnings.length, 'warnings')})
            {:else}Publish this entry{/if}
          </button>
        </div>
    </Modal>
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
          {#if actionFailed}<div class="notice notice-danger" role="alert">{actionFailed}</div>{/if}
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
    <Modal labelledby="take-h" returnTo={takeTrigger} dismissible={!busy} onclose={cancelTake}>
        <h2 id="take-h">{holderName
          ? m.editor_lock_take_question({ holder: holderName }, options)
          : m.editor_lock_take_question_anonymous({}, options)}</h2>
        <p>{holderName
          ? m.editor_lock_take_shared({ holder: holderName }, options)
          : m.editor_lock_take_shared_anonymous({}, options)}</p>
        <p>{m.editor_lock_take_refusal({}, options)}</p>
        {#if lockFailed}<p class="notice notice-danger" role="alert">{feedbackText(lockFailed)} {feedbackDetail(lockFailed)}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={busy} onclick={cancelTake}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="button" disabled={busy} onclick={takeOver}>{m.editor_lock_take_over({}, options)}</button>
        </div>
    </Modal>
  {/if}
</main>
