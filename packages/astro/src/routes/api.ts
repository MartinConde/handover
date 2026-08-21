import config from 'virtual:handover/config';
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  return new Response('Not found', { status: 404 });
};
