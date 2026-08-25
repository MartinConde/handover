import assets from 'virtual:handover/ui';
import type { APIRoute } from 'astro';
import { loginMethods } from '../auth.js';

const ASSET_PREFIX = '_assets/';
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css' };

const tags = Object.keys(assets)
  .sort()
  .map((name) =>
    name.endsWith('.css')
      ? `<link rel="stylesheet" href="/admin/${ASSET_PREFIX}${name}">`
      : `<script type="module" src="/admin/${ASSET_PREFIX}${name}"></script>`,
  )
  .join('\n    ');

// The one value in the shell that is not the same on every site. It is two booleans, so it
// carries nothing a signed-out visitor could not work out from the buttons anyway — and it
// saves the login a request it has no session to make.
const shell = (methods: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Handover</title>
    ${tags}
  </head>
  <body>
    <div id="app" data-methods='${methods}'></div>
  </body>
</html>
`;

export const GET: APIRoute = ({ params }) => {
  const path = params.path ?? '';
  if (path.startsWith(ASSET_PREFIX)) {
    const name = path.slice(ASSET_PREFIX.length);
    const body = assets[name];
    const type = TYPES[name.split('.').pop() ?? ''];
    if (body === undefined || !type) return new Response('Not found', { status: 404 });
    return new Response(body, {
      headers: {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }
  return new Response(shell(JSON.stringify(loginMethods())), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};
