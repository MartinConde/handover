import {
  blobSha,
  createDraft,
  formOf,
  loadDraft,
  markTranslation,
  openDb,
  type PublishFile,
  parseEntry,
  pendingDrafts,
} from '@handover/core';
import type { APIContext } from 'astro';
import { z } from 'astro/zod';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import * as tables from '../../../../core/src/tables.js';
import { formSchema } from '../../index.js';
import { onRequest } from '../../middleware.js';
import { DELETE, GET, POST, PUT } from '../api.js';

// The workflows harness with a third language: a legacy mark can then name a non-source one.
const boundary = vi.hoisted(() => ({
  binding: undefined as unknown,
  repo: undefined as unknown,
  beforeCreate: undefined as undefined | (() => Promise<void>),
  beforeRewrite: undefined as undefined | (() => Promise<void>),
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
  const { blocks, defineBlock } = await import('../../index.js');
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
        // Only a collection with its own address per language has the address route.
        posts: {
          schema: z.object({ title: z.string().min(1), slug: z.string().optional() }),
          route: '/posts/[slug]',
          localizedSlugs: true,
        },
        // Blocks the languages can disagree about, and a note only the source keeps.
        rooms: {
          schema: z.object({
            title: z.string().min(1),
            notes: z.string().optional().meta({ i18n: false }),
            blocks: blocks(() => ({ hero: defineBlock('hero', { heading: z.string() }) })),
          }),
          route: '/rooms/[slug]',
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
  texts: {},
  uses: {},
}));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  createGitClient: () => boundary.repo,
  createDraft: async (...args: Parameters<typeof import('@handover/core')['createDraft']>) => {
    const hook = boundary.beforeCreate;
    boundary.beforeCreate = undefined;
    if (hook) await hook();
    return (await original<typeof import('@handover/core')>()).createDraft(...args);
  },
  rewriteDrafts: async (...args: Parameters<typeof import('@handover/core')['rewriteDrafts']>) => {
    const hook = boundary.beforeRewrite;
    boundary.beforeRewrite = undefined;
    if (hook) await hook();
    return (await original<typeof import('@handover/core')>()).rewriteDrafts(...args);
  },
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

let commits: Record<string, { sha: string; parent: string; paths: string[]; message: string }>;
// A null takes the file away, as a commit's delete does.
function push(files: Record<string, string | null>) {
  const parent = head;
  head = String(Object.keys(trees).length).padStart(40, '0');
  const tree = { ...trees[parent] };
  for (const [at, contents] of Object.entries(files))
    if (contents === null) delete tree[at];
    else tree[at] = contents;
  trees[head] = tree;
  commits[head] = { sha: head, parent, paths: Object.keys(files), message: '' };
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
  commits = {};
  writes = [];
  boundary.beforeCreate = undefined;
  boundary.beforeRewrite = undefined;
  boundary.translate.mockClear();
  boundary.repo = {
    getHead: async () => head,
    getFile: async (at: string, sha = head) => {
      const contents = trees[sha]?.[at];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    getCommit: async (sha: string) => commits[sha],
    getBlob: async (sha: string) => {
      for (const tree of Object.values(trees))
        for (const contents of Object.values(tree))
          if ((await blobSha(contents)) === sha) return contents;
      return undefined;
    },
    fileCommits: async () => [],
    contentFiles: async (sha = head) =>
      Object.entries(trees[sha] ?? {}).map(([p, contents]) => ({ path: p, contents })),
    publish: async (files: PublishFile[], opts: { base_sha: string }) => {
      expect(head).toBe(opts.base_sha);
      writes.push(files);
      return { commit_sha: push(Object.fromEntries(files.map((f) => [f.path, f.contents]))) };
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
  const handler =
    method === 'GET' ? GET : method === 'PUT' ? PUT : method === 'DELETE' ? DELETE : POST;
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

test('an entry published since its last edit has no unpublished changes', async () => {
  trees[head] = { [path('en')]: EN, [path('de')]: DE };
  const opened = (await (await call('GET', 'entries/pages/home')).json()) as {
    revisions: Record<string, string>;
  };
  const saved = await call('PUT', 'drafts/pages/home/de', {
    data: { title: 'Neue Startseite', body: 'Willkommen' },
    revision: opened.revisions.de,
  });
  expect(saved.status).toBe(200);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  // The publish leaves the row behind, matching the file it wrote: nothing is pending any more.
  expect((await loadDraft('default', db, path('de')))?.contents).toBeTruthy();
  expect(await pendingDrafts('default', db)).toEqual([]);

  const found = await listing();
  expect(found.entries).toMatchObject([{ key: 'pages/home', drafts: false }]);
});

test('the file that becomes the source is written without a mark of its own', async () => {
  // A legacy English file recording that it was translated from German, on an English-source entry.
  trees[head] = { [path('en')]: await marked(EN, 'de', DE), [path('de')]: DE };

  const found = await listing();
  expect(await (await record(found.base)).json()).toMatchObject({ entries: 1 });

  expect(markOf(trees[head]?.[path('en')])).toBeUndefined();
  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({ _source: 'en' });
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
    translations: Record<string, unknown>;
    stale: string[];
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
  expect(trees[head]?.[path('en')]).toBeUndefined();
  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({
    _source: 'de',
    _locales: ['de', 'fr'],
    title: 'Startseite',
  });
  expect(await drafted('de')).toMatchObject({ _source: 'de', title: 'Neue Startseite' });
});

test('turning off the language the entry is written in is refused before anything is written', async () => {
  const de = '_version: 1\n_source: de\ntitle: "Startseite"\nbody: "Willkommen"\n';
  const en = '_version: 1\n_source: de\ntitle: "Home"\nbody: "Welcome"\n';
  trees[head] = { [path('de')]: de, [path('en')]: en };
  await db.insert(tables.drafts).values({
    path: path('de'),
    revision: 'r1',
    contents: de.replace('Startseite', 'Neue Startseite'),
    baseSha: head,
    baseBlob: await blobSha(de),
    updatedAt: Date.now(),
  });
  const before = head;

  const res = await call('POST', 'entries/pages/home/locales', { locales: ['en', 'fr'] });

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'ENTRY_LOCALE_IS_SOURCE', locale: 'de' });
  expect(head).toBe(before);
  expect(await loadDraft('default', db, path('de'))).toMatchObject({
    revision: 'r1',
    contents: de.replace('Startseite', 'Neue Startseite'),
  });
  expect(await loadDraft('default', db, path('en'))).toBeUndefined();
});

test('a new entry on a site with several languages records the language it starts in', async () => {
  const res = await call('POST', 'entries/pages', { title: 'About' });

  expect(await res.json()).toEqual({ slug: 'about' });
  expect((await loadDraft('default', db, path('en', 'about')))?.contents).toBe(
    '_version: 1\n_source: "en"\ntitle: "About"\n',
  );
});

test('an entry created in German opens in German before anything is published', async () => {
  const res = await call('POST', 'entries/pages', { title: 'Impressum', locale: 'de' });

  expect(await res.json()).toEqual({ slug: 'impressum' });
  expect((await loadDraft('default', db, path('de', 'impressum')))?.contents).toBe(
    '_version: 1\n_source: "de"\ntitle: "Impressum"\n',
  );
  const entry = (await (await call('GET', 'entries/pages/impressum')).json()) as {
    sourceLocale: string;
  };
  expect(entry.sourceLocale).toBe('de');
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

// Marks made by the real markTranslation, so the hash is one the CMS would have written.
const FR = '_version: 1\n_source: en\ntitle: "Accueil"\nbody: "Bienvenue"\n';
const fromFrench = async () =>
  markTranslation(
    'default',
    form,
    { locale: 'fr', contents: FR, blob_sha: await blobSha(FR) },
    '_version: 1\n_source: en\ntitle: "Startseite"\nbody: "Willkommen"\n',
    undefined,
  );

test('a translation made from a language that is turned off keeps its mark and still reads stale', async () => {
  trees[head] = {
    [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\nbody: "Welcome"\n',
    [path('fr')]: FR,
    [path('de')]: await fromFrench(),
  };

  expect((await call('POST', 'entries/pages/home/locales', { locales: ['en', 'de'] })).status).toBe(
    200,
  );

  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).toMatchObject({
    _i18n: { sourceLocale: 'fr' },
  });
  const entry = (await (await call('GET', 'entries/pages/home')).json()) as { stale: string[] };
  expect(entry.stale).toEqual(['de']);
});

test('the translated-from view says a mark names a language that is not the source', async () => {
  trees[head] = {
    [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\nbody: "Welcome"\n',
    [path('fr')]: FR,
    [path('de')]: await fromFrench(),
  };

  const res = await call('GET', 'source/pages/home/de');

  expect(await res.json()).toEqual({ from: 'fr', otherSource: true, changed: {} });
});

test('restoring an old version keeps the language the entry is written in now', async () => {
  const old = push({ [path('en')]: EN, [path('de')]: DE.replace('Startseite', 'Alte Startseite') });
  push({
    [path('en')]: '_version: 1\n_source: de\ntitle: "Home"\nbody: "Welcome"\n',
    [path('de')]: '_version: 1\n_source: de\ntitle: "Startseite"\nbody: "Willkommen"\n',
  });

  const res = await call('POST', 'history/pages/home/restore', { commit_sha: old });

  expect(res.status).toBe(200);
  expect((await loadDraft('default', db, path('de')))?.contents).toBe(
    '_version: 1\n_source: "de"\ntitle: "Alte Startseite"\nbody: "Willkommen"\n',
  );
  expect((await opened()).sourceLocale).toBe('de');
});

test('undoing a turn-off puts back the source the reverted commit had', async () => {
  // Unrecorded: the turn-off freezes English into the files it keeps, and the undo takes it out again.
  trees[head] = {
    [path('en')]: EN,
    [path('de')]: DE,
    [path('fr')]: FR.replace('_source: en\n', ''),
  };
  await db.insert(tables.drafts).values({
    path: path('de'),
    revision: 'r1',
    contents: DE.replace('Startseite', 'Neue Startseite'),
    baseSha: head,
    baseBlob: await blobSha(DE),
    updatedAt: Date.now(),
  });
  expect((await call('POST', 'entries/pages/home/locales', { locales: ['en', 'de'] })).status).toBe(
    200,
  );
  expect(await drafted('de')).toMatchObject({ _source: 'en' });

  const res = await call('POST', 'restore', { commit_sha: head });

  expect(res.status).toBe(200);
  expect((await loadDraft('default', db, path('de')))?.contents).toBe(
    '_version: 1\ntitle: "Neue Startseite"\nbody: "Willkommen"\n',
  );
});

const RECORDED_DE = () => ({
  [path('en')]: '_version: 1\n_source: de\ntitle: "Home"\nbody: "Welcome"\n',
  [path('de')]: '_version: 1\n_source: de\ntitle: "Startseite"\nbody: "Willkommen"\n',
});

test('a duplicate keeps the language the entry is written in', async () => {
  trees[head] = RECORDED_DE();

  expect((await call('POST', 'entries/pages/home/duplicate', { to: 'copy' })).status).toBe(200);

  expect(await drafted('en', 'copy')).toMatchObject({ _source: 'de' });
  expect(await drafted('de', 'copy')).toMatchObject({ _source: 'de' });
  expect((await opened('copy')).sourceLocale).toBe('de');
});

test('a rename keeps the language the entry is written in', async () => {
  trees[head] = RECORDED_DE();

  expect((await call('POST', 'entries/pages/home/rename', { to: 'start' })).status).toBe(200);

  expect(parseEntry('default', trees[head]?.[path('en', 'start')] ?? '')).toMatchObject({
    _source: 'de',
  });
  expect((await opened('start')).sourceLocale).toBe('de');
});

test('an entry made from a template records its own language, not the one the template names', async () => {
  trees[head] = {
    'src/content/_templates/pages/landing.yaml': '_version: 1\n_source: de\nbody: "Text"\n',
  };

  const res = await call('POST', 'entries/pages', { title: 'About', template: 'landing' });

  expect(await res.json()).toEqual({ slug: 'about' });
  expect((await loadDraft('default', db, path('en', 'about')))?.contents).toBe(
    '_version: 1\n_source: "en"\nbody: "Text"\ntitle: "About"\n',
  );
});

test('saving an entry as a template leaves the language it is written in behind', async () => {
  trees[head] = {
    [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\nbody: "Welcome"\n',
    [path('de')]: '_version: 1\n_source: en\ntitle: "Startseite"\nbody: "Willkommen"\n',
  };

  expect((await call('POST', 'entries/pages/home/template', { to: 'landing' })).status).toBe(200);

  expect(trees[head]?.['src/content/_templates/pages/landing.yaml']).toBe(
    '_version: 1\ntitle: "Home"\nbody: "Welcome"\n',
  );
});

test('saving a German-written entry as a template copies the German file', async () => {
  trees[head] = RECORDED_DE();

  expect((await call('POST', 'entries/pages/home/template', { to: 'landing' })).status).toBe(200);

  expect(trees[head]?.['src/content/_templates/pages/landing.yaml']).toBe(
    '_version: 1\ntitle: "Startseite"\nbody: "Willkommen"\n',
  );
});

const unresolved = {
  conflict: {
    files: {
      en: '_version: 1\n_source: en\ntitle: "Home"\n',
      de: '_version: 1\n_source: de\ntitle: "Startseite"\n',
    },
    code: 'ENTRY_SOURCE_CONFLICT',
    marks: { en: 'en', de: 'de' },
  },
  undeclared: {
    files: {
      en: '_version: 1\n_source: pt\ntitle: "Home"\n',
      de: '_version: 1\n_source: pt\ntitle: "Startseite"\n',
    },
    code: 'ENTRY_SOURCE_UNDECLARED',
    marks: { en: 'pt', de: 'pt' },
  },
  missing: {
    files: {
      en: '_version: 1\n_source: fr\ntitle: "Home"\n',
      de: '_version: 1\n_source: fr\ntitle: "Startseite"\n',
    },
    code: 'ENTRY_SOURCE_MISSING',
    marks: { en: 'fr', de: 'fr' },
  },
} as const;
const committed = (files: Record<string, string>, collection = 'pages') =>
  Object.fromEntries(
    Object.entries(files).map(([locale, contents]) => [
      `src/content/${collection}/${locale}/home.yaml`,
      contents,
    ]),
  );

test.each(Object.entries(unresolved))(
  'opening an entry whose source is %s answers what each file says',
  async (_, { files, code, marks }) => {
    trees[head] = committed(files);

    const res = await call('GET', 'entries/pages/home');

    expect(res.status).toBe(409);
    expect(res.headers.get('x-handover-error-code')).toBe(code);
    expect(await res.json()).toMatchObject({
      code,
      marks,
      files: ['en', 'de'],
      offered: ['en', 'de', 'fr'],
    });
  },
);

test.each([
  ['a save', 'PUT', 'drafts/pages/home/en', { data: { title: 'Home!' }, revision: 'r' }],
  ['creating a translation', 'POST', 'drafts/pages/home/fr', undefined],
  ['machine translation', 'POST', 'translate/pages/home/de', {}],
  ['turning a language off', 'POST', 'entries/pages/home/locales', { locales: ['en', 'fr'] }],
  ['an address change', 'POST', 'entries/posts/home/address/de', { address: 'start' }],
  ['a hold', 'POST', 'hold/pages/home', { hold: true }],
  ['hiding', 'POST', 'status/pages', { entries: ['home'], hidden: true }],
  ['a drift answer', 'POST', 'drift/pages/home', { choices: [{ path: 'title', locales: ['en'] }] }],
  ['a rename', 'POST', 'entries/pages/home/rename', { to: 'start' }],
  ['a duplicate', 'POST', 'entries/pages/home/duplicate', { to: 'copy', drafts: true }],
] as const)(
  '%s on an entry whose files disagree is refused and writes nothing',
  async (_, method, route, body) => {
    const { files } = unresolved.conflict;
    trees[head] = { ...committed(files), ...committed(files, 'posts') };
    const before = head;

    const res = await call(method, route, body);

    expect(res.status).toBe(409);
    expect(res.headers.get('x-handover-error-code')).toBe('ENTRY_SOURCE_CONFLICT');
    expect(await res.json()).toMatchObject({ code: 'ENTRY_SOURCE_CONFLICT', files: ['en', 'de'] });
    expect(head).toBe(before);
    expect(await db.select().from(tables.drafts)).toEqual([]);
    expect(boundary.translate).not.toHaveBeenCalled();
  },
);

test('the drawer’s checks report an entry whose files disagree as an error', async () => {
  trees[head] = { [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\n' };
  await db.insert(tables.drafts).values({
    path: path('de'),
    revision: 'r1',
    contents: '_version: 1\n_source: de\ntitle: "Startseite"\n',
    baseSha: head,
    baseBlob: '',
    updatedAt: Date.now(),
  });

  const res = await call('POST', 'publish/checks', { entries: ['pages/home'] });

  const { results } = (await res.json()) as {
    results: { check: string; severity: string; entry: string }[];
  };
  expect(results.filter((r) => r.check === 'source-unresolved')).toMatchObject([
    { severity: 'error', entry: 'pages/home' },
  ]);
});

test('publishing an entry whose files disagree is refused and commits nothing', async () => {
  trees[head] = { [path('en')]: '_version: 1\n_source: en\ntitle: "Home"\n' };
  await db.insert(tables.drafts).values({
    path: path('de'),
    revision: 'r1',
    contents: '_version: 1\n_source: de\ntitle: "Startseite"\n',
    baseSha: head,
    baseBlob: '',
    updatedAt: Date.now(),
  });
  const before = head;

  const res = await call('POST', 'publish', { entries: ['pages/home'] });

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: 'PUBLISH_SOURCE_UNRESOLVED',
    paths: [path('de')],
  });
  expect(head).toBe(before);
  expect(writes).toEqual([]);
});

test('once every file names the same language again, the entry opens', async () => {
  trees[head] = committed(unresolved.conflict.files);
  expect((await call('GET', 'entries/pages/home')).status).toBe(409);

  push({ [path('en')]: '_version: 1\n_source: de\ntitle: "Home"\n' });

  const res = await call('GET', 'entries/pages/home');
  expect(res.status).toBe(200);
  expect(((await res.json()) as { sourceLocale: string }).sourceLocale).toBe('de');
});

const EN_MARKED = '_version: 1\n_source: en\ntitle: "Home"\nbody: "Welcome"\n';
const makeSource = (locale: unknown, revisions?: Record<string, string>, collection = 'pages') =>
  call('POST', `entries/${collection}/home/source`, { locale, tab: '', revisions });
const draftRows = async () =>
  (await db.select().from(tables.drafts)).map((row) => [row.path, row.revision, row.contents]);

test('changing the source to German and publishing commits every file with German as the source', async () => {
  trees[head] = {
    [path('en')]: EN_MARKED,
    [path('de')]: await marked(DE, 'en', EN_MARKED),
    [path('fr')]: await marked(FR, 'en', EN_MARKED),
  };
  const { revisions } = await opened();

  const res = await makeSource('de', revisions);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ source: 'de' });
  expect(writes).toEqual([]);
  expect((await opened()).sourceLocale).toBe('de');
  const [logged] = await db.select().from(tables.activity);
  expect(logged).toMatchObject({
    kind: 'entry-source',
    subject: path('de'),
    detail: { from: 'en', to: 'de' },
  });

  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  expect(writes.map((files) => files.map((f) => f.path).sort())).toEqual([
    [path('de'), path('en'), path('fr')],
  ]);
  const german = trees[head]?.[path('de')] ?? '';
  expect(german).toBe('_version: 1\n_source: "de"\ntitle: "Startseite"\nbody: "Willkommen"\n');
  const fromGerman = { sourceLocale: 'de', sourceBlob: await blobSha(german) };
  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).toMatchObject({
    _source: 'de',
    title: 'Home',
    _i18n: fromGerman,
  });
  expect(parseEntry('default', trees[head]?.[path('fr')] ?? '')).toMatchObject({
    _source: 'de',
    _i18n: fromGerman,
  });
  const after = (await (await call('GET', 'entries/pages/home')).json()) as {
    sourceLocale: string;
    stale: string[];
  };
  expect(after).toMatchObject({ sourceLocale: 'de', stale: [] });
});

test('a second request with the same revisions is refused once the change has been made', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  expect((await makeSource('de', revisions)).status).toBe(200);
  const rows = await draftRows();

  const replay = await makeSource('de', revisions);

  expect(replay.status).toBe(409);
  expect(replay.headers.get('x-handover-error-code')).toBe('ENTRY_SOURCE_UNCHANGED');
  expect(await draftRows()).toEqual(rows);
});

test('each refusal of a source change answers its code and writes nothing', async () => {
  const cases: [string, Record<string, string>, unknown, number, string, string?][] = [
    ['undeclared', { en: EN_MARKED, de: DE }, 'it', 400, 'ENTRY_SOURCE_TARGET_UNDECLARED'],
    ['already the source', { en: EN_MARKED, de: DE }, 'en', 409, 'ENTRY_SOURCE_UNCHANGED'],
    ['no file', { en: EN_MARKED, de: DE }, 'fr', 409, 'ENTRY_SOURCE_TARGET_MISSING'],
    [
      'turned off',
      { en: `${EN_MARKED}_locales: [en, de]\n`, de: `${DE}_locales: [en, de]\n` },
      'fr',
      409,
      'ENTRY_SOURCE_TARGET_OFF',
    ],
    [
      'blocks disagree',
      {
        en: '_version: 1\ntitle: "Rooms"\nblocks:\n  - _type: hero\n    _id: k3nf9a2p\n    heading: "Hall"\n',
        de: '_version: 1\ntitle: "Zimmer"\nblocks: []\n',
      },
      'de',
      409,
      'ENTRY_SOURCE_DRIFT',
      'rooms',
    ],
    [
      'German has its own note',
      {
        en: '_version: 1\ntitle: "Rooms"\nnotes: "Keys under the mat"\nblocks: []\n',
        de: '_version: 1\ntitle: "Zimmer"\nnotes: "Schlüssel beim Nachbarn"\nblocks: []\n',
      },
      'de',
      409,
      'ENTRY_SOURCE_ONLY_CONFLICT',
      'rooms',
    ],
    [
      'German has no title',
      { en: EN_MARKED, de: '_version: 1\ntitle: ""\n' },
      'de',
      422,
      'ENTRY_SOURCE_TARGET_INVALID',
    ],
  ];
  for (const [why, files, locale, status, code, collection = 'pages'] of cases) {
    await db.delete(tables.drafts);
    trees[head] = committed(files, collection);
    const { revisions } = (await (await call('GET', `entries/${collection}/home`)).json()) as {
      revisions: Record<string, string>;
    };
    const rows = await draftRows();

    const res = await makeSource(locale, revisions, collection);

    expect([why, res.status, res.headers.get('x-handover-error-code')]).toEqual([
      why,
      status,
      code,
    ]);
    expect(await draftRows()).toEqual(rows);
  }
});

test('the refusals name what is in the way', async () => {
  trees[head] = committed(
    {
      en: '_version: 1\ntitle: "Rooms"\nnotes: "Keys under the mat"\nblocks: []\n',
      de: '_version: 1\ntitle: ""\nnotes: "Schlüssel beim Nachbarn"\nblocks: []\n',
    },
    'rooms',
  );
  const { revisions } = (await (await call('GET', 'entries/rooms/home')).json()) as {
    revisions: Record<string, string>;
  };
  expect(await (await makeSource('de', revisions, 'rooms')).json()).toMatchObject({
    code: 'ENTRY_SOURCE_ONLY_CONFLICT',
    paths: ['notes'],
  });

  trees[head] = committed({ en: EN_MARKED, de: '_version: 1\ntitle: ""\n' });
  await db.delete(tables.drafts);
  const opening = await opened();
  expect(await (await makeSource('de', opening.revisions)).json()).toMatchObject({
    code: 'ENTRY_SOURCE_TARGET_INVALID',
    problems: [{ path: 'title' }],
  });
});

test('a German save after the entry was opened refuses the change and writes nothing', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  await call('PUT', 'drafts/pages/home/de', {
    data: { title: 'Neue Startseite', body: 'Willkommen' },
    revision: revisions.de,
  });
  const rows = await draftRows();

  const res = await makeSource('de', revisions);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'ENTRY_SOURCE_REVISION' });
  expect(await draftRows()).toEqual(rows);
});

