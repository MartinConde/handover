import config from 'virtual:handover/config';
import { previewTarget } from '@handover/core';
import type { APIRoute } from 'astro';
import { createAuth } from '../auth.js';

/**
 * The gate every preview response carries, rendered or refused. An SSR route putting draft
 * content on the client's own domain is a phishing primitive, so: never in a shared cache,
 * never in an index, and framed only by the admin that opened it — `'self'`, since the admin
 * is a route on this same site.
 */
const GATE = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "frame-ancestors 'self'",
};

const answer = (status: number, body: string | null) =>
  new Response(body, {
    status,
    headers: body === null ? GATE : { ...GATE, 'content-type': 'text/plain; charset=utf-8' },
  });

/**
 * Who may look, and at what. The session is asked for here rather than in the middleware
 * because an admin session will not be the only answer this route takes — a share link is a
 * token scoped to one entry, which "signed in or 401" cannot express.
 *
 * Nothing is rendered yet; what the path resolves to is settled all the same, because the
 * allow-list is the gate's other half.
 */
export const GET: APIRoute = async ({ params, request, url }) => {
  const session = await createAuth(url).api.getSession({ headers: request.headers });
  if (!session) return answer(401, 'Sign in to the admin to see a preview.');
  const target = previewTarget('default', config.i18n, config.collections, `/${params.path ?? ''}`);
  if (!target) return answer(404, 'This site serves no page at that address.');
  return answer(204, null);
};
