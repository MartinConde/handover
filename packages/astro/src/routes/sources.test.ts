import {
  blobSha,
  formOf,
  loadDraft,
  markTranslation,
  openDb,
  type PublishFile,
  parseEntry,
} from '@handover/core';
import type { APIContext } from 'astro';
import { z } from 'astro/zod';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import * as tables from '../../../core/src/tables.js';
import { formSchema } from '../index.js';
import { onRequest } from '../middleware.js';
import { GET, POST, PUT } from './api.js';

// The workflows harness with a third language: a legacy mark can then name a non-source one.
const boundary = vi.hoisted(() => ({
  binding: undefined as unknown,
  repo: undefined as unknown,
  // The provider as the route meets it: what it is asked to translate from is the point.
  translate: vi.fn(async (texts: string[], _from: string, to: string) =>
    texts.map((t) => `[${to}] ${t}`),
  ),
}));
vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() {
      return boundary.binding;
    },
    BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
    HANDOVER_BASE_URL: 'http://localhost',
    GITHUB_APP_ID: 'test',
    GITHUB_INSTALLATION_ID: 'test',
    GITHUB_PRIVATE_KEY: 'test',
    GITHUB_REPO: 'test/test',
  },
}));
vi.mock('virtual:handover/config', async () => {
  const { z } = await import('astro/zod');
  return {
    default: {
      i18n: {
        locales: ['en', 'de', 'fr'],
        defaultLocale: 'en',
        translate: (...args: [string[], string, string]) => boundary.translate(...args),
      },
      collections: {
        pages: {
          schema: z.object({ title: z.string().min(1), body: z.string().optional() }),
          route: '/[slug]',
        },
      },
      globals: {},
    },
  };
});
vi.mock('virtual:handover/index', () => ({
  default: {},
  preview: false,
  site: 'http://localhost',
  stale: {},
  templates: {},
  uses: {},
}));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  createGitClient: () => boundary.repo,
}));

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());
let db: ReturnType<typeof openDb>;
let owner: string;
let editor: string;
let trees: Record<string, Record<string, string>>;
let head: string;
let writes: PublishFile[][];
const form = formOf(
  'default',
  formSchema(z.object({ title: z.string().min(1), body: z.string().optional() })),
);
const path = (locale: string, slug = 'home') => `src/content/pages/${locale}/${slug}.yaml`;
const EN = '_version: 1\ntitle: "Home"\nbody: "Welcome"\n';
const DE = '_version: 1\ntitle: "Startseite"\nbody: "Willkommen"\n';

