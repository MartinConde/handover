import config from 'virtual:handover/config';
import { AUTH_BASE_PATH, ContentError, roleOf, type UiLocale } from '@handover/core';
import type { MiddlewareHandler } from 'astro';
import { createAuth } from './auth.js';
import { canvasErrorDocument, errorManifest, GATE } from './canvas.js';

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
  // Canvas annotations throw while the page streams, after the preview route's own catch.
  if (request.method === 'POST' && /^\/_preview(?:\/|$)/.test(path)) {
    let res: Response;
    let html: string;
    try {
      res = await next();
      if (!res.headers.get('content-type')?.includes('text/html')) return res;
      html = await res.text();
    } catch (error) {
      const canvas = locals.handoverCanvas;
      if (!(error instanceof ContentError) || !canvas) throw error;
      const message = `This draft cannot be rendered:\n${error.message}`;
      return new Response(canvasErrorDocument(errorManifest(422, message, canvas)), {
        status: 422,
        headers: { ...GATE, 'content-type': 'text/html; charset=utf-8' },
      });
    }
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(html, { status: res.status, statusText: res.statusText, headers });
  }
  if (!path.startsWith('/admin/api/')) return next();
  const privateResponse = async (work: () => Promise<Response>) => {
    let response: Response;
    try {
      response = await work();
    } catch {
      response = Response.json({ error: 'Internal server error' }, { status: 500 });
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return privateResponse(async () => {
    // Authentication endpoints are the way in, so session checks cannot precede them.
    if (path.startsWith(`${AUTH_BASE_PATH}/`)) return next();
    const session = await createAuth(url, locals.cfContext).api.getSession({
      headers: request.headers,
    });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const user = session.user as typeof session.user & { uiLocale: UiLocale | null };
    locals.handover = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        uiLocale: user.uiLocale,
      },
      role: roleOf('default', user),
      sessionId: session.session.id,
    };
    return next();
  });
};
