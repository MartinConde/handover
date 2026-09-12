import {
  beginOperation,
  blobSha,
  claimLock,
  createDraft,
  draftFiles,
  draftSource,
  entryAt,
  loadDraft,
  logActivity,
  openDb,
  type PublishFile,
  parseEntry,
  reservePaths,
  staticSource,
} from '@handover/core';
import type { APIContext } from 'astro';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import * as tables from '../../../core/src/tables.js';
import { onRequest } from '../middleware.js';
import { DELETE, GET, POST, PUT } from './api.js';

const boundary = vi.hoisted(() => ({
  binding: undefined as unknown,
  repo: undefined as unknown,
  uses: {} as Record<string, string[]>,
}));
vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() {
      return boundary.binding;
    },
    BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
    HANDOVER_BASE_URL: 'http://localhost',
    R2_ACCOUNT_ID: 'test',
    R2_BUCKET: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    GITHUB_APP_ID: 'test',
    GITHUB_INSTALLATION_ID: 'test',
    GITHUB_PRIVATE_KEY: 'test',
    GITHUB_REPO: 'test/test',
    CLOUDFLARE_API_TOKEN: 'test',
    CLOUDFLARE_WORKER: 'test/workflows',
  },
}));
vi.mock('virtual:handover/config', async () => {
  const { z } = await import('astro/zod');
  return {
    default: {
      i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
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
  uses: boundary.uses,
}));
// Only replace the external repository boundary.
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
let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
let db: ReturnType<typeof openDb>;
let cookie: string;
const PATH = 'src/content/pages/en/home.yaml';
const INITIAL = '_version: 1\ntitle: "Home"\nbody: "Original body"\n';
let trees: Record<string, Record<string, string>>;
let commits: Record<string, { sha: string; parent: string; paths: string[]; message: string }>;
let head: string;
let pause: (() => Promise<void>) | undefined;
let onHead: (() => Promise<void>) | undefined;
let writes: PublishFile[][];
let deployed: string | undefined;
let buildState: 'building' | 'failed' | 'live';
let storageDeletes: string[];
let storagePause: (() => Promise<void>) | undefined;
function push(files: PublishFile[], message = 'Developer change') {
  const parent = head;
  head = String(Object.keys(trees).length).padStart(40, '0');
  const tree = { ...trees[parent] };
  trees[head] = tree;
  for (const f of files) {
    if (f.contents === null) delete tree[f.path];
    else tree[f.path] = f.contents;
  }
  commits[head] = { sha: head, parent, paths: files.map((f) => f.path), message };
  return head;
}
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  boundary.binding = binding;
  db = openDb('default', binding);
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
  // Invitations seed users server-side; authOptions intentionally disables public signup.
  await db
    .insert(tables.user)
    .values({
      id: 'owner',
      email: 'owner@example.com',
      name: 'Owner',
      role: 'owner',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  const { hashPassword } = await import('better-auth/crypto');
  await db.insert(tables.account).values({
    id: 'password',
    userId: 'owner',
    accountId: 'owner',
    providerId: 'credential',
    issuer: 'local:credential',
    password: await hashPassword('a-test-password'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signed = await call(
    'POST',
    'auth/sign-in/email',
    { email: 'owner@example.com', password: 'a-test-password' },
    '',
  );
  expect(signed.status).toBe(200);
  cookie = signed.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
});
beforeEach(async () => {
  boundary.binding = binding;
  await db.delete(tables.media);
  await db.delete(tables.drafts);
  await db.delete(tables.activity);
  await db.delete(tables.operations);
  await db.delete(tables.locks);
  await db.delete(tables.pathReservations);
  trees = { ['0'.repeat(40)]: { [PATH]: INITIAL } };
  commits = {};
  head = '0'.repeat(40);
  pause = undefined;
  onHead = undefined;
  writes = [];
  deployed = undefined;
  buildState = 'live';
  storageDeletes = [];
  storagePause = undefined;
  for (const path of Object.keys(boundary.uses)) delete boundary.uses[path];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: string | Request) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('r2.cloudflarestorage.com')) {
        storageDeletes.push(url);
        await storagePause?.();
        return new Response(null, { status: 204 });
      }
      if (url.includes('/workers/services/'))
        return Response.json({ result: { default_environment: { script: { tag: 'workflow' } } } });
      if (url.includes('/builds/workers/'))
        return Response.json({
          result: [
            {
              status: buildState === 'building' ? 'running' : 'stopped',
              build_outcome:
                buildState === 'live' ? 'success' : buildState === 'failed' ? 'failure' : null,
              build_trigger_metadata: { commit_hash: deployed },
              created_on: new Date().toISOString(),
              stopped_on: new Date().toISOString(),
            },
          ],
        });
      throw new Error(`Unexpected external request: ${url}`);
    }),
  );
  boundary.repo = {
    getHead: async () => {
      const paused = onHead;
      onHead = undefined;
      await paused?.();
      return head;
    },
    getFile: async (path: string, sha = head) => {
      const contents = trees[sha]?.[path];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    getCommit: async (sha: string) => commits[sha],
    contentFiles: async (sha = head) =>
      Object.entries(trees[sha] ?? {}).map(([path, contents]) => ({ path, contents })),
    compareCommits: async (base: string, tip: string) => {
      const descendsFrom = (candidate: string, ancestor: string) => {
        for (let at: string | undefined = candidate; at; at = commits[at]?.parent)
          if (at === ancestor) return true;
        return false;
      };
      if (base === tip) return 'identical';
      if (descendsFrom(tip, base)) return 'ahead';
      if (descendsFrom(base, tip)) return 'behind';
      return 'diverged';
    },
    publish: async (files: PublishFile[], opts: { base_sha: string; message: string }) => {
      await pause?.();
      expect(head).toBe(opts.base_sha);
      writes.push(files);
      return { commit_sha: push(files, opts.message) };
    },
  };
});

