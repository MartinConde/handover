import { retainedFailure, type UiMessage } from '../errors.js';
import { request as fetch, postJson, uncertainResponse } from '../request.js';
import type { CreatedAll } from './Editor.svelte';
import type { createEntryActions } from './entry-actions.svelte';
import type { EditorEntry } from './entry-payload';
import type { EntrySession } from './entry-session.svelte';

const CREATE_FAILED = {
  create: 'TRANSLATION_CREATE_FAILED',
  fill: 'TRANSLATION_CREATED_FILL_FAILED',
};
const CREATE_UNCONFIRMED = {
  create: 'TRANSLATION_CREATE_UNCONFIRMED',
  fill: 'TRANSLATION_CREATED_FILL_UNCONFIRMED',
};

export function createEntryCreate({
  collection,
  slug,
  entry,
  session,
  actions,
  untranslated,
  reload,
  onchanged,
  oncreatedall,
}: {
  collection: string;
  slug: string;
  entry: () => EditorEntry;
  session: EntrySession;
  actions: ReturnType<typeof createEntryActions>;
  untranslated: (of: string) => boolean;
  reload: () => void | Promise<void>;
  onchanged: () => void | Promise<void>;
  oncreatedall: (report: CreatedAll) => void;
}) {
  let localeFailure = $state<{ locale: string; message: UiMessage }>();
  // Offered languages with no file, in configured order; the source always has one.
  const missingTargets = $derived(
    entry().locales.filter((of) => untranslated(of) && entry().offered.includes(of)),
  );
  let creatingAll = $state<string>();
  let createAllFailure = $state<UiMessage>();
  // A report this mount did not make comes from before the reload, so the files now answer it.
  let reportedHere = $state(false);

  // The file has to exist before a machine's draft can be written into it.
  async function createLanguage(of: string, fill: boolean) {
    const made = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
    if (!made.ok || !fill)
      return { made, refused: made.ok ? undefined : made, step: 'create' as const };
    const filled = await postJson(`/admin/api/translate/${collection}/${slug}/${of}`, {});
    return { made, refused: filled.ok ? undefined : filled, step: 'fill' as const };
  }

  async function createInPane(of: string, fill: boolean) {
    if (!(await session.flush())) return;
    actions.busy = true;
    localeFailure = undefined;
    const { made, refused, step } = await createLanguage(of, fill);
    actions.busy = false;
    if (refused) {
      localeFailure = {
        locale: of,
        message: uncertainResponse(refused)
          ? { code: CREATE_UNCONFIRMED[step], status: refused.status }
          : await retainedFailure(refused, CREATE_FAILED[step]),
      };
      return;
    }
    if (!fill) await actions.announceCommit(made);
    onchanged();
  }

  async function createAll(fill: boolean) {
    const targets = [...missingTargets];
    const report: CreatedAll = { targets, done: {} };
    createAllFailure = undefined;
    const outcome = await session.authoritativeChange(async () => {
      for (const of of targets) {
        creatingAll = of;
        const { made, refused, step } = await createLanguage(of, fill);
        // A file made and then left unfilled still counts: the reload has to show it.
        if (made.ok) report.done[of] = fill && !refused ? 'filled' : 'created';
        if (refused) {
          const unconfirmed = uncertainResponse(refused);
          report.failed = {
            locale: of,
            step,
            unconfirmed,
            message: await retainedFailure(refused, CREATE_FAILED[step]),
          };
          break;
        }
      }
      creatingAll = undefined;
      reportedHere = true;
      oncreatedall(report);
      // Not replayed: the reload is what says whether an unanswered request landed.
      if (report.failed?.unconfirmed) throw new TypeError('A language was not confirmed.');
      return Object.keys(report.done).length > 0;
    }, reload);
    creatingAll = undefined;
    if (outcome.ok || outcome.reason === 'refused') return;
    if (outcome.reason === 'save') createAllFailure = { code: 'CREATE_ALL_SAVE_FAILED' };
    else if (outcome.reason === 'reload' || outcome.reason === 'uncertain')
      createAllFailure = { code: 'CREATE_ALL_RELOAD_FAILED' };
    else createAllFailure = { code: 'ENTRY_ACTION_FAILED' };
  }

  return {
    get localeFailure() {
      return localeFailure;
    },
    get missingTargets() {
      return missingTargets;
    },
    get creatingAll() {
      return creatingAll;
    },
    get createAllFailure() {
      return createAllFailure;
    },
    get reportedHere() {
      return reportedHere;
    },
    createInPane,
    createAll,
  };
}
