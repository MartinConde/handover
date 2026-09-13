import config from 'virtual:handover/config';
import assets from 'virtual:handover/ui';

const base = (config.i18n.base ?? '').replace(/\/+$/, '');

import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '@handover/core';
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

const cookieLocale = (header: string | null): UiLocale | undefined => {
  for (const part of (header ?? '').slice(0, 4096).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'handover_ui_locale') continue;
    try {
      const value = decodeURIComponent(rest.join('='));
      return isUiLocale(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
};

const acceptedLocale = (header: string | null): UiLocale | undefined =>
  (header ?? '')
    .slice(0, 4096)
    .split(',')
    .map((part, order) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      let quality = 1;
      for (const parameter of parameters) {
        const match = parameter.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
        if (!match) return { locale: undefined, quality: 0, order };
        quality = Number(match[1]);
      }
      const language = tag.toLowerCase().split('-')[0];
      return { locale: isUiLocale(language) ? language : undefined, quality, order };
    })
    .filter((preference) => preference.locale && preference.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.order - b.order)[0]?.locale;

export const GET: APIRoute = ({ params, request }) => {
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
  const locale =
    cookieLocale(request.headers.get('cookie')) ??
    acceptedLocale(request.headers.get('accept-language')) ??
    DEFAULT_UI_LOCALE;
  return new Response(shell(JSON.stringify(loginMethods()), locale), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      vary: 'Cookie, Accept-Language',
    },
  });
};