function push(files: Record<string, string>) {
  const parent = head;
  head = String(Object.keys(trees).length).padStart(40, '0');
  trees[head] = { ...trees[parent], ...files };
  return head;
}
async function signIn(id: string, role: 'owner' | 'editor') {
  const email = `${id}@example.com`;
  await db
    .insert(tables.user)
    .values({
      id,
      email,
      name: id === 'owner' ? 'Owner' : 'Erika',
      role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  const { hashPassword } = await import('better-auth/crypto');
  await db.insert(tables.account).values({
    id: `password-${id}`,
    userId: id,
    accountId: id,
    providerId: 'credential',
    issuer: 'local:credential',
    password: await hashPassword('a-test-password'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signed = await call(
    'POST',
    'auth/sign-in/email',
    { email, password: 'a-test-password' },
    '',
  );
  expect(signed.status).toBe(200);
  return signed.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
beforeAll(async () => {
  const binding = await mf.getD1Database('DB');
  boundary.binding = binding;
  db = openDb('default', binding);
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
  owner = await signIn('owner', 'owner');
  editor = await signIn('editor', 'editor');
});
beforeEach(async () => {
  await db.delete(tables.drafts);
  await db.delete(tables.activity);
  await db.delete(tables.operations);
  await db.delete(tables.locks);
  head = '0'.repeat(40);
  trees = { [head]: {} };
  writes = [];
  boundary.translate.mockClear();
  boundary.repo = {
    getHead: async () => head,
    getFile: async (at: string, sha = head) => {
      const contents = trees[sha]?.[at];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    getCommit: async () => undefined,
    fileCommits: async () => [],
    contentFiles: async (sha = head) =>
      Object.entries(trees[sha] ?? {}).map(([p, contents]) => ({ path: p, contents })),
    publish: async (files: PublishFile[], opts: { base_sha: string }) => {
      expect(head).toBe(opts.base_sha);
      writes.push(files);
      return {
        commit_sha: push(Object.fromEntries(files.map((f) => [f.path, f.contents ?? '']))),
      };
    },
  };
});

async function call(method: string, route: string, body?: unknown, cookies = owner) {
  const url = new URL(`http://localhost/admin/api/${route}`);
  const request = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: url.origin,
      ...(cookies ? { cookie: cookies } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = { url, request, params: { path: route }, locals: {} } as unknown as APIContext;
  const handler = method === 'GET' ? GET : method === 'PUT' ? PUT : POST;
  const response = await onRequest(ctx, () => Promise.resolve(handler(ctx)));
  if (!response) throw new Error('No response');
  return response;
}
type Listing = {
  base: string;
  entries: {
    key: string;
    source: string;
    locales: string[];
    drafts: boolean;
    stale: { locale: string; from: string }[];
  }[];
};
const listing = async () => (await (await call('GET', 'sources')).json()) as Listing;
const record = async (base: string) => call('POST', 'sources', { base });
// A translation marked against the source bytes it was made from, the way a save marks it.
const marked = async (contents: string, from: string, source: string) =>
  markTranslation(
    'default',
    form,
    { locale: from, contents: source, blob_sha: await blobSha(source) },
    contents,
    undefined,
  );
const markOf = (contents: string | undefined) =>
  (parseEntry('default', contents ?? '') as { _i18n?: Record<string, string> })._i18n;

test('records every file of an unmarked two-language entry and leaves the rest alone', async () => {
  const done = '_version: 1\n_source: en\ntitle: "Done"\n';
  trees[head] = {
    [path('en')]: EN,
    [path('de')]: DE,
    [path('en', 'solo')]: '_version: 1\ntitle: "Solo"\n',
    [path('en', 'done')]: done,
    [path('de', 'done')]: '_version: 1\ntitle: "Fertig"\n',
  };
  const before = { ...trees[head] };

  const found = await listing();
  expect(found.entries).toMatchObject([
    { key: 'pages/home', source: 'en', locales: ['en', 'de'], drafts: false, stale: [] },
  ]);
  const res = await record(found.base);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ entries: 1, stale: 0 });
  expect(writes.map((files) => files.map((f) => f.path).sort())).toEqual([
    [path('de'), path('en')],
  ]);
  expect(trees[head]?.[path('en')]).toBe(
    '_version: 1\n_source: "en"\ntitle: "Home"\nbody: "Welcome"\n',
  );
  expect(trees[head]?.[path('de')]).toBe(
    '_version: 1\n_source: "en"\ntitle: "Startseite"\nbody: "Willkommen"\n',
  );
  for (const unchanged of [path('en', 'solo'), path('en', 'done'), path('de', 'done')])
    expect(trees[head]?.[unchanged]).toBe(before[unchanged]);
  const [logged] = await db.select().from(tables.activity);
  expect(logged).toMatchObject({ kind: 'sources-recorded', commitSha: head, userId: 'owner' });
});

test('recording twice writes once: a retry answers the first result, a fresh look finds nothing', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  const { base } = await listing();
  const first = (await (await record(base)).json()) as { commit_sha: string };

  const retry = await record(base);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ commit_sha: first.commit_sha });

  const again = await listing();
  expect(again.entries).toEqual([]);
  const fresh = await record(again.base);
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({ entries: 0 });
  expect(writes).toHaveLength(1);
});

test('an open draft is rebased onto the commit and publishes without a conflict', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  const opened = (await (await call('GET', 'entries/pages/home')).json()) as {
    revisions: Record<string, string>;
  };
  const saved = await call('PUT', 'drafts/pages/home/de', {
    data: { title: 'Neue Startseite', body: 'Willkommen' },
    revision: opened.revisions.de,
  });
  expect(saved.status).toBe(200);
  const found = await listing();
  expect(found.entries[0]?.drafts).toBe(true);

  expect((await record(found.base)).status).toBe(200);
  const draft = await loadDraft('default', db, path('de'));
  expect(draft?.baseSha).toBe(head);
  expect(draft?.baseBlob).toBe(await blobSha(trees[head]?.[path('de')] ?? ''));
  expect(parseEntry('default', draft?.contents ?? '')).toMatchObject({
    _source: 'en',
    title: 'Neue Startseite',
  });

  const published = await call('POST', 'publish', { entries: ['pages/home'] });
  expect(published.status).toBe(200);
  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({
    _source: 'en',
    title: 'Neue Startseite',
  });
});

test('a French mark made from German moves to English only while German is in sync', async () => {
  const deInSync = await marked(DE, 'en', EN);
  const fr = '_version: 1\ntitle: "Accueil"\nbody: "Bienvenue"\n';
  const frFromDe = await marked(fr, 'de', deInSync);
  // German was translated from an older English, so French cannot be vouched for against it.
  const deBehind = await marked(DE, 'en', '_version: 1\ntitle: "Old home"\n');
  const frFromBehind = await marked(fr, 'de', deBehind);
  trees[head] = {
    [path('en')]: EN,
    [path('de')]: deInSync,
    [path('fr')]: frFromDe,
    [path('en', 'about')]: EN,
    [path('de', 'about')]: deBehind,
    [path('fr', 'about')]: frFromBehind,
  };

  const found = await listing();
  expect(found.entries).toMatchObject([
    { key: 'pages/about', source: 'en', stale: [{ locale: 'fr', from: 'de' }] },
    { key: 'pages/home', source: 'en', stale: [] },
  ]);
  const res = await record(found.base);

  expect(await res.json()).toMatchObject({ entries: 2, stale: 1 });
  const english = trees[head]?.[path('en')] ?? '';
  expect(markOf(trees[head]?.[path('fr')])).toEqual({
    sourceLocale: 'en',
    sourceBlob: await blobSha(english),
    sourceHash: markOf(deInSync)?.sourceHash,
    translatedAt: markOf(frFromDe)?.translatedAt,
  });
  expect(markOf(trees[head]?.[path('de')])).toEqual(markOf(deInSync));
  expect(markOf(trees[head]?.[path('fr', 'about')])).toEqual(markOf(frFromBehind));
});

test("another member's lock refuses and writes nothing", async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  await db
    .insert(tables.locks)
    .values({ entry: 'pages/home', userId: 'editor', expiresAt: Date.now() + 60_000 });
  const { base } = await listing();

  const res = await record(base);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: 'SOURCES_LOCKED',
    held: [{ key: 'pages/home', name: 'Erika' }],
  });
  expect(writes).toEqual([]);
  expect(await db.select().from(tables.operations)).toEqual([]);
});

