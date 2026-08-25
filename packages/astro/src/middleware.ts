import { AUTH_BASE_PATH, roleOf } from '@handover/core';
import type { MiddlewareHandler } from 'astro';
import { createAuth } from './auth.js';

// The shell HTML and its assets stay public: they hold no data and render the login form.
export const onRequest: MiddlewareHandler = async ({ request, url, locals }, next) => {
  if (!url.pathname.startsWith('/admin/api/')) return next();
  // The login's own endpoints are the way in, so the session assert cannot sit in front of
  // them. What they expose is closed by Better Auth's own config, not by this file.
  if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return next();

  const session = await createAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  locals.handover = {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    role: roleOf(session.user),
  };
  return next();
};
