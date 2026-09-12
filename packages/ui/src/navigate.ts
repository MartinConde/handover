import { sitePath } from './request.js';

let guard: (() => Promise<boolean>) | undefined;

export type EntryActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'busy' | 'closed' | 'drift' | 'refused' | 'reload' | 'save' | 'stale' | 'uncertain';
    };

type EntryActions = {
  key: string;
  publish: (request: () => Promise<boolean>) => Promise<EntryActionResult>;
  replace: (request: () => Promise<boolean>) => Promise<EntryActionResult>;
};

let entryActions: EntryActions | undefined;

/** The mounted editor retains ownership until all its files are safely stored. */
export function guardNavigation(flush: () => Promise<boolean>) {
  guard = flush;
  return () => {
    if (guard === flush) guard = undefined;
  };
}
export async function flushNavigation(): Promise<boolean> {
  return (await guard?.()) ?? true;
}

/** The shell borrows the mounted editor's save lane for actions outside the editor. */
export function guardEntryActions(actions: EntryActions) {
  entryActions = actions;
  return () => {
    if (entryActions === actions) entryActions = undefined;
  };
}

export async function coordinateEntryPublish(
  request: () => Promise<boolean>,
): Promise<EntryActionResult> {
  if (entryActions) return entryActions.publish(request);
  try {
    return (await request()) ? { ok: true } : { ok: false, reason: 'refused' };
  } catch {
    return { ok: false, reason: 'uncertain' };
  }
}

export async function coordinateEntryReplacement(
  key: string | undefined,
  request: () => Promise<boolean>,
): Promise<EntryActionResult> {
  if (entryActions && (key === undefined || key === entryActions.key))
    return entryActions.replace(request);
  try {
    return (await request()) ? { ok: true } : { ok: false, reason: 'refused' };
  } catch {
    return { ok: false, reason: 'uncertain' };
  }
}

/** Replace a screen after the server changed its files; the old editor has already been closed. */
export function navigateAfterAuthoritativeChange(to: string): void {
  history.pushState({}, '', sitePath(to));
  dispatchEvent(new Event('handover:navigate'));
}

/** Moves the shell only after the editor has drained its save queue. */
export async function navigate(to: string) {
  if (!(await flushNavigation())) return false;
  navigateAfterAuthoritativeChange(to);
  return true;
}
