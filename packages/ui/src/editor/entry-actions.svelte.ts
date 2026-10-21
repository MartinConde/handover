import { entryName } from '@handover/core';
import type { Target } from '../content/Offsite.svelte';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { retainedFailure, type UiMessage } from '../errors.js';
import { navigate } from '../navigate';
import { request as fetch, postJson, uncertainResponse } from '../request.js';
import type { createEntryLock } from './entry-lock.svelte';
import type { EditorEntry } from './entry-payload';
import type { EntrySession } from './entry-session.svelte';
import { classifyDraftSaveRefusal } from './save';

type Data = Record<string, unknown>;

export function createEntryActions({
  collection,
  slug,
  queueTail,
  entry,
  session,
  lock,
  present,
  hidden: initiallyHidden,
  held: initiallyHeld,
  reload,
  onchanged,
  oncommitted,
  onsourcechanged,
}: {
  collection: string;
  slug: string;
  queueTail: string;
  entry: () => EditorEntry;
  session: EntrySession;
  lock: ReturnType<typeof createEntryLock>;
  present: () => string[];
  hidden: boolean;
  held: boolean;
  reload: () => void | Promise<void>;
  onchanged: () => void | Promise<void>;
  oncommitted: () => void | Promise<void>;
  onsourcechanged: (locale: string) => void;
}) {
  let busy = $state(false);
  let held = $state(initiallyHeld);
  let hidden = $state(initiallyHidden);
  let hiding = $state(false);
  let statusFailed = $state<UiMessage>();
  // A rename navigates to the new name and a delete to the list, so neither refreshes this screen.
  let renaming = $state(false);
  let deleting = $state(false);
  let actionTrigger = $state<HTMLElement>();
  let newName = $state('');
  let actionFailed = $state<UiMessage>();
  let holdFailed = $state<UiMessage>();
  const willBe = $derived(entryName(newName, []));
  let discarding = $state(false);
  let discardBusy = $state(false);
  let changingSource = $state(false);
  let sendingSource = $state(false);
  let sourceFailure = $state<UiMessage>();
  let sourceFiles = $state<Record<string, Data>>({});
  let offing = $state<string>();
  const flush = () => session.flush();

  // Both change which files the entry has, so the screen is read again rather than patched.
  async function ask(url: string, body: unknown) {
    if (!(await flush())) return false;
    busy = true;
    const res = await postJson(url, body);
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
    if (typeof body.commit_sha === 'string' && body.commit_sha) await oncommitted();
  }

  // Through `act`: a refused turn-off answers with a sentence the screen shows.
  async function offer(of: string, on: boolean, redirect?: Target) {
    const res = await act(`/admin/api/entries/${collection}/${slug}/locales`, {
      locales: on
        ? entry().locales.filter((l) => l === of || entry().offered.includes(l))
        : entry().offered.filter((l) => l !== of),
      ...(redirect ? { redirect } : {}),
    });
    if (res) {
      await announceCommit(res);
      onchanged();
    }
    return res !== undefined;
  }

  async function setStatus(next: boolean, redirect?: Target) {
    busy = true;
    statusFailed = undefined;
    // Everything on screen goes into the rows first: this write rewrites the same files.
    if (!(await flush())) {
      busy = false;
      return;
    }
    const res = await postJson(`/admin/api/status/${collection}`, {
      entries: [slug],
      hidden: next,
      redirect,
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

  function openRename() {
    rememberActionTrigger();
    newName = slug;
    actionFailed = undefined;
    renaming = true;
  }

  function rememberActionTrigger() {
    const here = document.activeElement as HTMLElement | null;
    const anchor = here?.closest('.pop-anchor');
    actionTrigger =
      anchor?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ??
      anchor?.querySelector('button') ??
      here ??
      undefined;
  }

  function startHiding() {
    rememberActionTrigger();
    hiding = true;
  }

  function startDeleting() {
    rememberActionTrigger();
    actionFailed = undefined;
    deleting = true;
  }

  function startDiscarding() {
    rememberActionTrigger();
    actionFailed = undefined;
    discarding = true;
  }

  function startOffing(of: string) {
    rememberActionTrigger();
    actionFailed = undefined;
    offing = of;
  }

  // Authoritative like a restore: the draft rows are gone, so the form must be read again.
  async function discardDraft() {
    discardBusy = true;
    actionFailed = undefined;
    const outcome = await session.authoritativeChange(async () => {
      const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, { method: 'DELETE' });
      if (uncertainResponse(res)) throw new TypeError('The discard response was not confirmed.');
      if (!res.ok) actionFailed = await retainedFailure(res, 'PENDING_DISCARD_FAILED');
      return res.ok;
    }, reload);
    discardBusy = false;
    if (outcome.ok) return;
    if (outcome.reason === 'save') actionFailed = { code: 'PENDING_DISCARD_SAVE_FAILED' };
    else if (outcome.reason === 'refused') actionFailed ??= { code: 'PENDING_DISCARD_FAILED' };
    else actionFailed = { code: 'PENDING_DISCARD_UNCONFIRMED' };
  }

  function openSourceChange() {
    rememberActionTrigger();
    sourceFailure = undefined;
    sourceFiles = Object.fromEntries(
      present().map((of) => [of, $state.snapshot(session.snapshot(of))]),
    );
    changingSource = true;
  }

  async function changeSourceTo(to: string) {
    sendingSource = true;
    sourceFailure = undefined;
    let res: Response | undefined;
    const outcome = await session.authoritativeChange(
      async () => {
        // Read after the drain, which is what moves each language's revision on.
        const revisions = Object.fromEntries(
          entry().locales.flatMap((of) => {
            const revision = session.revision(of);
            return revision ? [[of, revision]] : [];
          }),
        );
        res = await postJson(`/admin/api/entries/${collection}/${slug}/source`, {
          locale: to,
          tab: lock.tab,
          revisions,
        });
        if (uncertainResponse(res))
          throw new TypeError('The source change response was not confirmed.');
        return res.ok;
      },
      async (outcome) => {
        // Unconfirmed: this session stays closed and only the dialog's Reload goes on from here.
        if (outcome === 'uncertain') return;
        onsourcechanged(to);
        await reload();
      },
    );
    sendingSource = false;
    if (outcome.ok) return;
    if (outcome.reason === 'save') sourceFailure = { code: 'SOURCE_CHANGE_SAVE_FAILED' };
    else if (outcome.reason === 'uncertain')
      sourceFailure = { code: 'SOURCE_CHANGE_RESPONSE_LOST' };
    else if (outcome.reason === 'reload') sourceFailure = { code: 'SOURCE_CHANGE_RELOAD_FAILED' };
    else if (res && !res.ok) {
      const refusal = await classifyDraftSaveRefusal(res.clone());
      if (refusal.kind === 'lock') {
        changingSource = false;
        lock.lose(refusal.lock);
      } else sourceFailure = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
    } else sourceFailure = { code: 'ENTRY_ACTION_FAILED' };
  }

  // A 409 body is the server's own sentence, which reads better than a generic one.
  async function act(url: string, body: unknown, method = 'POST') {
    if (!(await flush())) return undefined;
    busy = true;
    actionFailed = undefined;
    const res = await postJson(url, body, method);
    busy = false;
    if (res.ok) return res;
    actionFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
    return undefined;
  }

  async function rename(event: Event) {
    event.preventDefault();
    const res = await act(`/admin/api/entries/${collection}/${slug}/rename`, { to: newName });
    if (!res) return;
    await announceCommit(res);
    const { slug: to } = (await res.json()) as { slug: string };
    invalidateEntryDirectory();
    navigate(`/admin/c/${collection}/${to}${queueTail}`);
  }

  async function remove(redirect: Target) {
    const res = await act(`/admin/api/entries/${collection}/${slug}`, { redirect }, 'DELETE');
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
    const res = await postJson(`/admin/api/hold/${collection}/${slug}`, { hold: next });
    busy = false;
    if (res.ok) held = ((await res.json()) as { held: unknown }).held === true;
    else holdFailed = await retainedFailure(res, 'EDITOR_HOLD_FAILED');
  }

  // Deletes the file, so it asks where that language's readers go; a refusal stays in the dialog.
  async function turnOff(of: string, target: Target) {
    if (!(await flush())) return;
    if (await offer(of, false, target)) offing = undefined;
  }

  return {
    get busy() {
      return busy;
    },
    set busy(value: boolean) {
      busy = value;
    },
    get held() {
      return held;
    },
    get hidden() {
      return hidden;
    },
    get hiding() {
      return hiding;
    },
    set hiding(value: boolean) {
      hiding = value;
    },
    get statusFailed() {
      return statusFailed;
    },
    get renaming() {
      return renaming;
    },
    set renaming(value: boolean) {
      renaming = value;
    },
    get deleting() {
      return deleting;
    },
    set deleting(value: boolean) {
      deleting = value;
    },
    get actionTrigger() {
      return actionTrigger;
    },
    get newName() {
      return newName;
    },
    set newName(value: string) {
      newName = value;
    },
    get willBe() {
      return willBe;
    },
    get actionFailed() {
      return actionFailed;
    },
    get holdFailed() {
      return holdFailed;
    },
    get discarding() {
      return discarding;
    },
    set discarding(value: boolean) {
      discarding = value;
    },
    get discardBusy() {
      return discardBusy;
    },
    get changingSource() {
      return changingSource;
    },
    set changingSource(value: boolean) {
      changingSource = value;
    },
    get sendingSource() {
      return sendingSource;
    },
    get sourceFailure() {
      return sourceFailure;
    },
    get sourceFiles() {
      return sourceFiles;
    },
    get offing() {
      return offing;
    },
    set offing(value: string | undefined) {
      offing = value;
    },
    announceCommit,
    ask,
    offer,
    setStatus,
    openRename,
    startHiding,
    startDeleting,
    startDiscarding,
    startOffing,
    discardDraft,
    openSourceChange,
    changeSourceTo,
    rename,
    remove,
    toggleHold,
    turnOff,
  };
}