test("another member's lock refuses a source change", async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  expect((await call('POST', 'locks/pages/home', { tab: 'erika' }, editor)).status).toBe(200);
  const rows = await draftRows();

  const res = await makeSource('de', revisions);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ held_by: { id: 'editor' } });
  expect(await draftRows()).toEqual(rows);
});

test.each([
  ['files that disagree', 'conflict', 'de'],
  ['files that name a language with no file', 'missing', 'en'],
] as const)('an entry with %s opens again once a source is chosen', async (_, problem, to) => {
  trees[head] = committed(unresolved[problem].files);
  expect((await call('GET', 'entries/pages/home')).status).toBe(409);

  const res = await makeSource(to);

  expect(res.status).toBe(200);
  const entry = await opened();
  expect(entry.sourceLocale).toBe(to);
  expect(await drafted('en')).toMatchObject({ _source: to });
  expect(await drafted('de')).toMatchObject({ _source: to });
});

test('after a change to German, a new French is made and pre-filled from German', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  expect((await makeSource('de', revisions)).status).toBe(200);

  expect((await call('POST', 'drafts/pages/home/fr')).status).toBe(200);
  expect((await call('POST', 'translate/pages/home/fr', {})).status).toBe(200);

  expect(boundary.translate.mock.calls.map(([, from, to]) => [from, to])).toEqual([['de', 'fr']]);
  expect(await drafted('fr')).toMatchObject({ _source: 'de', title: '[fr] Startseite' });
  expect((await opened()).sourceLocale).toBe('de');
});