test('a head that moved since the dialog read it refuses and writes nothing', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  const { base } = await listing();
  push({ [path('fr')]: '_version: 1\ntitle: "Accueil"\n' });

  const res = await record(base);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'SOURCES_CHANGED' });
  expect(writes).toEqual([]);
});

test('an editor can neither read nor record source languages', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };

  expect((await call('GET', 'sources', undefined, editor)).status).toBe(403);
  expect((await call('POST', 'sources', { base: head }, editor)).status).toBe(403);
  expect(writes).toEqual([]);
});

test('an entry whose source exists only as a draft waits for it to publish', async () => {
  trees[head] = { [path('de')]: DE, [path('fr')]: '_version: 1\ntitle: "Accueil"\n' };
  await db.insert(tables.drafts).values({
    path: path('en'),
    revision: 'r1',
    contents: EN,
    baseSha: head,
    baseBlob: '',
    updatedAt: Date.now(),
  });

  const found = await listing();
  expect(found.entries).toEqual([]);
  expect(await (await record(found.base)).json()).toMatchObject({ entries: 0 });
  expect(writes).toEqual([]);
});

// What the entry routes read and write once `entrySource` decides the source.
const drafted = async (locale: string, slug = 'home') =>
  parseEntry('default', (await loadDraft('default', db, path(locale, slug)))?.contents ?? '') as
    | Record<string, unknown>
    | undefined;
const opened = async (slug = 'home') =>
  (await (await call('GET', `entries/pages/${slug}`)).json()) as {
    sourceLocale: string;
    pending: string[];
    revisions: Record<string, string>;
  };

test('a German-first entry stays German-sourced while English and French are created and pre-filled', async () => {
  trees[head] = { [path('de')]: DE };

  expect((await call('POST', 'drafts/pages/home/en')).status).toBe(200);
  expect((await call('POST', 'translate/pages/home/en', {})).status).toBe(200);
  expect((await call('POST', 'drafts/pages/home/fr')).status).toBe(200);
  expect((await call('POST', 'translate/pages/home/fr', {})).status).toBe(200);

  expect(boundary.translate.mock.calls.map(([, from, to]) => [from, to])).toEqual([
    ['de', 'en'],
    ['de', 'fr'],
  ]);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).toMatchObject({
    _source: 'de',
    title: '[en] Startseite',
    _i18n: { sourceLocale: 'de' },
  });
});

