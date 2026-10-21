import { invalidateEntryDirectory } from '../entry-directory.js';
import { retainedFailure, type UiMessage } from '../errors.js';
import { postJson } from '../request.js';
import type { createEntryLock } from './entry-lock.svelte';
import type { EditorEntry } from './entry-payload';
import type { createEntryPublish } from './entry-publish.svelte';
import type { EntryProblem, EntrySession, StructuralSaveEnvelope } from './entry-session.svelte';
import { classifyDraftSaveRefusal } from './save';

// What an autosave posts for each file and how the answer updates the editor.
export function createEntrySaves({
  collection,
  slug,
  entry,
  session,
  lock,
  publish,
  onpending,
}: {
  collection: string;
  slug: string;
  entry: () => EditorEntry;
  session: EntrySession;
  lock: () => ReturnType<typeof createEntryLock>;
  publish: () => ReturnType<typeof createEntryPublish>;
  onpending: () => void;
}) {
  // The loaded entry seeds each file's live draft state.
  const pendingByLocale = $state<Record<string, boolean>>(
    Object.fromEntries(entry().locales.map((of) => [of, entry().pending.includes(of)])),
  );
  let saveError = $state<UiMessage>();

  const hasPending = () => Object.values(pendingByLocale).some(Boolean);
  // The shell counts pending entries, while this editor owns the live state of every loaded file.
  function setPending(of: string, pending: boolean) {
    if (pendingByLocale[of] === pending) return;
    const hadPending = hasPending();
    pendingByLocale[of] = pending;
    if (hadPending !== hasPending()) onpending();
  }

  async function writeSourceSave(
    sent: string,
    revision: string | undefined,
    contentVersion: number,
    structure?: StructuralSaveEnvelope,
  ): Promise<boolean> {
    saveError = undefined;
    try {
      const res = await postJson(
        `/admin/api/drafts/${collection}/${slug}`,
        {
          data: JSON.parse(sent),
          tab: lock().tab,
          revision,
          ...(structure ? { structure } : {}),
        },
        'PUT',
      );
      if (!res.ok) {
        saveError = await retainedFailure(res, 'EDITOR_SAVE_REFUSED');
        const refusal = await classifyDraftSaveRefusal(res.clone());
        if (refusal.kind === 'lock') lock().lose(refusal.lock);
        else if (refusal.kind === 'revision') {
          session.freezeHistory();
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
      session.mergeRevisions(body.revisions);
      lock().renew();
      setPending(entry().sourceLocale, body.pending);
      invalidateEntryDirectory();
      session.acceptProblems(entry().sourceLocale, body.problems, sent, contentVersion);
      // The checks read the draft rows, so a save that left nothing pending has nothing to lint.
      if (body.pending) void publish().lint();
      else publish().clear();
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
      const res = await postJson(
        `/admin/api/drafts/${collection}/${slug}/${of}`,
        { data: JSON.parse(sent), tab: lock().tab, revision },
        'PUT',
      );
      if (!res.ok) {
        const refusal = await classifyDraftSaveRefusal(res);
        if (refusal.kind === 'lock') lock().lose(refusal.lock);
        else if (refusal.kind === 'revision') session.freezeHistory();
        return false;
      }
      const body = (await res.json()) as {
        pending: boolean;
        problems: EntryProblem[];
        revision?: string;
      };
      if (body.revision) session.setRevision(of, body.revision);
      session.acceptProblems(of, body.problems, sent, contentVersion);
      lock().renew();
      setPending(of, body.pending);
      invalidateEntryDirectory();
      // A new revision makes an open dialog's readiness stale.
      if (publish().confirming) void publish().lint();
      return true;
    } catch {
      return false;
    }
  }

  return {
    pendingByLocale,
    get saveError() {
      return saveError;
    },
    hasPending,
    setPending,
    write(
      of: string,
      snapshot: string,
      revision: string | undefined,
      contentVersion: number,
      structure?: StructuralSaveEnvelope,
    ) {
      return of === entry().sourceLocale
        ? writeSourceSave(snapshot, revision, contentVersion, structure)
        : writeTranslationSave(of, snapshot, revision, contentVersion);
    },
  };
}
