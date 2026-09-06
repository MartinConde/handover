import { sitePath } from './request.js';

let guard: (() => Promise<boolean>) | undefined;

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

/** Moves the shell only after the editor has drained its save queue. */
export async function navigate(to: string) {
  if (!(await flushNavigation())) return false;
  history.pushState({}, '', sitePath(to));
  dispatchEvent(new Event('handover:navigate'));
  return true;
}
