import type { Role, UiLocale } from '@handover/core';

/**
 * What the shell hands a site's own screen at `/admin/x/<key>`. Published to site authors as
 * `astro-handover/screen`, which carries the same four properties written out again.
 */
export interface ScreenProps {
  /** Who is signed in, as `/admin/api/ping` answered it. */
  session: {
    user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
    role: Role;
  };
  /** The admin's own fetch: it carries the session and resolves a path under the site's base. */
  request: typeof globalThis.fetch;
  /** Moves the shell to another admin address; it resolves false when the editor refuses to leave. */
  navigate: (to: string) => Promise<boolean>;
  /** The language the admin is being read in. */
  uiLocale: UiLocale;
}