test('discarding the entry after a source change puts every file back', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  expect((await makeSource('de', revisions)).status).toBe(200);

  expect((await call('DELETE', 'drafts/pages/home')).status).toBe(200);

  const entry = await opened();
  expect(entry.sourceLocale).toBe('en');
  expect(entry.pending).toEqual([]);
});

test('a translation created after a source change was captured makes the source change retry', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  boundary.beforeRewrite = async () => {
    expect((await call('POST', 'drafts/pages/home/fr')).status).toBe(200);
  };

  const changed = await makeSource('de', revisions);

  expect(changed.status).toBe(409);
  expect(changed.headers.get('x-handover-error-code')).toBe('ENTRY_SOURCE_REVISION');
  const entry = await opened();
  expect(entry.sourceLocale).toBe('en');
  expect(await drafted('fr')).toMatchObject({ _source: 'en' });
});

test('a source change completed after translation creation was captured makes creation retry', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: DE };
  const { revisions } = await opened();
  boundary.beforeCreate = async () => {
    expect((await makeSource('de', revisions)).status).toBe(200);
  };

  const created = await call('POST', 'drafts/pages/home/fr');

  expect(created.status).toBe(409);
  const entry = await opened();
  expect(entry.sourceLocale).toBe('de');
  expect(entry.translations).not.toHaveProperty('fr');
});