test('a publish whose D1 finalization fails resumes the same Git commit on retry', async () => {
  const entry = await opened();
  await save('Committed once', entry.revisions.en ?? '');
  let fail = true;
  boundary.binding = new Proxy(binding, {
    get(target, key) {
      if (key !== 'batch') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<typeof binding.batch>) => {
        if (fail) {
          fail = false;
          throw new Error('D1 finalization unavailable');
        }
        return target.batch(...args);
      };
    },
  });

  const first = await call('POST', 'publish', { entries: ['pages/home'] });

  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ reason: 'needs-finalization', commit_sha: head });
  expect(writes).toHaveLength(1);
  expect((await db.select().from(tables.operations))[0]?.state).toBe('committed');

  boundary.binding = binding;
  const retry = await call('POST', 'publish', { entries: ['pages/home'] });

  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { commit_sha: string }).commit_sha).toBe(head);
  expect(writes).toHaveLength(1);
  expect((await db.select().from(tables.operations))[0]?.state).toBe('finalized');
  expect((await loadDraft('default', db, PATH))?.publishedSha).toBe(head);
});
async function call(method: string, path: string, body?: unknown, cookies = cookie) {
  const url = new URL(`http://localhost/admin/api/${path}`);
  const request = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: url.origin,
      ...(cookies ? { cookie: cookies } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = { url, request, params: { path }, locals: {} } as unknown as APIContext;
  const route =
    method === 'GET' ? GET : method === 'PUT' ? PUT : method === 'DELETE' ? DELETE : POST;
  const response = await onRequest(ctx, () => Promise.resolve(route(ctx)));
  if (!response) throw new Error('No response');
  return response;
}
async function opened() {
  const res = await call('GET', 'entries/pages/home');
  expect(res.status).toBe(200);
  return res.json() as Promise<{ revisions: Record<string, string> }>;
}
async function save(title: string, revision: string, body = 'Original body') {
  return call('PUT', 'drafts/pages/home', { data: { title, body }, revision });
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};

test('S01 open → save → publish → cleanup → revert preserves the publish as pending', async () => {
  const entry = await opened();
  expect((await save('Edited home', entry.revisions.en ?? '')).status).toBe(200);
  const publish = await call('POST', 'publish', { entries: ['pages/home'] });
  expect(publish.status).toBe(200);
  const { commit_sha } = (await publish.json()) as { commit_sha: string };
  expect(parseEntry('default', trees[head]?.[PATH] ?? '')).toMatchObject({ title: 'Edited home' });
  deployed = commit_sha;
  expect((await call('GET', 'build')).status).toBe(200);
  expect(await loadDraft('default', db, PATH)).toBeUndefined();
  const reverted = await call('POST', 'revert', { commit_sha });
  expect(reverted.status).toBe(200);
  expect(trees[head]?.[PATH]).toBe(INITIAL);
  expect(
    parseEntry('default', (await loadDraft('default', db, PATH))?.contents ?? ''),
  ).toMatchObject({
    title: 'Edited home',
  });
  expect((await loadDraft('default', db, PATH))?.publishedSha).toBeNull();
});

test('S01 a save during publication keeps newer bytes pending and commits the validated bytes', async () => {
  const entry = await opened();
  const saved = (await (await save('Publishing this', entry.revisions.en ?? '')).json()) as {
    revision: string;
  };
  const entered = gate(),
    finish = gate();
  pause = async () => {
    entered.release();
    await finish.promise;
  };
  const publishing = call('POST', 'publish', { entries: ['pages/home'] });
  await entered.promise;
  // Invalid for publishing, valid for autosave: this must never replace the validated snapshot.
  expect((await save('', saved.revision)).status).toBe(200);
  finish.release();
  expect((await publishing).status).toBe(200);
  expect(parseEntry('default', trees[head]?.[PATH] ?? '')).toMatchObject({
    title: 'Publishing this',
  });
  const row = await loadDraft('default', db, PATH);
  if (!row) throw new Error('The newer draft disappeared');
  expect(parseEntry('default', row.contents)).toMatchObject({ title: '' });
  expect(row.publishedSha).toBeNull();
  expect(row.baseSha).toBe(head);
  expect(row.baseBlob).toBe(await blobSha(trees[head]?.[PATH] ?? ''));
});

test('S01 repository edits after GET remain a conflict on the first save and publish', async () => {
  const entry = await opened();
  push([{ path: PATH, contents: INITIAL.replace('Original body', 'Developer body') }]);
  expect((await save('My title', entry.revisions.en ?? '')).status).toBe(200);
  expect((await call('POST', 'publish', { entries: ['pages/home'] })).status).toBe(409);
  expect(writes).toHaveLength(0);
  expect(trees[head]?.[PATH]).toContain('Developer body');
});

test('stale client revisions are refused without replacing the winning save', async () => {
  const entry = await opened();
  const responses = await Promise.all([
    save('One', entry.revisions.en ?? ''),
    save('Two', entry.revisions.en ?? ''),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await save('Stale retry', entry.revisions.en ?? '')).status).toBe(409);
  expect((await loadDraft('default', db, PATH))?.contents).not.toContain('Stale retry');
});

test('autosave refuses unreadable nested metadata without changing the opened draft', async () => {
  const entry = await opened();
  const before = await loadDraft('default', db, PATH);

  const response = await call('PUT', 'drafts/pages/home', {
    data: { title: 'Home', opaque: { rows: [{ _id: 'bad' }] } },
    revision: entry.revisions.en,
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toBe(
    'opaque.rows[0]._id: expected eight characters from 0-9a-z, got "bad"',
  );
  expect(await loadDraft('default', db, PATH)).toEqual(before);
});

test('autosave refuses duplicate row identities without changing the opened draft', async () => {
  const entry = await opened();
  const before = await loadDraft('default', db, PATH);

  const response = await call('PUT', 'drafts/pages/home', {
    data: {
      title: '',
      opaque: [
        { _id: 'same0001', text: 'One' },
        { _id: 'same0001', text: 'Two' },
      ],
    },
    revision: entry.revisions.en,
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain(
    'opaque[1]._id: duplicate row identity "same0001"; already used at opaque[0]._id',
  );
  expect(await loadDraft('default', db, PATH)).toEqual(before);
});

test('S01 direct admin HTTP cannot bypass guarded member mutations', async () => {
  expect(
    (await call('POST', 'auth/admin/set-role', { userId: 'owner', role: 'editor' })).status,
  ).toBe(404);
  expect((await call('POST', 'members/owner/role', { role: 'editor' })).status).toBe(400);
  await db
    .insert(tables.user)
    .values({
      id: 'member',
      email: 'member@example.com',
      name: 'Member',
      role: 'editor',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  expect((await call('POST', 'members/member/role', { role: 'owner' })).status).toBe(200);
  await claimLock('default', db, 'pages/home', 'member', 'tab');
  expect((await call('DELETE', 'members/member')).status).toBe(200);
  expect(await db.select().from(tables.locks)).toEqual([]);
  expect((await db.select().from(tables.activity)).map((e) => e.kind)).toEqual(
    expect.arrayContaining(['role-change', 'member-removed']),
  );
  expect((await db.select().from(tables.user)).find((u) => u.id === 'owner')?.role).toBe('owner');
});

test('developer commits and mixed-scope commits are refused before a repository write', async () => {
  const sha = push([{ path: 'src/middleware.ts', contents: 'code' }]);
  for (const endpoint of ['revert', 'restore'])
    expect((await call('POST', endpoint, { commit_sha: sha })).status).toBe(403);
  await logActivity('default', db, {
    kind: 'publish',
    commitSha: sha,
    detail: { entries: ['pages/home'] },
  });
  expect((await call('POST', 'revert', { commit_sha: sha })).status).toBe(403);
  expect(writes).toHaveLength(0);
});

test('concurrent normalized entry names cannot replace one another', async () => {
  const made = await Promise.all([
    call('POST', 'entries/pages', { title: 'New page!' }),
    call('POST', 'entries/pages', { title: 'New page' }),
  ]);
  const statuses = made.map((r) => r.status).sort();
  expect(statuses[0]).toBe(200);
  expect([200, 409]).toContain(statuses[1]);
  const rows = (await db.select().from(tables.drafts)).filter((r) => r.path !== PATH);
  expect(rows).toHaveLength(statuses.filter((s) => s === 200).length);
});

test('rename refuses a destination added since the built index', async () => {
  push([{ path: 'src/content/pages/en/taken.yaml', contents: 'title: "Developer page"\n' }]);
  const res = await call('POST', 'entries/pages/home/rename', { to: 'taken' });
  expect(res.status).toBe(409);
  expect(writes).toHaveLength(0);
  expect(trees[head]?.['src/content/pages/en/taken.yaml']).toContain('Developer page');
  expect(await db.select().from(tables.pathReservations)).toEqual([]);
});

test('a rename resumes an operation-owned destination claim after the request is terminated', async () => {
  const destination = ['en', 'de'].map((locale) => `src/content/pages/${locale}/moved.yaml`);
  const operation = await beginOperation('default', db, {
    retryKey: 'entry-rename:pages/home:moved',
    kind: 'entry-rename',
    paths: [PATH, 'src/content/pages/de/home.yaml', ...destination, 'src/content/redirects.yaml'],
    baseSha: head,
    subject: destination[0],
    detail: { from: 'home' },
  });
  const claim = await reservePaths('default', db, destination, operation.id);

  const resumed = await call('POST', 'entries/pages/home/rename', { to: 'moved' });

  expect(resumed.status).toBe(200);
  expect(writes).toHaveLength(1);
  expect((await db.select().from(tables.operations))[0]?.state).toBe('finalized');
  expect(await db.select().from(tables.pathReservations)).toEqual([]);
  expect(claim.operationId).toBe(operation.id);
  expect(trees[head]?.[destination[0] ?? '']).toContain('Home');
});

test('rename moves a draft-only translation and preserves its unpublished state', async () => {
  const from = 'src/content/pages/de/home.yaml';
  const to = 'src/content/pages/de/moved.yaml';
  await createDraft('default', db, boundary.repo as never, from, {
    _version: 1,
    _i18n: { sourceLocale: 'en' },
    title: 'Startseite',
  });
  const heldAt = Date.now() - 1000;
  await db
    .update(tables.drafts)
    .set({ heldBy: 'owner', heldAt })
    .where(eq(tables.drafts.path, from));

  const res = await call('POST', 'entries/pages/home/rename', { to: 'moved' });

  expect(res.status).toBe(200);
  expect(await loadDraft('default', db, from)).toBeUndefined();
  const moved = await loadDraft('default', db, to);
  expect(parseEntry('default', moved?.contents ?? '')).toMatchObject({
    _i18n: { sourceLocale: 'en' },
    title: 'Startseite',
  });
  expect(moved).toMatchObject({
    baseSha: head,
    baseBlob: '',
    publishedSha: null,
    heldBy: 'owner',
    heldAt,
  });
  expect(trees[head]?.[from]).toBeUndefined();
  expect(trees[head]?.[to]).toBeUndefined();
});

test('an unrelated successful build cannot clean overlays for an unbuilt commit', async () => {
  const entry = await opened();
  await save('Undeployed', entry.revisions.en ?? '');
  await call('POST', 'publish', { entries: ['pages/home'] });
  await db.update(tables.activity).set({ at: Date.now() - 700000 });
  await db.update(tables.operations).set({ committedAt: Date.now() - 700000 });
  deployed = 'f'.repeat(40);
  const build = (await (await call('GET', 'build')).json()) as {
    state: string;
    commit_sha?: string;
  };
  expect(build.state).toBe('live');
  expect(build.commit_sha).toBeUndefined();
  expect(await loadDraft('default', db, PATH)).toBeDefined();
});

test('a later redirect deployment cleans an earlier published content overlay', async () => {
  const entry = await opened();
  await save('Published before redirect', entry.revisions.en ?? '');
  const published = (await (await call('POST', 'publish', { entries: ['pages/home'] })).json()) as {
    commit_sha: string;
  };
  const redirected = await call('POST', 'redirects', {
    from: '/summer-offer',
    to: '/',
    status: 302,
  });
  expect(redirected.status).toBe(200);
  expect(head).not.toBe(published.commit_sha);

  deployed = head;
  expect((await call('GET', 'build')).status).toBe(200);
  expect(await loadDraft('default', db, PATH)).toBeUndefined();
});

test('restore accepts a recorded deletion and refuses an ordinary publish', async () => {
  const entry = await opened();
  await save('Edited', entry.revisions.en ?? '');
  const published = (await (await call('POST', 'publish', { entries: ['pages/home'] })).json()) as {
    commit_sha: string;
  };
  expect((await call('POST', 'restore', published)).status).toBe(403);
  const deleted = (await (
    await call('DELETE', 'entries/pages/home', { redirect: { kind: 'none' } })
  ).json()) as { commit_sha: string };
  expect(trees[head]?.[PATH]).toBeUndefined();
  expect((await call('POST', 'restore', deleted)).status).toBe(200);
  expect(trees[head]?.[PATH]).toContain('Edited');
});

test('an empty repository file opens with a usable revision and can be saved', async () => {
  push([{ path: PATH, contents: '' }]);
  const entry = await opened();
  expect(entry.revisions.en).toBeTruthy();
  expect((await save('First words', entry.revisions.en ?? '')).status).toBe(200);
});

test('a write between route validation and publication cannot replace the validated snapshot', async () => {
  const entry = await opened();
  const saved = (await (await save('Validated', entry.revisions.en ?? '')).json()) as {
    revision: string;
  };
  const entered = gate(),
    finish = gate();
  // The first HEAD read is the drift check, after schema validation and before publishDrafts.
  onHead = async () => {
    entered.release();
    await finish.promise;
  };
  const publishing = call('POST', 'publish', { entries: ['pages/home'] });
  await entered.promise;
  expect((await save('', saved.revision)).status).toBe(200);
  finish.release();
  expect((await publishing).status).toBe(200);
  expect(parseEntry('default', trees[head]?.[PATH] ?? '')).toMatchObject({ title: 'Validated' });
  const row = await loadDraft('default', db, PATH);
  expect(parseEntry('default', row?.contents ?? '')).toMatchObject({ title: '' });
  expect(row?.publishedSha).toBeNull();
});

const PUBLIC_SITE = {
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: { pages: { route: '/[slug]' } },
};
const snapshot = (sha: string) =>
  staticSource('default', {
    getCollection: async () =>
      Object.entries(trees[sha] ?? {})
        .filter(([path]) => path.startsWith('src/content/pages/'))
        .map(([path, contents]) => ({
          id: path.slice('src/content/pages/'.length, -5),
          data: parseEntry('default', contents),
        })),
    getEntry: async (_collection, id) => {
      const contents = trees[sha]?.[`src/content/pages/${id}.yaml`];
      return contents === undefined ? undefined : { id, data: parseEntry('default', contents) };
    },
  });

test('hide remains public during pending/failed builds, disappears when live, and remains previewable', async () => {
  push([{ path: 'src/content/pages/de/home.yaml', contents: INITIAL }]);
  const oldDeployment = head;
  expect(
    (
      await call('POST', 'status/pages', {
        entries: ['home'],
        hidden: true,
        redirect: { kind: 'none' },
      })
    ).status,
  ).toBe(200);
  const preview = draftSource(
    'default',
    snapshot(oldDeployment),
    await draftFiles('default', db),
    (_collection, data) => data,
  );
  for (const locale of ['en', 'de'])
    expect(
      (await entryAt('default', preview, PUBLIC_SITE, 'pages', locale, 'home'))?.data,
    ).toMatchObject({ _status: 'hidden' });
  const published = await call('POST', 'publish', { entries: ['pages/home'] });
  expect(published.status).toBe(200);
  const { commit_sha } = (await published.json()) as { commit_sha: string };
  deployed = commit_sha;
  for (const state of ['building', 'failed', 'live'] as const) {
    buildState = state;
    expect(((await (await call('GET', 'build')).json()) as { state: string }).state).toBe(state);
    const publicSource = snapshot(state === 'live' ? commit_sha : oldDeployment);
    for (const locale of ['en', 'de']) {
      const page = await entryAt('default', publicSource, PUBLIC_SITE, 'pages', locale, 'home');
      expect(Boolean(page)).toBe(state !== 'live');
    }
  }
});

test('media stays protected until the running deployment removes its final usage', async () => {
  const id = 'a'.repeat(64);
  const key = `media/${id}.webp`;
  push([{ path: PATH, contents: `title: "Home"\nbody: "${key}"\n` }]);
  boundary.uses[PATH] = [key];
  await db.insert(tables.media).values({
    siteId: 'default',
    id,
    r2Key: key,
    filename: 'photo.webp',
    mime: 'image/webp',
    bytes: 10,
    createdAt: Date.now(),
  });
  const entry = await opened();
  expect((await save('Home', entry.revisions.en ?? '', 'Picture removed')).status).toBe(200);
  const published = await call('POST', 'publish', { entries: ['pages/home'] });
  expect(published.status).toBe(200);
  deployed = ((await published.json()) as { commit_sha: string }).commit_sha;
  for (const state of ['building', 'failed', 'live'] as const) {
    buildState = state;
    expect(((await (await call('GET', 'build')).json()) as { state: string }).state).toBe(state);
    // Even a successful build report cannot override the bundle currently serving this request.
    const refused = await call('DELETE', `media/${id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ uses: ['pages/home'] });
    expect(storageDeletes).toHaveLength(0);
  }
  // The new running bundle's scan no longer contains the picture.
  delete boundary.uses[PATH];
  expect((await call('DELETE', `media/${id}`)).status).toBe(200);
  expect(storageDeletes).toHaveLength(1);
  expect(await db.select().from(tables.media)).toEqual([
    expect.objectContaining({ id, state: 'deleted' }),
  ]);
});

test('asset deletion refuses a draft reference saved after its usage snapshot', async () => {
  const id = 'b'.repeat(64);
  const key = `media/${id}.webp`;
  await db.insert(tables.media).values({
    siteId: 'default',
    id,
    r2Key: key,
    filename: 'race.webp',
    mime: 'image/webp',
    bytes: 10,
    createdAt: Date.now(),
  });
  const entered = gate();
  const finish = gate();
  storagePause = async () => {
    entered.release();
    await finish.promise;
  };

  const deleting = call('DELETE', `media/${id}`);
  await entered.promise;
  const entry = await opened();
  const saved = await save('Home', entry.revisions.en ?? '', key);

  expect(saved.status).toBe(409);
  expect(await saved.json()).toMatchObject({ reason: 'media' });
  expect((await loadDraft('default', db, PATH))?.contents).not.toContain(key);
  finish.release();
  expect((await deleting).status).toBe(200);
});

test.each(['building', 'failed', 'live'] as const)(
  'rename undo restores collapsed redirects after a %s deployment',
  async (state) => {
    const redirects = 'src/content/redirects.yaml';
    const original = {
      _id: 'original',
      from: '/old',
      to: '/home',
      status: 301,
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    };
    push([{ path: redirects, contents: JSON.stringify({ rules: [original] }) }]);
    const renamed = await call('POST', 'entries/pages/home/rename', { to: 'moved' });
    expect(renamed.status).toBe(200);
    const { commit_sha } = (await renamed.json()) as { commit_sha: string };
    expect(trees[head]?.[PATH]).toBeUndefined();
    deployed = commit_sha;
    buildState = state;
    expect(((await (await call('GET', 'build')).json()) as { state: string }).state).toBe(state);
    expect((await call('POST', 'revert', { commit_sha })).status).toBe(200);
    expect(trees[head]?.[PATH]).toBe(INITIAL);
    expect(trees[head]?.['src/content/pages/en/moved.yaml']).toBeUndefined();
    expect(parseEntry('default', trees[head]?.[redirects] ?? '')).toMatchObject({
      rules: [original],
    });
  },
);

test.each(['building', 'failed', 'live'] as const)(
  'publish undo keeps newer pending work after a %s deployment',
  async (state) => {
    const entry = await opened();
    await save('Published text', entry.revisions.en ?? '');
    const { commit_sha } = (await (
      await call('POST', 'publish', { entries: ['pages/home'] })
    ).json()) as { commit_sha: string };
    deployed = commit_sha;
    buildState = state;
    await call('GET', 'build');
    const reopened = await opened();
    await save('Newer work', reopened.revisions.en ?? '');
    expect((await call('POST', 'revert', { commit_sha })).status).toBe(200);
    expect(trees[head]?.[PATH]).toBe(INITIAL);
    const row = await loadDraft('default', db, PATH);
    expect(parseEntry('default', row?.contents ?? '')).toMatchObject({ title: 'Newer work' });
    expect(row?.publishedSha).toBeNull();
  },
);

test('reverting invalidates an open edit revision while keeping the newer draft', async () => {
  const entry = await opened();
  await save('Published text', entry.revisions.en ?? '');
  const { commit_sha } = (await (
    await call('POST', 'publish', { entries: ['pages/home'] })
  ).json()) as { commit_sha: string };
  const reopened = await opened();
  const saved = (await (await save('Newer work', reopened.revisions.en ?? '')).json()) as {
    revision: string;
  };
  expect((await call('POST', 'revert', { commit_sha })).status).toBe(200);
  expect((await save('Stale form', saved.revision)).status).toBe(409);
  expect(
    parseEntry('default', (await loadDraft('default', db, PATH))?.contents ?? ''),
  ).toMatchObject({ title: 'Newer work' });
});

test.each(['repository', 'draft'])(
  'conflict answers must review a changed %s version',
  async (changed) => {
    const open = await opened();
    expect((await save('Ours', open.revisions.en ?? '')).status).toBe(200);
    push([{ path: PATH, contents: INITIAL.replace('Home', 'Theirs') }]);
    const report = (await (await call('GET', 'conflict/pages/home')).json()) as {
      version: string;
      questions: { path: string; locale?: string }[];
    };
    const answer = {
      version: report.version,
      answers: report.questions.map((q) => ({ path: q.path, locale: q.locale, side: 'theirs' })),
    };
    if (changed === 'repository')
      push([{ path: PATH, contents: INITIAL.replace('Home', 'Theirs again') }]);
    else {
      const row = await loadDraft('default', db, PATH);
      expect((await save('Ours again', row?.revision ?? '')).status).toBe(200);
    }
    const before = await loadDraft('default', db, PATH);
    const refused = await call('POST', 'conflict/pages/home', answer);
    expect(refused.status).toBe(409);
    expect(await loadDraft('default', db, PATH)).toEqual(before);
    const fresh = (await (await call('GET', 'conflict/pages/home')).json()) as typeof report;
    expect(fresh.questions.map((q) => q.path)).toEqual(report.questions.map((q) => q.path));
    expect(fresh.version).not.toBe(report.version);
    expect(
      (await call('POST', 'conflict/pages/home', { ...answer, version: fresh.version })).status,
    ).toBe(200);
  },
);

test('an empty explicit publish selection never widens to pending entries', async () => {
  const open = await opened();
  expect((await save('Still pending', open.revisions.en ?? '')).status).toBe(200);
  expect((await call('POST', 'publish', { entries: [] })).status).toBe(200);
  expect(writes).toEqual([]);
  expect((await loadDraft('default', db, PATH))?.contents).toContain('Still pending');
});
