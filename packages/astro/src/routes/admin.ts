import type { APIRoute } from 'astro';

// Placeholder until the SPA shell ships; keeps the route SSR from day one.
export const GET: APIRoute = () => new Response('Handover admin', { status: 200 });
