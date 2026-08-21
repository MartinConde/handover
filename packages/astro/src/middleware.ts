// Phase 0 password gate. Phase 3 deletes this.
import type { MiddlewareHandler } from 'astro';
import { isAuthorized } from './auth.js';

// The shell HTML and its assets stay public: they hold no data and render the login form.
export const onRequest: MiddlewareHandler = async ({ request, url }, next) => {
  if (!url.pathname.startsWith('/admin/api/') || url.pathname === '/admin/api/login') {
    return next();
  }
  if (await isAuthorized(request)) return next();
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
};
