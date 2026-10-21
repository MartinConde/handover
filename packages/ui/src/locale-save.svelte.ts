import type { Session } from './App.svelte';
import { isUiLocale, type UiLocale } from './i18n.js';
import { request as fetch, postJson, uncertainResponse } from './request.js';

// Saves the account's interface language; getters because the session is replaced on sign-in.
export function createLocaleSaver(
  getSession: () => Session | null | undefined,
  getLocale: () => UiLocale,
  useLocale: (locale: UiLocale, remember: boolean) => void,
) {
  let busy = $state(false);
  let error = $state(false);

  async function save(next: UiLocale) {
    const session = getSession();
    if (!session || busy || next === getLocale()) return;
    const userId = session.user.id;
    const same = () => (getSession()?.user.id === userId ? getSession() : undefined);
    busy = true;
    error = false;
    try {
      const res = await postJson('/admin/api/auth/update-user', { uiLocale: next });
      const confirmed =
        res.ok &&
        ((await res.json().catch(() => null)) as { status?: unknown } | null)?.status === true;
      const confirmedFor = same();
      if (confirmed && confirmedFor) {
        confirmedFor.user.uiLocale = next;
        useLocale(next, true);
      } else if (uncertainResponse(res)) {
        const ping = await fetch('/admin/api/ping');
        const body = ping.ok ? await ping.json().catch(() => undefined) : undefined;
        const user =
          body &&
          typeof body === 'object' &&
          'user' in body &&
          body.user &&
          typeof body.user === 'object'
            ? body.user
            : undefined;
        const reconciledId = user && 'id' in user ? user.id : undefined;
        const reconciledLocale = user && 'uiLocale' in user ? user.uiLocale : undefined;
        const reconciledFor = same();
        if (
          reconciledFor &&
          reconciledId === userId &&
          (reconciledLocale === null || isUiLocale(reconciledLocale))
        ) {
          reconciledFor.user.uiLocale = reconciledLocale;
          if (isUiLocale(reconciledLocale)) useLocale(reconciledLocale, true);
          error = reconciledLocale !== next;
        } else if (same()) error = true;
      } else if (same()) error = true;
    } catch {
      if (same()) error = true;
    } finally {
      busy = false;
    }
  }

  return {
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    save,
  };
}