test('creating English on an unrecorded German-only entry marks only the English file', async () => {
  trees[head] = { [path('de')]: DE };

  expect((await call('POST', 'drafts/pages/home/en')).status).toBe(200);

  expect(await drafted('en')).toMatchObject({ _version: 1, _source: 'de' });
  expect(await loadDraft('default', db, path('de'))).toBeUndefined();
  const entry = await opened();
  expect(entry.sourceLocale).toBe('de');
  expect(entry.pending).toEqual(['en']);
});

test('once English records the source, a save of the German file stamps it too', async () => {
  trees[head] = { [path('de')]: DE };
  await call('POST', 'drafts/pages/home/en');
  const { revisions } = await opened();

  const saved = await call('PUT', 'drafts/pages/home/de', {
    data: { title: 'Neue Startseite', body: 'Willkommen' },
    revision: revisions.de,
  });

  expect(saved.status).toBe(200);
  expect((await loadDraft('default', db, path('de')))?.contents).toBe(
    '_version: 1\n_source: "de"\ntitle: "Neue Startseite"\nbody: "Willkommen"\n',
  );
});

test('turning off English, the only marked file, writes the source into the German file it keeps', async () => {
  trees[head] = {
    [path('de')]: DE,
    [path('en')]: '_version: 1\n_source: de\ntitle: "Home"\nbody: "Welcome"\n',
  };
  // An open German draft is moved onto the commit, so it must carry the key too.
  await db.insert(tables.drafts).values({
    path: path('de'),
    revision: 'r1',
    contents: '_version: 1\ntitle: "Neue Startseite"\nbody: "Willkommen"\n',
    baseSha: head,
    baseBlob: await blobSha(DE),
    updatedAt: Date.now(),
  });

  const res = await call('POST', 'entries/pages/home/locales', { locales: ['de', 'fr'] });

  expect(res.status).toBe(200);
  expect(trees[head]?.[path('en')]).toBe('');
  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({
    _source: 'de',
    _locales: ['de', 'fr'],
    title: 'Startseite',
  });
  expect(await drafted('de')).toMatchObject({ _source: 'de', title: 'Neue Startseite' });
});

test('turning off the language a recorded entry is written in hands the source to what stays', async () => {
  trees[head] = {
    [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\nbody: "Welcome"\n',
    [path('de')]: '_version: 1\n_source: en\ntitle: "Startseite"\nbody: "Willkommen"\n',
  };

  const res = await call('POST', 'entries/pages/home/locales', { locales: ['de', 'fr'] });

  expect(res.status).toBe(200);
  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({ _source: 'de' });
  expect((await opened()).sourceLocale).toBe('de');
});

test('a new entry on a site with several languages records the language it starts in', async () => {
  const res = await call('POST', 'entries/pages', { title: 'About' });

  expect(await res.json()).toEqual({ slug: 'about' });
  expect((await loadDraft('default', db, path('en', 'about')))?.contents).toBe(
    '_version: 1\n_source: "en"\ntitle: "About"\n',
  );
});

test('saves of an unrecorded entry with several files write no source', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  const { revisions } = await opened();

  await call('PUT', 'drafts/pages/home/en', {
    data: { title: 'Home!', body: 'Welcome' },
    revision: revisions.en,
  });
  await call('PUT', 'drafts/pages/home/de', {
    data: { title: 'Startseite!', body: 'Willkommen' },
    revision: revisions.de,
  });

  expect((await loadDraft('default', db, path('en')))?.contents).toBe(
    '_version: 1\ntitle: "Home!"\nbody: "Welcome"\n',
  );
  expect(await drafted('de')).not.toHaveProperty('_source');
});

test('a German-first entry published with English still opens in German', async () => {
  trees[head] = { [path('de')]: DE };
  await call('POST', 'drafts/pages/home/en');
  const { revisions } = await opened();
  await call('PUT', 'drafts/pages/home/en', {
    data: { title: 'Home', body: 'Welcome' },
    revision: revisions.en,
  });

  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);

  expect(trees[head]?.[path('de')]).toBe(DE);
  expect((await opened()).sourceLocale).toBe('de');
});
