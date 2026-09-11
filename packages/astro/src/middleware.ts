import config from 'virtual:handover/config';
import { AUTH_BASE_PATH, roleOf } from '@handover/core';
import type { MiddlewareHandler } from 'astro';
import { createAuth } from './auth.js';

// A draft page's links point at the live site, so clicking through a preview would leave it.
const base = () => (config.i18n.base ?? '').replace(/\/+$/, '');
const previewLinks = (html: string) =>
  html.replace(/(<a\b[^>]*\shref=")([^"#]+)(")/g, (all, before, path, after) => {
    const b = base();
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      (b && path !== b && !path.startsWith(`${b}/`))
    )
      return all;
    const local = path.slice(b.length) || '/';
    if (/^\/_preview(?:[/?#]|$)/.test(local)) return all;
    return `${before}${b}/_preview${local}${after}`;
  });

// The shell HTML and its assets stay public: they hold no data and render the login form.
export const onRequest: MiddlewareHandler = async ({ request, url, locals }, next) => {
  const b = base();
  const path =
    b && (url.pathname === b || url.pathname.startsWith(`${b}/`))
      ? url.pathname.slice(b.length)
      : b
        ? ''
        : url.pathname;
  if (request.method === 'GET' && /^\/_preview(?:\/|$)/.test(path)) {
    const res = await next();
    if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(previewLinks(await res.text()), { status: res.status, headers });
  }
  if (!path.startsWith('/admin/api/')) return next();
  // The login's own endpoints are the way in, so the session assert cannot sit in front of them.
  if (path.startsWith(`${AUTH_BASE_PATH}/`)) return next();

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
