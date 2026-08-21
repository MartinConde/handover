import config from 'virtual:handover/config';
import type { APIRoute } from 'astro';
import { login } from '../auth.js';

export const GET: APIRoute = ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  return new Response('Not found', { status: 404 });
};

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  return new Response('Not found', { status: 404 });
};
