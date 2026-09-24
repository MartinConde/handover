<script lang="ts">
import type { Field } from '@handover/core';
import App from '../../../../../../ui/src/App.svelte';
import { requiredFieldProblems } from '../../../../../../ui/src/editor/required-fields';
import '../../../../../../ui/src/tokens.css';

const editorEntry = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['hero'],
      label: 'Hero image',
      type: 'image',
      required: false,
      preset: { ratio: '3:2', max: 2400 },
    },
    { path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' },
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
    { path: ['button'], label: 'Button', type: 'link', required: false },
    { path: ['legacy'], label: 'Legacy prose', type: 'richtext', required: false, tier: 'basic' },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['repeated', 'promo', 'columns'],
    },
  ] satisfies Field[],
  blocks: {
    repeated: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    promo: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    columns: [
      {
        path: ['columns'],
        label: 'Columns',
        type: 'array',
        required: true,
        item: [
          {
            path: ['blocks'],
            label: 'Blocks',
            type: 'blocks',
            required: true,
            types: ['repeated', 'promo', 'columns'],
          },
        ],
      },
    ],
  } satisfies Record<string, Field[]>,
  data: {
    title: 'Canvas fixture',
    hero: { src: 'canvas-fixture-image.svg', width: 1200, height: 800, alt: 'Harbour at dusk' },
    summary: 'Harbour home',
    body: 'Room for **everyone**.',
    button: { type: 'url', href: 'https://example.com/book', label: 'Book a viewing' },
    legacy: '# Code-owned heading',
    blocks: [
      { _type: 'repeated', _id: 'repeat01', heading: 'Repeated source field' },
      {
        _type: 'columns',
        _id: 'columns1',
        columns: [
          {
            _id: 'column01',
            blocks: [
              { _type: 'repeated', _id: 'repeat02', heading: 'Nested repeated field' },
              { _type: 'promo', _id: 'promo001', _ref: 'globals/shared-promo' },
            ],
          },
          { _id: 'column02', blocks: [] },
        ],
      },
    ],
  },
  revisions: { en: 'fixture-revision' },
  pending: [],
  published: ['en'],
  problems: [],
  locales: ['en'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en'],
  translations: {},
  stale: [],
  drift: [],
  route: '/[slug]',
};

const translatedEntry = {
  ...editorEntry,
  revisions: { en: 'fixture-en-1', de: 'fixture-de-1' },
  locales: ['en', 'de'],
  offered: ['en', 'de'],
  translations: {
    de: {
      ...editorEntry.data,
      title: 'Canvas-Testseite',
      blocks: [
        { _type: 'repeated', _id: 'repeat01', heading: 'Wiederholtes Ausgangsfeld' },
        {
          _type: 'columns',
          _id: 'columns1',
          columns: [
            {
              _id: 'column01',
              blocks: [
                { _type: 'repeated', _id: 'repeat02', heading: 'Verschachteltes Feld' },
                { _type: 'promo', _id: 'promo001', _ref: 'globals/shared-promo' },
              ],
            },
            { _id: 'column02', blocks: [] },
          ],
        },
      ],
    },
  },
};

const secondEntry = {
  ...editorEntry,
  data: { ...editorEntry.data, title: 'Second page' },
};

const driftEntry = {
  ...translatedEntry,
  drift: [
    {
      path: 'blocks[_id=repeat01]',
      type: 'repeated',
      in: ['en'],
      expected: ['en', 'de'],
      values: { en: ['Repeated source field'] },
    },
  ],
};

if (typeof window !== 'undefined') {
  const originalFetch = window.fetch.bind(window);
  let draftRevision = 1;
  let failNextSave = false;
  let driftResolved = false;
  const fixtureWindow = window as unknown as {
    canvasDraftWrites: unknown[];
    canvasFailNextSave: () => void;
  };
  fixtureWindow.canvasDraftWrites = [];
  fixtureWindow.canvasFailNextSave = () => (failNextSave = true);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    if (path === '/admin/api/entries/pages/canvas-fixture') {
      if (location.search.includes('polish-invalid'))
        return Response.json({
          ...editorEntry,
          problems: [{ path: 'title', message: 'Enter a page title' }],
        });
      if (location.search.includes('c33-drift'))
        return Response.json(driftResolved ? translatedEntry : driftEntry);
      return Response.json(location.search.includes('c30') ? translatedEntry : editorEntry);
    }
    if (path === '/admin/api/entries/pages/second') return Response.json(secondEntry);
    if (path === '/admin/api/entries')
      return Response.json({
        entries: [
          {
            collection: 'pages',
            path: 'pages/canvas-fixture',
            title: 'Canvas fixture',
            locales: ['en'],
            urls: { en: '/canvas-fixture' },
          },
          {
            collection: 'pages',
            path: 'pages/second',
            title: 'Second page',
            locales: ['en'],
            urls: { en: '/second' },
          },
        ],
        indexes: [],
        locales: ['en'],
        defaultLocale: 'en',
      });
    if (
      path === '/admin/api/locks/pages/canvas-fixture' ||
      path === '/admin/api/locks/pages/second'
    )
      return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 });
    if (path === '/admin/api/drafts') return Response.json({ entries: [], defaultLocale: 'en' });
    if (path === '/admin/api/build') return Response.json({});
    if (path === '/admin/api/publish/checks') return Response.json({ results: [] });
    if (path === '/admin/api/drift/pages/canvas-fixture' && init?.method === 'POST') {
      driftResolved = true;
      return Response.json({});
    }
    if (path === '/admin/api/drafts/pages/canvas-fixture' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as { data: Record<string, unknown> };
      fixtureWindow.canvasDraftWrites.push(body);
      if (failNextSave) {
        failNextSave = false;
        return new Response('Save refused by fixture', { status: 500 });
      }
      draftRevision += 1;
      return Response.json({
        pending: true,
        problems: Object.entries(
          requiredFieldProblems(editorEntry.fields, body.data, editorEntry.blocks),
        ).map(([path, message]) => ({ path, message })),
        revisions: { en: `fixture-en-${draftRevision}`, de: `fixture-de-${draftRevision}` },
      });
    }
    if (path === '/admin/api/drafts/pages/canvas-fixture/de' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as { data: Record<string, unknown> };
      fixtureWindow.canvasDraftWrites.push(body);
      draftRevision += 1;
      return Response.json({
        pending: true,
        problems: [],
        revision: `fixture-de-${draftRevision}`,
      });
    }
    if (path.startsWith('/admin/api/')) return Response.json({});
    return originalFetch(input, init);
  };
}

const session = {
  collections: ['pages'],
  preview: true,
  user: { id: 'fixture-user', name: 'Fixture Editor', email: 'editor@example.com' },
  role: 'editor' as const,
};
</script>

<App {session} path="/admin/c/pages/canvas-fixture" />