test('recovery source changes remain consistent when translation creation overlaps', async () => {
  trees[head] = {
    [path('en')]: `${EN_MARKED.replace('_source: en', '_source: de')}`,
    [path('de')]: `${DE}_source: en\n`,
  };
  boundary.beforeRewrite = async () => {
    expect((await call('POST', 'drafts/pages/home/fr')).status).toBe(409);
  };

  expect((await makeSource('de')).status).toBe(200);
  const entry = await opened();
  expect(entry.sourceLocale).toBe('de');
  expect(entry.translations).not.toHaveProperty('fr');
});

test('publishing a stale language promoted to source preserves deliberately absent provenance', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: await marked(DE, 'en', EN_MARKED) };
  const { revisions } = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home', body: 'New facts not translated into German' },
        revision: revisions.en,
      })
    ).status,
  ).toBe(200);
  const before = await opened();
  expect(before.stale).toContain('de');
  expect((await makeSource('de', before.revisions)).status).toBe(200);
  expect(await drafted('en')).not.toHaveProperty('_i18n');

  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);

  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).not.toHaveProperty('_i18n');
});

test('a no-op save after stale source promotion keeps the old source deliberately unmarked', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: await marked(DE, 'en', EN_MARKED) };
  const openedFirst = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home', body: 'Changed English' },
        revision: openedFirst.revisions.en,
      })
    ).status,
  ).toBe(200);
  expect((await makeSource('de', (await opened()).revisions)).status).toBe(200);
  const promoted = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home', body: 'Changed English' },
        revision: promoted.revisions.en,
      })
    ).status,
  ).toBe(200);

  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).not.toHaveProperty('_i18n');
});

