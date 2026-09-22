import type { Role, UiLocale } from '@handover/core';

/**
 * What the admin hands a screen of your own at `/admin/x/<key>`. Nothing else is passed, and the
 * shell draws the `<main>` around it. See `admin.screens` in `cms.config.ts`.
 */
export interface ScreenProps {
  /** Who is signed in, as `/admin/api/ping` answered it. */
  session: {
    user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
    role: Role;
  };
  /** The admin's own fetch: it carries the session and resolves a path under the site's base. */
  request: typeof globalThis.fetch;
  /** Moves the admin to another of its addresses; false when an open editor refuses to leave. */
  navigate: (to: string) => Promise<boolean>;
  /** The language the admin is being read in. */
  uiLocale: UiLocale;
}
