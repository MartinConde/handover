import config from 'virtual:handover/config';
import assets from 'virtual:handover/ui';

const base = siteBase(config.i18n);

import { DEFAULT_UI_LOCALE, siteBase, type UiLocale } from '@handover/core';
import type { APIRoute } from 'astro';
import { loginMethods } from '../auth.js';
import { requestLocale } from '../locale.js';
import { notFound } from './api/respond.js';

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
const shell = (methods: string, locale: UiLocale) => `<!doctype html>
<html lang="${locale}">
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

export const GET: APIRoute = ({ params, request }) => {
  const path = params.path ?? '';
  if (path.startsWith(ASSET_PREFIX)) {
    const name = path.slice(ASSET_PREFIX.length);
    const body = assets.files[name];
    const type = TYPES[name.split('.').pop() ?? ''];
    if (body === undefined || !type) return notFound();
    return new Response(body, {
      headers: {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const locale = requestLocale(request) ?? DEFAULT_UI_LOCALE;
  return new Response(shell(JSON.stringify(loginMethods()), locale), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      // Scripts only: the admin shows media from other hosts and frames this site's own previews.
      'content-security-policy':
        "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      vary: 'Cookie, Accept-Language',
    },
  });
};
