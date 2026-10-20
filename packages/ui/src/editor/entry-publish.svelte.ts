import { retainedFailure, type UiMessage } from '../errors.js';
import { type CheckItem, merged } from '../publishing/CheckLines.svelte';
import { postJson, uncertainResponse } from '../request.js';
import type { EntrySession } from './entry-session.svelte';
import { createPublishChoice, type Readiness } from './publish-choice.svelte';

const selection = (key: string, without: string[]) =>
  without.length
    ? { entries: [key], without: without.map((of) => `${key}:${of}`) }
    : { entries: [key] };

// This entry and nothing else, less any new language left for later; it commits, so it confirms first.
export function createEntryPublish({
  key,
  session,
  pending,
  many,
  reload,
  onpublished,
  onconflict,
  focusPanel,
}: {
  key: string;
  session: EntrySession;
  pending: () => string[];
  many: () => boolean;
  reload: () => void | Promise<void>;
  onpublished: () => void | Promise<void>;
  onconflict: () => void;
  focusPanel: () => void;
}) {
  // What the pre-publish checks found over this entry: read when it opens and after every save.
  let checks = $state<CheckItem[]>([]);
  let confirming = $state(false);
  let sending = $state(false);
  let failed = $state<UiMessage>();
  // The pass could not be run at all, which holds nothing back: it is a lint, not a gate.
  let checksFailed = $state(false);
  // Detection only; resolving it is the drawer's job.
  let conflicted = $state(false);
  let pass = 0;
  const choice = createPublishChoice(pending, many);
  const lines = $derived(merged(checks));
  const errors = $derived(lines.filter((c) => c.severity === 'error'));

  // The drawer's lint over this one entry; an answer that never comes holds nothing back.
  async function lint() {
    const mine = ++pass;
    const sent = choice.leftOut;
    const res = await postJson('/admin/api/publish/checks', selection(key, sent)).catch(
      () => undefined,
    );
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
    choice.receive(body?.readiness?.[key], checksFailed);
    // The answer changed what can wait, so these checks were over another set of files.
    if (confirming && sent.join() !== choice.leftOut.join()) void lint();
  }

  function close() {
    if (sending) return;
    confirming = false;
  }

  async function send() {
    if (session.persistedActionPending()) return;
    sending = true;
    failed = undefined;
    let res: Response | undefined;
    let checksBlocked = false;
    const outcome = await session.finalPublish(async () => {
      // Again after reserving the session: the dialog may have been open while more was typed.
      const chosen = choice.leftOut;
      await lint();
      if (errors.length || choice.unready.length || chosen.join() !== choice.leftOut.join()) {
        checksBlocked = true;
        return false;
      }
      res = await postJson('/admin/api/publish', selection(key, choice.leftOut));
      if (uncertainResponse(res)) throw new TypeError('The publish response was not confirmed.');
      if (res.ok) await onpublished();
      return res.ok;
    }, reload);
    sending = false;
    if (outcome.ok) {
      confirming = false;
      return;
    }
    if (outcome.reason === 'save') {
      failed = { code: 'PUBLISH_SAVE_FAILED' };
      focusPanel();
      return;
    }
    if (checksBlocked) {
      // A disabled button drops the focus that pressed it.
      failed = { code: 'PUBLISH_CHECKS_BLOCKED' };
      focusPanel();
      return;
    }
    if (outcome.reason === 'uncertain') {
      failed = { code: 'PUBLISH_ENTRY_RESPONSE_LOST' };
      return;
    }
    if (outcome.reason === 'reload') {
      failed = { code: 'PUBLISH_ENTRY_RELOAD_FAILED' };
      return;
    }
    if (!res) {
      failed = { code: 'PUBLISH_FAILED' };
      return;
    }
    const code = res.headers.get('x-handover-error-code') ?? '';
    if (code === 'PUBLISH_SELECTION_INVALID' || code.startsWith('PUBLISH_EXCLUDE_')) {
      failed = await retainedFailure(res, 'PUBLISH_FAILED');
      return;
    }
    if (res.status === 422) {
      failed = { code: 'PUBLISH_ENTRY_INCOMPLETE' };
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
        failed = { code: 'PUBLISH_ENTRY_DRIFT' };
        return;
      }
      if (Array.isArray(parsed.paths) && parsed.paths.length) {
        close();
        conflicted = true;
        onconflict();
        return;
      }
      failed = await retainedFailure(res, 'PUBLISH_REF_MOVED');
      return;
    }
    failed = await retainedFailure(res, 'PUBLISH_FAILED');
  }

  return {
    choice,
    get checks() {
      return checks;
    },
    get lines() {
      return lines;
    },
    get confirming() {
      return confirming;
    },
    get sending() {
      return sending;
    },
    get failed() {
      return failed;
    },
    get checksFailed() {
      return checksFailed;
    },
    get conflicted() {
      return conflicted;
    },
    lint,
    close,
    send,
    clear() {
      checks = [];
    },
    async open() {
      if (!(await session.flush())) return;
      failed = undefined;
      choice.reset();
      confirming = true;
      void lint();
    },
    later(of: string) {
      choice.toggle(of);
      void lint();
    },
  };
}
