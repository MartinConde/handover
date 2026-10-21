import type { ShellMessage } from './App.svelte';
import type { EditorEntry } from './editor/entry-payload';
import type { SourceProblem } from './editor/SourceRecovery.svelte';
import { request as fetch } from './request.js';

// Loads the open entry; getters because the route and the reload counter live in App.
export function createEntryLoad(input: {
  editing: () => { collection: string; slug: string } | undefined;
  editingAt: () => string;
  reload: () => number;
  bumpReload: () => void;
  loadPending: () => Promise<unknown>;
  invalidateEntryDirectory: () => void;
}) {
  // An authoritative action reads the replacement before retiring the editor that can retry it.
  let preparedEntry:
    | {
        entry: string;
        reload: number;
        outcome:
          | { value: Awaited<ReturnType<typeof loadEntry>>; error?: never }
          | { value?: never; error: { source: SourceProblem } };
      }
    | undefined;
  const openEntry = $derived.by(() => {
    // Read on purpose: a reload means the entry's files moved under it.
    const at = input.reload();
    const editingAt = input.editingAt();
    if (!editingAt) return undefined;
    if (preparedEntry?.entry === editingAt && preparedEntry.reload === at) {
      const outcome = preparedEntry.outcome;
      return outcome.error ? Promise.reject(outcome.error) : Promise.resolve(outcome.value);
    }
    const [collection = '', slug = ''] = editingAt.split('/');
    return loadEntry(collection, slug);
  });

  async function loadEntry(collection: string, slug: string): Promise<EditorEntry> {
    const res = await fetch(`/admin/api/entries/${collection}/${slug}`);
    if (res.ok) return (await res.json()) as EditorEntry;
    // Not a failure to load: the entry is there and needs somebody to say what it is written in.
    if (res.status === 409 && res.headers.get('x-handover-error-code')?.startsWith('ENTRY_SOURCE_'))
      throw { source: (await res.json()) as SourceProblem };
    // A 503 is about the repository, not about this entry, so it is the server's own sentence.
    if (res.status === 503)
      throw {
        code: 'ENTRY_LOAD_FAILED',
        status: res.status,
        detail: await res.text(),
      } satisfies ShellMessage;
    throw {
      code:
        res.headers.get('x-handover-error-code') === 'ENTRY_NOT_FOUND'
          ? 'ENTRY_NOT_FOUND'
          : 'ENTRY_LOAD_FAILED',
      status: res.status,
    } satisfies ShellMessage;
  }

  // Read first: on failure the closed editor remains mounted and can offer a safe retry.
  async function reloadEntry() {
    const editing = input.editing();
    const at = input.editingAt();
    if (!editing || !at) return;
    const collection = editing.collection;
    const slug = editing.slug;
    input.invalidateEntryDirectory();
    await input.loadPending();
    let outcome: NonNullable<typeof preparedEntry>['outcome'];
    try {
      outcome = { value: await loadEntry(collection, slug) };
    } catch (error) {
      if (!error || typeof error !== 'object' || !('source' in error)) throw error;
      outcome = { error: error as { source: SourceProblem } };
    }
    if (input.editingAt() !== at) return;
    preparedEntry = { entry: at, reload: input.reload() + 1, outcome };
    input.bumpReload();
  }

  const entryFailure = (error: unknown): ShellMessage =>
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENTRY_NOT_FOUND' || error.code === 'ENTRY_LOAD_FAILED')
      ? (error as ShellMessage)
      : {
          code: 'ENTRY_LOAD_FAILED',
          status: 0,
          ...(error instanceof Error ? { detail: error.message } : {}),
        };

  return {
    get openEntry() {
      return openEntry;
    },
    reloadEntry,
    entryFailure,
    // Reload only ever counts up, so leaving the entry is the one way back to a prepared pair.
    forgetPrepared() {
      preparedEntry = undefined;
    },
  };
}
