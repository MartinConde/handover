import config from 'virtual:handover/config';
import assets from 'virtual:handover/ui';

const base = (config.i18n.base ?? '').replace(/\/+$/, '');

import type { APIRoute } from 'astro';
import { loginMethods } from '../auth.js';

const ASSET_PREFIX = '_assets/';
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css' };

const admin = assets.entries.admin;
if (!admin) throw new Error('Handover UI build has no admin entry');
const tags = [
  ...admin.styles.map(
    (name) => `<link rel="stylesheet" href="${base}/admin/${ASSET_PREFIX}${name}">`,
  ),
  `<script type="module" src="${base}/admin/${ASSET_PREFIX}${admin.script}"></script>`,
].join('\n    ');

// The one value in the shell that is not the same on every site.
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
    <div id="app" data-base='${base}' data-methods='${methods}'></div>
  </body>
</html>
`;

export const GET: APIRoute = ({ params }) => {
  const path = params.path ?? '';
  if (path.startsWith(ASSET_PREFIX)) {
    const name = path.slice(ASSET_PREFIX.length);
    const body = assets.files[name];
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
