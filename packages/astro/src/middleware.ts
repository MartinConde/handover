import { AUTH_BASE_PATH, roleOf } from '@handover/core';
import type { MiddlewareHandler } from 'astro';
import { createAuth } from './auth.js';

// A draft page's links point at the live site, so clicking through a preview would leave it.
// Every link to a page on this site becomes that page's preview on the way out; an external
// link, a protocol-relative one and an anchor are not this site's and stay as they are.
const previewLinks = (html: string) =>
  html.replace(/(<a\b[^>]*\shref=")\/(?!\/|_preview(?:[/?#"]))/g, '$1/_preview/');

// The shell HTML and its assets stay public: they hold no data and render the login form.
export const onRequest: MiddlewareHandler = async ({ request, url, locals }, next) => {
  if (url.pathname.startsWith('/_preview')) {
    const res = await next();
    if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(previewLinks(await res.text()), { status: res.status, headers });
  }
  if (!url.pathname.startsWith('/admin/api/')) return next();
  // The login's own endpoints are the way in, so the session assert cannot sit in front of
  // them. What they expose is closed by Better Auth's own config, not by this file.
  if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return next();

  const session = await createAuth(url, locals.cfContext).api.getSession({
    headers: request.headers,
  });
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  locals.handover = {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    role: roleOf('default', session.user),
    sessionId: session.session.id,
  };
  return next();
};
