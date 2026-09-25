import { texts } from 'virtual:handover/index';
import { createGitClient, openDb } from '@handover/core';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ctx,
  getFile,
  post,
  publish,
  put,
  resetContainers,
  resetMocks,
  resetState,
  state,
} from './api/harness.fixture.js';
import { GET, POST, PUT } from './api.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./api/harness.fixture.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../auth.js', async (original) => authMock((await original()) as Record<string, unknown>));
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

afterEach(() => {
  vi.unstubAllGlobals();
  resetContainers();
  resetMocks();
  resetState();
  for (const key of Object.keys(texts)) delete texts[key];
});

test('ping returns the collection names and who is signed in', async () => {
  const session = {
    user: { id: 'u1', name: 'Anna Berg', email: 'anna@example.com', uiLocale: 'de' },
    role: 'editor',
  };
  const res = await GET(ctx('ping', undefined, { handover: session }));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.json()).toEqual({
    ok: true,
    collections: ['pages', 'listings', 'presenters', 'posts', 'notices'],
    // Every language's, so switching the interface language needs no second request.
    collectionLabels: {
      listings: { label: { en: 'homes', de: 'Häuser' }, singular: { en: 'home', de: 'Haus' } },
    },
    user: session.user,
    role: 'editor',
    // Where a stored key is served from: the widgets draw thumbnails of keys nothing listed.
    mediaBase: 'https://media.example.com',
    // Every ratio the site's own fields show a picture at, which is what the focal picker previews.
    presets: [
      { label: 'Portrait', preset: { ratio: '1:1', max: 512 } },
      // The site's default social card: the one preset a platform fixes rather than a designer.
      {
        label: 'Default social image',
        labels: { en: 'Default social image', de: 'Standard-Social-Media-Bild' },
        preset: { ratio: '1.91:1', max: 1200, min: 1200 },
      },
    ],
    // Whether this build has a preview route at all.
    preview: true,
    // `site` from astro.config, which is what the SEO panel's previews print addresses under.
    site: 'https://coastalhomes.example',
    // A site that declares no screens of its own still says so, so the shell draws no Site group.
    screens: [],
  });
});

// The sidebar is drawn before any screen is loaded, so ping carries what a link needs.
test('ping lists the screens the site declares', async () => {
  const { default: config } = await import('virtual:handover/config');
  config.admin = {
    screens: {
      analytics: {
        component: './src/admin/Analytics.svelte',
        label: { en: 'Analytics', de: 'Statistik' },
        roles: ['owner'],
      },
      bookings: { component: './src/admin/Bookings.svelte', label: 'Bookings' },
    },
  };
  try {
    const body = (await (await GET(ctx('ping'))).json()) as { screens: unknown };
    expect(body.screens).toEqual([
      { key: 'analytics', label: { en: 'Analytics', de: 'Statistik' }, roles: ['owner'] },
      // No roles means both of them, which is why the key is absent rather than listed twice.
      { key: 'bookings', label: 'Bookings' },
    ]);
  } finally {
    config.admin = undefined;
  }
});

test('ping exposes an unset interface preference', async () => {
  const session = {
    user: { id: 'u1', name: 'Anna Berg', email: 'anna@example.com', uiLocale: null },
    role: 'editor',
  };

  const res = await GET(ctx('ping', undefined, { handover: session }));

  const body = (await res.json()) as { user: unknown };
  expect(body.user).toEqual(session.user);
});

test('unknown paths are 404', async () => {
  expect((await GET(ctx('nope'))).status).toBe(404);
  expect((await POST(post('nope', ''))).status).toBe(404);
});

test('the browser cannot hand file contents to the publish endpoint', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('entries/listings/mill-house', JSON.stringify({ data })))).status).toBe(
    404,
  );
  await POST(post('publish', JSON.stringify({ files: [{ path: 'evil.yaml', contents: 'x' }] })));
  expect(publish).not.toHaveBeenCalled();
});

test('entry routing accepts every repository-addressable name segment and rejects punctuation', async () => {
  state.draft = { contents: 'name: "Addressable"\n', baseSha: 'head789', baseBlob: '' };
  expect((await GET(ctx('entries/presenters/About_Us-2'))).status).toBe(200);
  expect((await GET(ctx('entries/presenters/about.us'))).status).toBe(404);
  expect((await GET(ctx('history/presenters/about.us'))).status).toBe(404);
});

// A site with one language has no second file to compare against and never reads for one.
test('a one-language site is not asked for a second language of anything', async () => {
  getFile.mockClear();

  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as { drift: unknown };

  expect(body.drift).toEqual([]);
  expect(getFile).toHaveBeenCalledTimes(1);

  getFile.mockClear();
  await POST(post('publish', ''));

  expect(getFile).not.toHaveBeenCalled();
});

test('each request reuses its own lazy GitHub and database dependencies', async () => {
  vi.mocked(createGitClient).mockClear();
  vi.mocked(openDb).mockClear();
  expect((await GET(ctx('ping'))).status).toBe(200);
  expect(createGitClient).not.toHaveBeenCalled();
  expect(openDb).not.toHaveBeenCalled();
  const responses = await Promise.all([
    GET(ctx('entries/listings/mill-house')),
    GET(ctx('entries/listings/mill-house')),
  ]);
  expect(responses.map((res) => res.status)).toEqual([200, 200]);
  expect(createGitClient).toHaveBeenCalledTimes(2);
  expect(openDb).toHaveBeenCalledTimes(2);
});