test('a genuine translation edit after stale source promotion receives fresh provenance', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: await marked(DE, 'en', EN_MARKED) };
  const openedFirst = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home', body: 'Changed English' },
        revision: openedFirst.revisions.en,
      })
    ).status,
  ).toBe(200);
  expect((await makeSource('de', (await opened()).revisions)).status).toBe(200);
  const promoted = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home translated anew', body: 'Fresh English translation' },
        revision: promoted.revisions.en,
      })
    ).status,
  ).toBe(200);

  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  const german = trees[head]?.[path('de')] ?? '';
  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).toMatchObject({
    _i18n: {
      sourceLocale: 'de',
      sourceBlob: await blobSha(german),
      sourceHash: expect.any(String),
      translatedAt: expect.any(String),
    },
  });
});

test('an unpublished legacy source change preserves absent provenance on first publication', async () => {
  await createDraft(
    'default',
    db,
    boundary.repo as never,
    path('en'),
    parseEntry('default', EN) as Record<string, unknown>,
  );
  await createDraft(
    'default',
    db,
    boundary.repo as never,
    path('de'),
    parseEntry('default', DE) as Record<string, unknown>,
  );
  const before = await opened();
  expect(before.sourceLocale).toBe('en');

  expect((await makeSource('de', before.revisions)).status).toBe(200);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);

  expect(parseEntry('default', trees[head]?.[path('en')] ?? '')).not.toHaveProperty('_i18n');
});

test('changing a stale source back again does not manufacture provenance in either direction', async () => {
  trees[head] = { [path('en')]: EN_MARKED, [path('de')]: await marked(DE, 'en', EN_MARKED) };
  const first = await opened();
  expect(
    (
      await call('PUT', 'drafts/pages/home/en', {
        data: { title: 'Home', body: 'Changed English' },
        revision: first.revisions.en,
      })
    ).status,
  ).toBe(200);
  expect((await makeSource('de', (await opened()).revisions)).status).toBe(200);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);
  expect(await pendingDrafts('default', db)).toEqual([]);
  expect((await makeSource('en', (await opened()).revisions)).status).toBe(200);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(200);

  expect(parseEntry('default', trees[head]?.[path('de')] ?? '')).not.toHaveProperty('_i18n');
});
