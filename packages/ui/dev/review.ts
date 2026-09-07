/** Development-only design preview. All API traffic is handled locally; no site is connected. */
import { mount } from 'svelte';
import App from '../src/App.svelte';
import '../src/tokens.css';

if (!import.meta.env.DEV) throw new Error('The design preview is only available in development');
const now = Date.now();
const locales = ['en', 'de'];
const rows = [
  { id: 'cafe-bar-2026', title: 'Café & Bar / 2026', hidden: true, missing: true },
  { id: 'mill-house', title: 'The Mill House' },
  { id: 'seaview-cottage', title: 'Seaview Cottage, Port Isaac', pending: true },
];
const entries = rows.map((row, i) => ({
  id: row.id,
  locales: Object.fromEntries(
    (row.missing ? ['en'] : locales).map((locale) => [
      locale,
      {
        title: row.title,
        path: `/listings/${row.id}`,
        ...(row.hidden ? { status: 'hidden' } : {}),
      },
    ]),
  ),
  pending: row.pending,
  edited: { at: now - (i + 1) * 3600000, by: 'Martin', kind: row.pending ? 'edit' : 'publish' },
}));
const globals = [
  {
    key: 'site',
    label: 'Site details',
    description: 'Your site name, contact details, and footer',
  },
  {
    key: 'navigation',
    label: 'Navigation',
    description: 'The menus that help visitors find their way',
  },
  {
    key: 'newsletter',
    label: 'Newsletter call-to-action',
    description: 'Your newsletter invitation, shared across the site',
    pending: true,
  },
].map((item) => ({ ...item, locales }));
const pending = [
  {
    key: 'listings/seaview-cottage',
    title: 'Seaview Cottage, Port Isaac',
    collection: 'listings',
    locales,
    files: [],
    updated_at: now - 3600000,
  },
];
const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: true },
  { path: ['location'], label: 'Location', type: 'text', required: true },
  { path: ['price'], label: 'Price', type: 'text', required: true },
  { path: ['summary'], label: 'Summary', type: 'text', required: true },
  {
    path: ['photo'],
    label: 'Photo',
    type: 'image',
    required: false,
    preset: { ratio: '3:2', min: 1200, max: 2400 },
  },
  {
    path: ['brochure'],
    label: 'Brochure',
    type: 'file',
    required: false,
    accept: ['application/pdf'],
  },
  { path: ['phone'], label: 'Phone', type: 'text', required: false },
  { path: ['note'], label: 'Internal note', type: 'text', required: false, i18n: false },
  { path: ['seo'], label: 'SEO', type: 'seo', required: false },
];
const pageFields = [
  fields[0],
  {
    path: ['blocks'],
    label: 'Blocks',
    type: 'blocks',
    required: true,
    types: ['hero', 'textSection'],
  },
  fields.at(-1),
];
const blocks = {
  hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }, fields[4]],
  textSection: [{ path: ['body'], label: 'Body', type: 'richtext', required: true, tier: 'full' }],
};
const pageData = {
  title: 'Home',
  blocks: [
    { _id: 'k3nf9a2p', _type: 'hero', heading: 'Move to the coast this year' },
    {
      _id: 'a1b2c3d4',
      _type: 'textSection',
      body: 'Find a place to call your own. Explore our collection of coastal homes.',
    },
  ],
};
const config = {
  collections: [
    { name: 'listings', route: '/listings/[slug]' },
    { name: 'pages', route: '/[slug]' },
    { name: 'samples' },
  ],
  locales,
  defaultLocale: 'en',
  mediaBase: 'https://media.example.com',
  mailer: { provider: 'resend', from: 'Handover <admin@example.com>' },
  preview: false,
  dev: false,
};
const session = {
  collections: ['listings', 'pages', 'samples'],
  user: { id: 'preview', name: 'Martin', email: 'martin@example.com' },
  role: 'owner' as const,
  preview: false,
};
const media = ['Coastal blue', 'Garden green', 'Sandstone'].map((label, i) => ({
  id: String(i + 1).repeat(64),
  src: `media/sample-${i}.svg`,
  filename: `${label.toLowerCase().replace(' ', '-')}.svg`,
  url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="${['#dbe5e9', '#e0e8d5', '#ede1d3'][i]}"/><rect x="60" y="55" width="480" height="290" rx="4" fill="none" stroke="${['#8aabb8', '#9eaf8c', '#bda38a'][i]}"/><text x="300" y="196" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#4b5650">${label}</text><text x="300" y="229" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#4b5650">Sample image</text></svg>`)}`,
  mime: 'image/svg+xml',
  bytes: 18400,
  width: 1200,
  height: 800,
  alt: label,
  tags: [],
  archived: false,
  createdAt: now - 86400000,
  uses: i === 0 ? [{ entry: 'pages/home', title: 'Home', href: '/admin/c/pages/home' }] : [],
}));
const actualFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof Request ? input.url : input.href,
    location.origin,
  );
  const path = url.pathname;
  const json = (data: unknown) => Response.json(data);
  if (!path.startsWith('/admin/api/')) return actualFetch(input, init);
  if (path === '/admin/api/ping') return json(session);
  if (path.startsWith('/admin/api/locks/'))
    return json({
      mine: true,
      expires_at: now + 120000,
      held_by: { id: 'preview', name: 'Martin' },
    });
  if (path === '/admin/api/publish/checks') return json({ results: [] });
  if (init?.method && init.method !== 'GET' && !path.startsWith('/admin/api/checks/'))
    return Response.json(
      { error: 'This is a design preview. Connect a site to save changes.' },
      { status: 403 },
    );
  if (path === '/admin/api/drafts') return json({ entries: pending, defaultLocale: 'en' });
  if (path === '/admin/api/build')
    return json({ state: 'live', started_at: now - 7200000, completed_at: now - 7100000 });
  if (path === '/admin/api/globals') return json({ globals, locales });
  if (path === '/admin/api/entries/listings') return json({ entries, locales, templates: [] });
  if (path === '/admin/api/entries/pages')
    return json({
      entries: [
        {
          id: 'home',
          locales: {
            en: { title: 'Home', path: '/home' },
            de: { title: 'Startseite', path: '/de/startseite' },
          },
          pending: true,
          stale: ['de'],
        },
      ],
      locales,
      templates: [],
    });
  if (path === '/admin/api/entries/samples') return json({ entries: [], locales, templates: [] });
  const match = path.match(/^\/admin\/api\/entries\/(listings|pages|globals)\/([^/]+)$/);
  if (match) {
    const isPage = match[1] === 'pages';
    const data = isPage
      ? pageData
      : {
          title: rows.find((row) => row.id === match[2])?.title || 'Site details',
          location: 'Port Isaac, Cornwall',
          price: '£1,200 per week',
          summary: 'A coastal retreat with views across the harbour.',
          phone: '+44 1208 555 014',
          note: '',
        };
    return json({
      fields: isPage ? pageFields : fields,
      blocks,
      data,
      pending: [],
      published: locales,
      problems: [],
      locales,
      defaultLocale: 'en',
      sourceLocale: 'en',
      offered: locales,
      translations: {
        de: isPage
          ? {
              ...pageData,
              title: 'Startseite',
              blocks: [{ ...pageData.blocks[0], heading: 'Zieh an die Küste' }, pageData.blocks[1]],
            }
          : { ...data, title: 'Das Mühlenhaus', location: 'Port Isaac, Cornwall' },
      },
      stale: isPage ? ['de'] : [],
      drift: [],
      localizedSlugs: true,
      route: isPage ? '/[slug]' : '/listings/[slug]',
      ...(match[1] === 'globals' ? { singleton: true, label: 'Site details' } : {}),
    });
  }
  if (path === '/admin/api/diagnostics') return json(config);
  if (path === '/admin/api/settings') return json({ integrations: [] });
  if (path.startsWith('/admin/api/checks/'))
    return json({ ok: true, detail: 'Example connection result. No service was contacted.' });
  if (path === '/admin/api/dashboard')
    return json({
      recent: entries.map((row) => ({
        key: `listings/${row.id}`,
        title: row.locales.en.title,
        collection: 'listings',
        href: `/admin/c/listings/${row.id}`,
        at: row.edited.at,
        by: 'Martin',
        kind: row.edited.kind,
      })),
      published: { at: now - 7200000, by: 'Martin' },
      translations: {
        defaultLocale: 'en',
        locales: [{ locale: 'de', missing: 1, stale: 1, where: ['listings', 'pages'] }],
      },
    });
  if (path === '/admin/api/members')
    return json({
      members: [
        {
          id: 'preview',
          name: 'Martin',
          email: 'martin@example.com',
          role: 'owner',
          pending: false,
          methods: ['password'],
          lastSignIn: now - 3600000,
        },
      ],
    });
  if (path.startsWith('/admin/api/activity')) return json({ events: [], cursor: null });
  if (path.startsWith('/admin/api/deleted/')) return json({ deleted: [] });
  if (path.startsWith('/admin/api/history/')) return json({ versions: [] });
  if (path === '/admin/api/media')
    return json({
      media:
        url.searchParams.get('kind') === 'files'
          ? []
          : media.filter((item) => item.filename.includes(url.searchParams.get('q') || '')),
    });
  if (path === '/admin/api/redirects')
    return json({
      rules: [
        [
          '/listings/old-mill',
          '/listings/mill-house',
          301,
          'slug-change',
          'listings/mill-house',
          'The Mill House',
          42,
        ],
        ['/listings/harbour-bar-2026', '/', 301, 'deleted', undefined, undefined, 30],
        [
          '/listings/cafe-bar-2026',
          '/listings',
          301,
          'hidden',
          'listings/cafe-bar-2026',
          'Café & Bar / 2026',
          16,
        ],
        [
          '/listings/seaview-cottage-2025',
          '/listings/seaview-cottage',
          301,
          'slug-change',
          'listings/seaview-cottage',
          'Seaview Cottage, Port Isaac',
          3,
        ],
        [
          '/brochure',
          'https://example.com/files/brochure-2026.pdf',
          302,
          'manual',
          undefined,
          undefined,
          1,
        ],
      ].map(([from, to, status, reason, entry, title, days], i) => ({
        _id: `rule${i}`,
        from,
        to,
        status,
        reason,
        entry,
        title,
        createdAt: new Date(now - Number(days) * 86400000).toISOString(),
        ...(i === 3 ? { pending: true } : {}),
      })),
    });
  return json({ entries: [], locales });
};
const target = document.getElementById('app');
if (target)
  mount(App, {
    target,
    props: { session, path: new URLSearchParams(location.search).get('screen') || '/admin' },
  });
const note = document.createElement('div');
note.textContent = 'Design preview · sample content';
note.style.cssText =
  'position:fixed;bottom:8px;left:12px;z-index:45;font:10px system-ui;color:#616a63;background:#f7f8f7;padding:4px 6px;border-radius:4px;pointer-events:none';
document.body.append(note);
