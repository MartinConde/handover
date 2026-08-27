import {
  applyDrift,
  type EmailSender,
  formOf,
  type Mailer,
  type PublishFile,
  parseEntry,
  RepoUnreachableError,
  stringifyEntry,
} from '@handover/core';
import type { APIContext } from 'astro';
import { afterEach, expect, test, vi } from 'vitest';
import { formSchema, type HandoverConfig } from '../index.js';
import { DELETE, GET, POST, PUT } from './api.js';

const {
  listing,
  presenter,
  page,
  article,
  site,
  files,
  getFile,
  getHead,
  publish,
  saveDraft,
  createDraft,
  recordRename,
  recordDelete,
  recordOffer,
  discardDraft,
  overlayRows,
  heldDrafts,
  holdEntry,
  pendingDrafts,
  publishDrafts,
  readyDrafts,
  entryConflict,
  resolveConflict,
  resolveDrift,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  translate,
  commitBuild,
  clearPublished,
  revertCommit,
  findMedia,
  mediaList,
  confirmUpload,
} = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  const { blocks, defineBlock } = await import('../index.js');
  // Every file the repository holds beyond the one below, path → contents; filled per test.
  const files: Record<string, string> = {};
  return {
    files,
    // A collection with blocks in it: what two languages of one entry can disagree about.
    page: z.object({
      title: z.string(),
      // A field with the same value in every language: what Create from English carries over.
      layout: z.string().optional().meta({ i18n: 'duplicate' }),
      blocks: blocks(() => ({
        hero: defineBlock('hero', { heading: z.string() }),
        quote: defineBlock('quote', { body: z.string() }),
      })),
    }),
    listing: z.object({
      title: z.string(),
      location: z.string().optional(),
      rooms: z.number(),
      address: z.object({ street: z.string() }),
    }),
    // A collection keyed on something other than `title`.
    presenter: z.object({ name: z.string() }),
    // A collection whose languages each serve their entries at an address of their own.
    article: z.object({ title: z.string(), slug: z.string().optional() }),
    // A global: the same editor path with no collection behind it, named by its own schema.
    site: z
      .object({
        footerText: z.string(),
        phone: z.string().optional().meta({ i18n: 'duplicate' }),
      })
      .meta({ label: 'Site details', description: 'Contact details and footer text' }),
    // The GitHub boundary: one file in the repo, nothing else.
    getFile: vi.fn(async (path: string) => {
      const stored = files[path];
      if (stored !== undefined) return { contents: stored, blob_sha: `blob-${path}` };
      if (path === 'src/content/listings/en/mill-house.yaml')
        return {
          contents: 'title: The Mill House\nlocation: Bakewell\nrooms: 3\n',
          blob_sha: 'abc123',
        };
      return undefined;
    }),
    getHead: vi.fn(async () => 'head789'),
    publish: vi.fn(async (_files: unknown, opts: { base_sha: string }) => {
      if (opts.base_sha === 'stale') {
        const { RefMovedError } = await import('@handover/core');
        throw new RefMovedError('moved');
      }
      return { commit_sha: 'def456' };
    }),
    // The D1 boundary; the real ones run against a D1 in @handover/core's own tests.
    pendingDrafts: vi.fn(async () => [
      {
        path: 'src/content/listings/en/mill-house.yaml',
        contents: 'title: "The Mill House"\nrooms: 3\naddress:\n  street: "Mill Lane"\n',
        updatedAt: 1755864000000,
      },
    ]),
    // What a publish will write: `pendingDrafts` minus the entries somebody is holding back.
    // The filter itself runs against a real D1 in core's `db.test.ts`.
    readyDrafts: vi.fn(async () => [
      {
        path: 'src/content/listings/en/mill-house.yaml',
        contents: 'title: "The Mill House"\nrooms: 3\naddress:\n  street: "Mill Lane"\n',
        updatedAt: 1755864000000,
      },
    ]),
    heldDrafts: vi.fn<() => Promise<Record<string, { id: string; name: string | null }>>>(
      async () => ({}),
    ),
    holdEntry: vi.fn(async () => {}),
    publishDrafts: vi.fn<
      (...args: unknown[]) => Promise<{ commit_sha: string; paths: string[] } | undefined>
    >(async () => ({ commit_sha: 'def456', paths: ['src/content/listings/en/mill-house.yaml'] })),
    saveDraft: vi.fn<() => Promise<{ updated_at: number; pending: boolean } | undefined>>(
      async () => ({ updated_at: 1755864000000, pending: true }),
    ),
    createDraft: vi.fn<(...args: unknown[]) => Promise<{ updated_at: number }>>(async () => ({
      updated_at: 1755864000000,
    })),
    resolveDrift: vi.fn(async () => {}),
    // The three-way view is core's, proven against a real D1 there; what the route owes is
    // asking for the entry's files and holding the answers to the questions it came back with.
    entryConflict: vi.fn(async () => undefined as unknown),
    resolveConflict: vi.fn(async () => ({ paths: [] })),
    saveTranslated: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    setEntryLocales: vi.fn(async () => {}),
    setEntryStatus: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    setEntryAddress: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    // The provider behind the hook: whatever the site configured, seen from the route.
    translate: vi.fn(async (texts: string[], _from: string, to: string) =>
      texts.map((t) => `[${to}] ${t}`),
    ),
    recordRename: vi.fn(async () => {}),
    recordDelete: vi.fn(async () => {}),
    recordOffer: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {}),
    // What the entry list lays over the index: the pending drafts plus what a commit left.
    overlayRows: vi.fn(async () => [] as { path: string; contents: string }[]),
    // The Workers Builds boundary; the mapping itself runs against a faked API in core's
    // builds.test.ts.
    commitBuild: vi.fn(async (_cfg: unknown, commit: { sha: string } | undefined) => ({
      ...(commit ? { commit_sha: commit.sha } : {}),
      state: 'building' as string,
      started_at: 1755864100000,
    })),
    clearPublished: vi.fn(async () => [] as string[]),
    // The D1 and R2 boundaries; both run for real in core's own media.test.ts.
    findMedia: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | undefined>>(
      async () => undefined,
    ),
    mediaList: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => []),
    confirmUpload: vi.fn(
      async (
        _site: unknown,
        _db: unknown,
        _store: unknown,
        upload: {
          hash: string;
          bytes: number;
          mime: string;
          filename?: string;
          width?: number;
          height?: number;
        },
      ) => ({
        media: {
          id: upload.hash,
          r2Key: `media/${upload.hash}.webp`,
          filename: upload.filename ?? null,
          mime: upload.mime,
          bytes: upload.bytes,
          width: upload.width ?? null,
          height: upload.height ?? null,
        },
        created: true,
      }),
    ),
    revertCommit: vi.fn(async () => ({
      commit_sha: 'rev999',
      paths: ['src/content/listings/en/mill-house.yaml'],
    })),
  };
});

// The row GET should overlay, set per test. `rows` is the same thing keyed by path, for an
// entry whose languages are not all in the same state.
type Row = {
  contents: string;
  baseSha: string;
  baseBlob: string;
  pendingRedirects?: { from: string; to: string }[];
};
let draft: Row | undefined;
const rows: Record<string, Row> = {};
// The languages the site declares, likewise: one and several are different code paths.
let locales = ['en'];
// What the site translates with: its own hook, or nothing at all.
let translator: typeof translate | undefined = translate;
// What the site sends mail with: a function of its own, the provider it named, or nothing.
let siteMailer: HandoverConfig['mailer'];
// And the credential the Worker holds for that provider — a key, a login, or a binding.
let resendKey: string | undefined;
let smtpUser: string | undefined;
let smtpPass: string | undefined;
let emailBinding: EmailSender | undefined;
// What `worker-mailer` was asked to do, since the SMTP boundary is a socket rather than a fetch.
const smtpCalls: { options: Record<string, unknown>; email: Record<string, unknown> }[] = [];
let smtpRefusal: Error | undefined;
vi.mock('worker-mailer', () => ({
  LogLevel: { NONE: 4 },
  WorkerMailer: {
    send: async (options: Record<string, unknown>, email: Record<string, unknown>) => {
      smtpCalls.push({ options, email });
      if (smtpRefusal) throw smtpRefusal;
    },
  },
}));
// The fake mailer: every message it was asked to send, so a test can read who it went to.
const sent: { to: string; subject: string; text: string }[] = [];
const fakeMailer: Mailer = async (message) => {
  sent.push(message);
  return { id: 'fake-1' };
};
// And what the Worker holds when the site has no hook of its own.
let deeplKey: string | undefined;
// The settings table as the routes meet it: what is stored, and the secret it is stored under.
// The encryption itself runs for real against a real D1 in core's own settings.test.ts.
let settingsSecret: string | undefined = 'c2VjcmV0';
const stored: Record<
  string,
  { value: string; hint: string; updatedAt: number; updatedBy: string | null }
> = {};
// What the log says the last commit was, and what the Worker can ask Cloudflare with.
let lastCommitRow: { sha: string; at: number; kind: string } | undefined = {
  sha: 'def456',
  at: 1755864000000,
  kind: 'publish',
};
// Whether the site has been told where its bucket is: all four values, or none of them.
let bucketed = true;
// The R2 and D1 boundaries as the checks meet them: both run for real in core's own tests.
let storeRefusal: Error | undefined;
let dbRefusal: Error | undefined;
let cloudflareToken: string | undefined = 'cf-token';
let cloudflareWorker: string | undefined = 'acct/handover-demo';
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: {
      get locales() {
        return locales;
      },
      defaultLocale: 'en',
      get translate() {
        return translator;
      },
    },
    get mailer() {
      return siteMailer;
    },
    media: { publicBase: 'https://media.example.com' },
    collections: {
      // Pages first, and its blocks field is required: a scratch entry cannot be filled in
      // from that schema, which is the collection "Simulate conflict" has to walk past.
      pages: { schema: page },
      listings: { schema: listing, route: '/listings/[slug]', index: '/listings' },
      presenters: { schema: presenter, titleField: 'name' },
      posts: { schema: article, route: '/blog/[slug]', index: '/blog', localizedSlugs: true },
    },
    globals: { site },
  },
}));
// What the build read out of src/content/, inlined into the Worker bundle.
vi.mock('virtual:handover/index', () => ({
  preview: true,
  default: {
    listings: [
      {
        id: 'mill-house',
        locales: {
          en: { title: 'The Mill House', path: 'src/content/listings/en/mill-house.yaml' },
        },
      },
      {
        id: 'seaview-cottage',
        locales: {
          en: {
            title: 'Seaview Cottage',
            path: 'src/content/listings/en/seaview-cottage.yaml',
          },
        },
      },
    ],
    posts: [
      {
        id: 'hello',
        locales: { en: { title: 'Hello', path: 'src/content/posts/en/hello.yaml' } },
      },
      {
        id: 'taken',
        locales: {
          en: { title: 'Taken', path: 'src/content/posts/en/taken.yaml' },
          de: { title: 'Belegt', path: 'src/content/posts/de/taken.yaml', slug: 'belegt' },
        },
      },
    ],
    presenters: [
      {
        id: 'rosa-hale',
        locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
      },
    ],
    // A global is an entry of the `globals` collection, listed by its file name.
    globals: [
      { id: 'site', locales: { en: { title: 'site', path: 'src/content/globals/en/site.yaml' } } },
    ],
  },
}));
vi.mock('cloudflare:workers', () => ({
  env: {
    GITHUB_APP_ID: '1',
    GITHUB_INSTALLATION_ID: '2',
    GITHUB_PRIVATE_KEY: 'key',
    GITHUB_REPO: 'acme/site',
    get DEEPL_API_KEY() {
      return deeplKey;
    },
    get HANDOVER_SETTINGS_KEY() {
      return settingsSecret;
    },
    get RESEND_API_KEY() {
      return resendKey;
    },
    get SMTP_USER() {
      return smtpUser;
    },
    get SMTP_PASS() {
      return smtpPass;
    },
    get EMAIL() {
      return emailBinding;
    },
    get CLOUDFLARE_API_TOKEN() {
      return cloudflareToken;
    },
    get CLOUDFLARE_WORKER() {
      return cloudflareWorker;
    },
    get R2_ACCOUNT_ID() {
      return bucketed ? 'acct-1' : undefined;
    },
    get R2_BUCKET() {
      return bucketed ? 'site-media' : undefined;
    },
    get R2_ACCESS_KEY_ID() {
      return bucketed ? 'AKIDEXAMPLE' : undefined;
    },
    get R2_SECRET_ACCESS_KEY() {
      return bucketed ? 'secret' : undefined;
    },
    DB: {},
  },
}));
// Better Auth's own `setPassword` is proven against a real database in core's auth.test.ts;
// what these route tests are about is what this file does with its answers.
let setPassword: (args: unknown) => Promise<unknown> = async () => ({ status: true });
// The admin plugin's four endpoints are proven against a real Better Auth in core's own
// auth.test.ts; what these route tests are about is what this file sends them and does with
// their answers. `invited` records whether the instance asking was the invite one.
type Call = { body: Record<string, unknown>; invite: boolean };
const calls: Record<string, Call[]> = {
  createUser: [],
  signInMagicLink: [],
  setRole: [],
  removeUser: [],
};
let createUserRefusal: unknown;
let magicLinkRefusal: unknown;
let setRoleRefusal: unknown;
vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  createAuth: (_url: URL, _ctx: unknown, options?: { invite?: true }) => {
    const record = (name: string) => async (args: { body: Record<string, unknown> }) => {
      calls[name]?.push({ body: args.body, invite: Boolean(options?.invite) });
      if (name === 'createUser') {
        if (createUserRefusal) throw createUserRefusal;
        return { user: { id: 'new', email: String(args.body.email).toLowerCase() } };
      }
      if (name === 'signInMagicLink' && magicLinkRefusal) throw magicLinkRefusal;
      if (name === 'setRole' && setRoleRefusal) throw setRoleRefusal;
      return { status: true };
    };
    return {
      api: {
        setPassword: (args: unknown) => setPassword(args),
        createUser: record('createUser'),
        signInMagicLink: record('signInMagicLink'),
        setRole: record('setRole'),
        removeUser: record('removeUser'),
      },
    };
  },
}));
let facts = { hasPassword: true, sessions: [] as unknown[] };
// Who this site's members are, per test. The real query runs against a real D1 in core.
type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  pending: boolean;
  method: string | null;
  lastSignIn: number | null;
  invitedAt: number;
};
let memberRows: MemberRow[] = [];
// The D1 boundary again: what each route asked to be written, and what it asked the reader
// for. The reader's own filter runs against a real D1 in core's `activity.test.ts`.
const logged: Record<string, unknown>[] = [];
let read: unknown[] = [];
/** Which rows the routes took out of the owner count, in order. */
const demoted: string[] = [];
// The locks table, per test: who is editing the entry a request is about, what everybody is
// editing, and whose locks a removal let go of. The statements themselves run against a real
// D1 in core's own `locks.test.ts`.
let holder: { userId: string; name: string; expiresAt: number } | undefined;
let editing: Record<string, string[]> = {};
const released: string[] = [];
const beats: string[] = [];
/** And which ones Take over transferred. */
const taken: string[] = [];
// Which user and which session the route asked about — the two values that must come from the
// session and never from the request, or one person could read another's account.
let asked: unknown[] = [];
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  memberList: async () => memberRows,
  // The real one is an UPDATE whose WHERE holds the rule; against a real D1 it is proven in
  // core's own auth.test.ts. What the route owes is asking it before it removes anybody.
  demoteOwner: async (_site: string, _db: unknown, id: string) => {
    const target = memberRows.find((row) => row.id === id);
    if (target?.role !== 'owner') return false;
    if (memberRows.filter((row) => row.role === 'owner').length < 2) return false;
    target.role = 'editor';
    demoted.push(id);
    return true;
  },
  logActivity: async (_site: string, _db: unknown, event: Record<string, unknown>) => {
    logged.push(event);
  },
  activityPage: async (..._args: unknown[]) => {
    read = _args.slice(2);
    return { events: [], cursor: null };
  },
  accountFacts: async (..._args: unknown[]) => {
    asked = _args.slice(2);
    return facts;
  },
  claimLock: async (_site: string, _db: unknown, entry: string, userId: string) => {
    beats.push(entry);
    return holder && holder.userId !== userId ? undefined : 1755864120000;
  },
  takeLock: async (_site: string, _db: unknown, entry: string) => {
    taken.push(entry);
    holder = undefined;
    return 1755864120000;
  },
  lockHolder: async () => holder,
  heldEntries: async () => editing,
  releaseLocks: async (_site: string, _db: unknown, userId: string) => {
    released.push(userId);
  },
  createGitClient: () => ({ getFile, getHead, publish }),
  openDb: () => {
    if (dbRefusal) throw dbRefusal;
    return { query: { drafts: { findFirst: async () => undefined } } };
  },
  checkStore: async () => {
    if (storeRefusal) throw storeRefusal;
  },
  settingFacts: async () =>
    Object.entries(stored).map(([key, row]) => ({
      key,
      hint: row.hint,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })),
  readSetting: async (_site: string, _db: unknown, secret: string | undefined, key: string) => {
    if (!stored[key]) return undefined;
    if (!secret)
      throw new Error('HANDOVER_SETTINGS_KEY is not set, so a key stored here cannot be read');
    return stored[key]?.value;
  },
  writeSetting: async (
    _site: string,
    _db: unknown,
    secret: string | undefined,
    key: string,
    value: string,
    userId: string | null,
  ) => {
    if (!secret)
      throw new Error('HANDOVER_SETTINGS_KEY is not set: make one with `openssl rand -base64 32`');
    stored[key] = { value, hint: value.slice(-4), updatedAt: 1755864000000, updatedBy: userId };
  },
  removeSetting: async (_site: string, _db: unknown, key: string) => {
    delete stored[key];
  },
  loadDraft: async (_site: string, _db: unknown, path: string) => rows[path] ?? draft,
  saveDraft,
  createDraft,
  recordRename,
  recordDelete,
  recordOffer,
  discardDraft,
  overlayRows,
  heldDrafts,
  holdEntry,
  entryConflict,
  pendingDrafts,
  publishDrafts,
  readyDrafts,
  resolveConflict,
  resolveDrift,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  commitBuild,
  clearPublished,
  revertCommit,
  findMedia,
  mediaList,
  confirmUpload,
  lastCommit: async () => lastCommitRow,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  draft = undefined;
  locales = ['en'];
  translator = translate;
  deeplKey = undefined;
  settingsSecret = 'c2VjcmV0';
  for (const key of Object.keys(stored)) delete stored[key];
  siteMailer = undefined;
  lastCommitRow = { sha: 'def456', at: 1755864000000, kind: 'publish' };
  cloudflareToken = 'cf-token';
  cloudflareWorker = 'acct/handover-demo';
  bucketed = true;
  storeRefusal = undefined;
  dbRefusal = undefined;
  findMedia.mockClear();
  findMedia.mockResolvedValue(undefined);
  mediaList.mockClear();
  confirmUpload.mockClear();
  commitBuild.mockClear();
  clearPublished.mockClear();
  revertCommit.mockClear();
  setPassword = async () => ({ status: true });
  facts = { hasPassword: true, sessions: [] };
  asked = [];
  memberRows = [];
  logged.length = 0;
  read = [];
  demoted.length = 0;
  holder = undefined;
  editing = {};
  released.length = 0;
  beats.length = 0;
  taken.length = 0;
  createUserRefusal = undefined;
  magicLinkRefusal = undefined;
  setRoleRefusal = undefined;
  for (const list of Object.values(calls)) list.length = 0;
  resendKey = undefined;
  smtpUser = undefined;
  smtpPass = undefined;
  emailBinding = undefined;
  smtpCalls.length = 0;
  smtpRefusal = undefined;
  sent.length = 0;
  for (const path of Object.keys(files)) delete files[path];
  for (const path of Object.keys(rows)) delete rows[path];
  entryConflict.mockClear();
  entryConflict.mockResolvedValue(undefined);
  setEntryStatus.mockClear();
  resolveConflict.mockClear();
});

const ctx = (path: string, request?: Request, locals: Record<string, unknown> = {}) =>
  ({
    params: { path },
    request,
    url: new URL(`https://x/admin/api/${path}`),
    locals,
  }) as unknown as APIContext;
const post = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST', body }));
const put = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'PUT', body }));

test('ping returns the collection names and who is signed in', async () => {
  const session = {
    user: { id: 'u1', name: 'Anna Berg', email: 'anna@example.com' },
    role: 'editor',
  };
  const res = await GET(ctx('ping', undefined, { handover: session }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    collections: ['pages', 'listings', 'presenters', 'posts'],
    globals: true,
    user: session.user,
    role: 'editor',
    // Where a stored key is served from: the widgets draw thumbnails of keys nothing listed.
    mediaBase: 'https://media.example.com',
    // Whether this build has a preview route at all: without one the pane says so rather than
    // drawing a frame around a 404.
    preview: true,
  });
});

const owner = { user: { id: 'u1', name: 'Martin', email: 'martin@example.com' }, role: 'owner' };
const editor = { user: { id: 'u2', name: 'Anna', email: 'anna@example.com' }, role: 'editor' };
const testEmail = (session?: unknown) =>
  POST(
    ctx('checks/email', new Request('https://x/admin/api/checks/email', { method: 'POST' }), {
      handover: session,
    }),
  );

test('a test email goes to the signed-in owner and answers with the id it was given', async () => {
  siteMailer = fakeMailer;
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, to: 'martin@example.com', id: 'fake-1' });
  // Nobody else can be named: the recipient is the session's, not the request's.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe('martin@example.com');
});

// The diagnostics screen's own endpoints: the configuration it reads back, and one check per
// connection. Every one of them is the owner's — the payload names the repository, the sending
// address and the media host, and a hidden sidebar item is not a gate.
const check = (name: string, session?: unknown) =>
  POST(
    ctx(`checks/${name}`, new Request(`https://x/admin/api/checks/${name}`, { method: 'POST' }), {
      handover: session,
    }),
  );
const body = async (res: Response) => (await res.json()) as Record<string, string>;

test('the diagnostics page reads the configuration back as the site resolved it', async () => {
  siteMailer = { provider: 'resend', from: 'Handover <hello@example.com>' };
  locales = ['en', 'de'];
  const res = await GET(ctx('diagnostics', undefined, { handover: owner }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    collections: [
      { name: 'pages' },
      { name: 'listings', route: '/listings/[slug]' },
      { name: 'presenters' },
      { name: 'posts', route: '/blog/[slug]' },
    ],
    locales: ['en', 'de'],
    defaultLocale: 'en',
    mediaBase: 'https://media.example.com',
    mailer: { provider: 'resend', from: 'Handover <hello@example.com>' },
    preview: true,
    // What the build mode is, and under vitest that is development — the flag is what decides
    // whether the screen offers "Simulate conflict", which commits to the repository.
    dev: true,
  });
});

test('a mailer the site handed in itself is named as its own rather than as a provider', async () => {
  siteMailer = async () => ({ id: 'x' });
  expect(
    (await body(await GET(ctx('diagnostics', undefined, { handover: owner })))).mailer,
  ).toEqual({ provider: 'custom' });
});

test("the configuration is the owner's, not an editor's", async () => {
  expect((await GET(ctx('diagnostics', undefined, { handover: editor }))).status).toBe(403);
});

test('the repository check names the repository and the commit it read', async () => {
  getHead.mockResolvedValueOnce('15db5481068f69ac8e283707ec6ddb7f4d59744a');
  const res = await check('github', owner);
  expect(res.status).toBe(200);
  // Shortened: the whole forty characters is noise on a page somebody reads out loud.
  expect(await res.json()).toEqual({
    ok: true,
    detail: 'acme/site — the app minted a token and read 15db548.',
  });
});

test('a bucket the site was never told about answers with the four values to set', async () => {
  bucketed = false;
  const res = await check('storage', owner);
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('R2_ACCOUNT_ID');
});

test('a bucket that refuses the round trip answers with what refused it', async () => {
  storeRefusal = new Error('The bucket refused the upload (403)');
  const res = await check('storage', owner);
  expect(res.status).toBe(502);
  expect((await body(res)).error).toBe('The bucket refused the upload (403)');
});

test('a bucket that takes the round trip says an upload would work', async () => {
  const res = await check('storage', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toContain('site-media');
});

test('a site with no translator says translation is off rather than failing', async () => {
  translator = undefined;
  locales = ['en', 'de'];
  const res = await check('translation', owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    off: true,
    detail:
      'No DeepL key in Settings, no DEEPL_API_KEY and no translate hook, so the Translate button is hidden.',
  });
});

test("a translator is checked by translating a word into the site's other language", async () => {
  locales = ['en', 'de'];
  const res = await check('translation', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toBe('It translated "Hello" into de.');
  expect(translate).toHaveBeenCalledWith(['Hello'], 'en', 'de');
});

test('a one-language site has nothing to translate into and says that instead', async () => {
  const res = await check('translation', owner);
  expect(await res.json()).toEqual({
    off: true,
    detail: 'This site has one language, so nothing is translated.',
  });
});

test('a site with no Cloudflare token says the build pill is off, not broken', async () => {
  cloudflareToken = undefined;
  const res = await check('build', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).off).toBe(true);
  expect(commitBuild).not.toHaveBeenCalled();
});

test('the build check asks the host about the worker rather than about a commit', async () => {
  const res = await check('build', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toContain('acct/handover-demo');
  // No commit: what is being checked is the token, and a commit nothing built would read as
  // a broken token.
  expect(commitBuild).toHaveBeenCalledWith(
    { worker: 'acct/handover-demo', token: 'cf-token' },
    undefined,
  );
});

test('a token the host refuses is a failing check and says so', async () => {
  commitBuild.mockRejectedValueOnce(new Error('Cloudflare builds failed: 403'));
  const res = await check('build', owner);
  expect(res.status).toBe(502);
  expect((await body(res)).error).toBe('Cloudflare builds failed: 403');
});

test('the database check answers with the schema version the tables are at', async () => {
  const res = await check('database', owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    detail: "The database answered — the admin's tables are there. Schema version 2.",
  });
});

test('a site with no D1 binding answers with the binding to add', async () => {
  dbRefusal = new Error('The D1 binding DB is not configured: add a d1_databases entry');
  const res = await check('database', owner);
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('d1_databases');
});

test("every check is the owner's", async () => {
  for (const name of ['github', 'storage', 'translation', 'build', 'database']) {
    expect((await check(name, editor)).status).toBe(403);
  }
});

test('a check nobody has heard of is not found', async () => {
  expect((await check('nonsense', owner)).status).toBe(404);
});

// The one writable section of the settings screen. The encryption is core's and runs against a
// real D1 there; what these are about is the gate, the order the sources resolve in, what comes
// back to the browser and what goes into the log.
const settings = (session?: unknown) => GET(ctx('settings', undefined, { handover: session }));
const setKey = (key: string, value: unknown, session: unknown = owner) =>
  PUT(
    ctx(
      `settings/${key}`,
      new Request(`https://x/admin/api/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
      { handover: session },
    ),
  );
const clearKey = (key: string, session: unknown = owner) =>
  DELETE(
    ctx(
      `settings/${key}`,
      new Request(`https://x/admin/api/settings/${key}`, { method: 'DELETE' }),
      {
        handover: session,
      },
    ),
  );

test("the keys the client owns are the owner's, not an editor's", async () => {
  expect((await settings(editor)).status).toBe(403);
  expect((await setKey('deepl', 'k', editor)).status).toBe(403);
  expect((await clearKey('deepl', editor)).status).toBe(403);
  expect(stored.deepl).toBeUndefined();
});

test('a key set here is named by its last four and by who set it', async () => {
  memberRows = [
    {
      id: 'u1',
      name: 'Martin',
      email: 'martin@example.com',
      role: 'owner',
      pending: false,
      method: 'password',
      lastSignIn: null,
      invitedAt: 0,
    },
  ];
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1755864000000, updatedBy: 'u1' };
  translator = undefined;
  const res = await settings(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    integrations: [
      {
        key: 'deepl',
        source: 'settings',
        // Nothing behind it, so the card can say Remove hides the Translate button rather than
        // guessing that something else would take over.
        fallback: 'off',
        hint: 'x7Kq',
        updatedAt: 1755864000000,
        by: 'Martin',
      },
      { key: 'assist', source: 'off', fallback: 'off', hint: null, updatedAt: null, by: null },
    ],
  });
});

test("a key only the environment has is named as the site's own", async () => {
  translator = undefined;
  deeplKey = 'env-key';
  const { integrations } = (await (await settings(owner)).json()) as {
    integrations: { key: string; source: string; hint: string | null }[];
  };
  expect(integrations[0]).toEqual({
    key: 'deepl',
    source: 'env',
    fallback: 'env',
    hint: null,
    updatedAt: null,
    by: null,
  });
});

test('a key set here says what removing it would fall back to', async () => {
  translator = undefined;
  deeplKey = 'env-key';
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: null };
  const { integrations } = (await (await settings(owner)).json()) as {
    integrations: { source: string; fallback: string }[];
  };
  expect(integrations[0]).toMatchObject({ source: 'settings', fallback: 'env' });
});

test('a site that translates with its own code is not translated by a key pasted here', async () => {
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1755864000000, updatedBy: null };
  const res = await settings(owner);
  const [deepl] = ((await res.json()) as { integrations: { source: string; hint: string }[] })
    .integrations;
  // The hook is above both keys in the resolution, so the card cannot claim to be in charge.
  expect(deepl?.source).toBe('code');
  expect(deepl?.hint).toBe('x7Kq');
});

test('a key is tried against DeepL before it is stored, and a refusal stores nothing', async () => {
  locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ message: 'Wrong endpoint' }, { status: 403 })),
  );
  const res = await setKey('deepl', 'wrong-key');
  expect(res.status).toBe(502);
  expect((await body(res)).error).toContain('403');
  expect(stored.deepl).toBeUndefined();
  expect(logged).toEqual([]);
});

test('a key that answers is stored, and the answer never carries it back', async () => {
  locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ translations: [{ text: 'Hallo' }] })),
  );
  const res = await setKey('deepl', '  fx-0000-x7Kq  ');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, detail: 'It translated "Hello" into de.' });
  // Trimmed: a pasted key carries whitespace, and the service would refuse it later.
  expect(stored.deepl?.value).toBe('fx-0000-x7Kq');
});

test('what the log records is the name of the key and what happened to it', async () => {
  locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ translations: [{ text: 'Hallo' }] })),
  );
  await setKey('deepl', 'fx-0000-x7Kq');
  await setKey('deepl', 'fx-1111-9zQp');
  await clearKey('deepl');
  expect(logged).toEqual([
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'set' } },
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'replaced' } },
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'removed' } },
  ]);
  expect(JSON.stringify(logged)).not.toContain('9zQp');
});

test('a key outside the allow-list is not found, whatever it is called', async () => {
  expect((await setKey('github', 'ghp_x')).status).toBe(404);
  expect((await clearKey('resend')).status).toBe(404);
  expect(stored.github).toBeUndefined();
});

test('an empty key is refused before anything is asked or stored', async () => {
  expect((await setKey('deepl', '   ')).status).toBe(400);
  expect((await setKey('deepl', 42)).status).toBe(400);
  expect(stored.deepl).toBeUndefined();
});

test('a site with no secret to encrypt under names the secret rather than storing it', async () => {
  settingsSecret = undefined;
  const res = await setKey('assist', 'ai-key');
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('HANDOVER_SETTINGS_KEY');
  expect(stored.assist).toBeUndefined();
});

test('removing a key takes it out and leaves the other one where it is', async () => {
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: 'u1' };
  stored.assist = { value: 'ai-key', hint: '-key', updatedAt: 1, updatedBy: 'u1' };
  expect((await clearKey('deepl')).status).toBe(200);
  expect(stored.deepl).toBeUndefined();
  expect(stored.assist).toBeDefined();
});

// The whole point of the section: the key the client pasted is the one that translates.
test('the key stored here is the one DeepL is called with, over the one on the Worker', async () => {
  machine();
  translator = undefined;
  deeplKey = 'env-key';
  stored.deepl = { value: 'fx-client-key', hint: '-key', updatedAt: 1, updatedBy: 'u1' };
  const calls: { init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      const sent = JSON.parse(String(init.body)) as { text: string[] };
      return Response.json({ translations: sent.text.map((t) => ({ text: `[de] ${t}` })) });
    }),
  );

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(200);
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('DeepL-Auth-Key fx-client-key');
});

test('a stored key the secret can no longer open is a sentence on the settings screen', async () => {
  translator = undefined;
  locales = ['en', 'de'];
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: 'u1' };
  settingsSecret = undefined;
  const res = await check('translation', owner);
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('HANDOVER_SETTINGS_KEY');
});

test('an editor cannot send a test email', async () => {
  siteMailer = fakeMailer;
  const res = await testEmail(editor);
  expect(res.status).toBe(403);
  expect(sent).toEqual([]);
});

test('a site that configured no mailer says so instead of failing', async () => {
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('cms.config.ts');
});

test('a site whose provider has no key names the key', async () => {
  siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('RESEND_API_KEY');
});

test('the named provider sends through Resend on the key the Worker holds', async () => {
  siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  resendKey = 're_123';
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ id: 'e1b2c3d4' });
    }),
  );
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, to: 'martin@example.com', id: 'e1b2c3d4' });
  expect(calls[0]).toMatchObject({
    from: 'Handover <onboarding@resend.dev>',
    to: 'martin@example.com',
  });
});

test("the provider's own refusal is what a failed test email says", async () => {
  siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  resendKey = 're_123';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { message: 'The onboarding@resend.dev domain is for testing.' },
        { status: 403 },
      ),
    ),
  );
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Resend refused the message (403): The onboarding@resend.dev domain is for testing.',
  );
});

test('a site on smtp with no login names both halves of it', async () => {
  siteMailer = { provider: 'smtp', from: 'Handover <admin@example.com>', host: 'smtp.example.com' };
  smtpUser = 'resend';
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain('SMTP_USER');
  expect(error).toContain('SMTP_PASS');
});

test('a site on cloudflare with no binding names the binding', async () => {
  siteMailer = { provider: 'cloudflare', from: 'Handover <admin@example.com>' };
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('send_email');
});

test('smtp sends over implicit TLS with the sender split, and reports no id', async () => {
  siteMailer = {
    provider: 'smtp',
    from: 'Handover <admin@dev.martinconde.de>',
    host: 'smtp.resend.com',
  };
  smtpUser = 'resend';
  smtpPass = 're_secret_123';
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  // No `id`: SMTP hands back nothing a person could look the message up by.
  expect(await res.json()).toEqual({ ok: true, to: 'martin@example.com' });
  expect(smtpCalls).toHaveLength(1);
  expect(smtpCalls[0]?.options).toMatchObject({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    startTls: false,
    authType: ['plain', 'login'],
    credentials: { username: 'resend', password: 're_secret_123' },
  });
  expect(smtpCalls[0]?.email).toMatchObject({
    to: 'martin@example.com',
    from: { name: 'Handover', email: 'admin@dev.martinconde.de' },
  });
});

test('a refused smtp send tells the owner nothing about the password', async () => {
  siteMailer = {
    provider: 'smtp',
    from: 'Handover <admin@dev.martinconde.de>',
    host: 'smtp.resend.com',
  };
  smtpUser = 'resend';
  smtpPass = 're_secret_123';
  smtpRefusal = new Error('Failed to plain authentication: 535 Authentication failed');
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  const { error } = (await res.json()) as { error: string };
  expect(error).toBe(
    'smtp.resend.com did not take the message: Failed to plain authentication: 535 Authentication failed',
  );
  expect(error).not.toContain('re_secret_123');
  expect(error).not.toContain(btoa('\0resend\0re_secret_123'));
});

test("Cloudflare's refusal reaches the owner naming the rule that was broken", async () => {
  siteMailer = { provider: 'cloudflare', from: 'Handover <admin@not-onboarded.example.com>' };
  emailBinding = {
    send: () =>
      Promise.reject(
        new Error(
          'email from not-onboarded.example.com not allowed because domain is not owned by the same account',
        ),
      ),
  };
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Cloudflare refused the message: email from not-onboarded.example.com not allowed because domain is not owned by the same account',
  );
});

test('unknown paths are 404', async () => {
  expect((await GET(ctx('nope'))).status).toBe(404);
  expect((await POST(post('nope', ''))).status).toBe(404);
});

test('an entry returns its fields and its parsed data, and no sha', async () => {
  const res = await GET(ctx('entries/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    fields: [
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['location'], label: 'Location', type: 'text', required: false },
      { path: ['rooms'], label: 'Rooms', type: 'number', required: true },
      {
        path: ['address'],
        label: 'Address',
        type: 'group',
        required: true,
        fields: [{ path: ['street'], label: 'Street', type: 'text', required: true }],
      },
    ],
    blocks: {},
    data: { title: 'The Mill House', location: 'Bakewell', rooms: 3 },
    translations: {},
    pending: [],
    held: false,
    problems: [{ path: 'address', message: 'Required' }],
    // On the site: `_status` is absent, so no `redirects` key comes with it either.
    hidden: false,
    locales: ['en'],
    defaultLocale: 'en',
    sourceLocale: 'en',
    offered: ['en'],
    offerProblems: [],
    drift: [],
    stale: [],
    translator: true,
    // Where the site serves it, which is what the editor builds a URL from — the address row,
    // and the URL it names when a language that has a file is turned off.
    route: '/listings/[slug]',
    index: '/listings',
    prefixDefaultLocale: false,
    // Which of its languages the repository already has a file for: the rest are pages the
    // preview can show and the live site cannot.
    published: ['en'],
  });
});

test('an unknown collection or missing entry is 404', async () => {
  expect((await GET(ctx('entries/nope/mill-house'))).status).toBe(404);
  expect((await GET(ctx('entries/listings/nope'))).status).toBe(404);
  expect(getFile).not.toHaveBeenCalledWith(expect.stringContaining('nope/'));
});

test('an entry the App cannot reach names the repository rather than the entry', async () => {
  const message =
    'The GitHub App cannot see acme/site. Add the repository to installation 2, or correct the repository name.';
  getFile.mockImplementationOnce(async () => {
    throw new RepoUnreachableError(message);
  });

  const res = await GET(ctx('entries/listings/mill-house'));

  expect(res.status).toBe(503);
  expect(await res.text()).toBe(message);
});

// A global is edited through the entry path: `globals` is the collection and the file name the
// slug. What comes back says so, and carries the name the dev gave it rather than a title field.
test('a global is served as an entry, in singleton mode and under its own label', async () => {
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes since 2009"\n';

  const res = await GET(ctx('entries/globals/site'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.fields).toEqual([
    { path: ['footerText'], label: 'Footer text', type: 'text', required: true },
    { path: ['phone'], label: 'Phone', type: 'text', required: false, i18n: 'duplicate' },
  ]);
  expect(body.data).toEqual({ footerText: 'Coastal homes since 2009' });
  expect(body.singleton).toBe(true);
  expect(body.label).toBe('Site details');
  // Nothing a collection's routes are about: a global has no page of its own to link to.
  expect(body.route).toBeUndefined();
  expect(body.localizedSlugs).toBeUndefined();
  delete files['src/content/globals/en/site.yaml'];
});

test('a key cms.config.ts does not declare is not a global', async () => {
  expect((await GET(ctx('entries/globals/nope'))).status).toBe(404);
});

// The subtraction from the other side: a global's file is named by the schema and there is one
// of it, so the four routes that move an entry around have nothing to do with it.
test('a global is refused the routes that rename, address, delete or turn off an entry', async () => {
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes"\n';

  expect((await POST(post('entries/globals/site/rename', '{"to":"other"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/address/en', '{"address":"x"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/locales', '{"locales":["en"]}'))).status).toBe(404);
  expect((await DELETE(ctx('entries/globals/site'))).status).toBe(404);

  delete files['src/content/globals/en/site.yaml'];
});

test('a global takes a draft through the same autosave as an entry', async () => {
  saveDraft.mockClear();
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes"\n';

  const res = await PUT(
    put(
      'drafts/globals/site',
      JSON.stringify({ data: { footerText: 'Coastal homes since 2009' } }),
    ),
  );

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/globals/en/site.yaml',
    { footerText: 'Coastal homes since 2009' },
    // One language, so nothing to keep in step — the same plain write an entry gets.
    undefined,
  );
  expect(await res.json()).toEqual({ updated_at: 1755864000000, pending: true, problems: [] });
  delete files['src/content/globals/en/site.yaml'];
});

// The publish holds every file to a schema, and a global's is its own: without this the one
// file nothing else validates would be the one that can break the build.
test('publishing is refused when a global is missing something its schema needs', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'phone: "0100"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: 'src/content/globals/en/site.yaml is missing something the schema needs',
    paths: ['src/content/globals/en/site.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// The site settings list: the cards, in cms.config.ts order. A language with no file is left out
// rather than listed empty — the dashed chip on the card is what offers to make one.
test('the globals list names each global and the languages it has a file in', async () => {
  locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => []);

  const res = await GET(ctx('globals'));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    globals: [
      {
        key: 'site',
        label: 'Site details',
        description: 'Contact details and footer text',
        locales: ['en'],
        pending: false,
      },
    ],
    locales: ['en', 'de'],
  });
  locales = ['en'];
});

test('a global with a draft ahead of the repository carries the pending dot', async () => {
  locales = ['en', 'de'];
  const row = {
    path: 'src/content/globals/de/site.yaml',
    contents: 'footerText: "Küstenhäuser"\n',
    updatedAt: 1755864000000,
  };
  overlayRows.mockImplementationOnce(async () => [row]);
  pendingDrafts.mockImplementationOnce(async () => [row]);

  const res = await GET(ctx('globals'));

  const { globals } = (await res.json()) as {
    globals: { locales: string[]; pending: boolean }[];
  };
  const [global] = globals;
  expect(global?.pending).toBe(true);
  // The German file is a draft and has never been committed, and the card counts it all the same.
  expect(global?.locales).toEqual(['en', 'de']);
  locales = ['en'];
});

test('an entry with a draft returns the draft data and reports it as pending', async () => {
  draft = {
    contents: 'title: "The Mill House (draft)"\nlocation: "Bakewell"\nrooms: 3\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };
  const res = await GET(ctx('entries/listings/mill-house'));
  const body = (await res.json()) as { data: unknown; pending: unknown };
  expect(body.data).toEqual({ title: 'The Mill House (draft)', location: 'Bakewell', rooms: 3 });
  expect(body.pending).toEqual(['en']);
  draft = undefined;
});

test('autosaving a draft stores it under the entry path with nothing to report', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ updated_at: 1755864000000, pending: true, problems: [] });
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
});

test('autosaving never publishes, whatever the form holds', async () => {
  publish.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(publish).not.toHaveBeenCalled();
});

test('an autosave the schema refuses is stored anyway, with what is missing named', async () => {
  saveDraft.mockClear();
  const data = { title: 'No rooms yet' };
  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    updated_at: 1755864000000,
    pending: true,
    problems: [
      { path: 'rooms', message: 'Required' },
      { path: 'address', message: 'Required' },
    ],
  });
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
});

test('an autosave the serialiser cannot write back is refused, with the reason', async () => {
  saveDraft.mockClear();
  saveDraft.mockImplementationOnce(async () => {
    throw new Error('Nested array at tags[0]: wrap the inner array in an object');
  });
  const res = await PUT(
    put('drafts/listings/mill-house', JSON.stringify({ data: { tags: [[]] } })),
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toBe('Nested array at tags[0]: wrap the inner array in an object');
});

test('a body that is not an object, and an unknown collection, are refused', async () => {
  saveDraft.mockClear();
  const body = JSON.stringify({ data: { title: 'No rooms' } });
  expect((await PUT(put('drafts/listings/mill-house', 'not json'))).status).toBe(400);
  expect((await PUT(put('drafts/listings/mill-house', JSON.stringify({ data: [] })))).status).toBe(
    400,
  );
  expect((await PUT(put('drafts/nope/mill-house', body))).status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

// The `_` keys belong to the file: the server reads them off the entry, so a browser cannot
// set `_version` or `_status` by posting one.
test('reserved keys in the posted data are dropped before the draft is stored', async () => {
  saveDraft.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(
    put('drafts/listings/mill-house', JSON.stringify({ data: { ...data, _status: 'hidden' } })),
  );
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
});

test('an autosave for an entry that is not in the repo is 404', async () => {
  saveDraft.mockImplementationOnce(async () => undefined);
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('drafts/listings/gone', JSON.stringify({ data })))).status).toBe(404);
});

test('the pending list is what the drafts hold that the repository does not', async () => {
  const res = await GET(ctx('drafts'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// One entry, one name, on every screen: a global has no title field to be read off, so the
// drawer calls it what the site settings screen calls it rather than by its file name.
test('a global waiting to be published is listed under its label', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'footerText: "Coastal homes since 2009"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    entries: [
      {
        key: 'globals/site',
        title: 'Site details',
        collection: 'globals',
        locales: ['en'],
        files: ['src/content/globals/en/site.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// The drawer picks entries, so the grouping is done where the titles are: the content index
// lives in the Worker, and a browser handed paths could only fold them back into files.
test('the pending list is one row per entry, whatever languages of it are waiting', async () => {
  locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/listings/de/mill-house.yaml', contents: 'x', updatedAt: 1755864000000 },
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'y',
      updatedAt: 1755863000000,
      pendingRedirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
    },
    { path: 'src/content/pages/en/home.yaml', contents: 'z', updatedAt: 1755862000000 },
  ]);
  heldDrafts.mockImplementationOnce(async () => ({
    'pages/home': { id: 'u2', name: 'Martin' },
  }));
  const res = await GET(ctx('drafts'));
  expect(await res.json()).toEqual({
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        // In the order the site declares them, not the order the rows came back in.
        locales: ['en', 'de'],
        files: [
          'src/content/listings/de/mill-house.yaml',
          'src/content/listings/en/mill-house.yaml',
        ],
        // What the address change on one of its rows owes; the file itself is never a row.
        redirects: 1,
        updated_at: 1755864000000,
        held_by: null,
      },
      {
        key: 'pages/home',
        // Nothing in the index and nothing published: the file name is what there is to call it.
        title: 'home',
        collection: 'pages',
        locales: ['en'],
        files: ['src/content/pages/en/home.yaml'],
        updated_at: 1755862000000,
        // The hold is the entry's, so it is read once rather than per file.
        held_by: { id: 'u2', name: 'Martin' },
      },
    ],
  });
});

test('publishing commits the stored drafts and answers with the commit', async () => {
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'def456',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(publishDrafts).toHaveBeenCalled();
});

test('publishing with nothing pending answers with no files', async () => {
  publishDrafts.mockImplementationOnce(async () => undefined);
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ paths: [] });
});

test('publishing is 409 when a file changed in the repository since the draft was loaded', async () => {
  const { DraftConflictError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new DraftConflictError(['src/content/listings/en/mill-house.yaml']);
  });
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(409);
  // The drawer badges the rows it names, so the paths come back as data, not only as prose.
  expect(await res.json()).toEqual({
    error: 'src/content/listings/en/mill-house.yaml changed in the repository after it was opened',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
});

test('publishing is refused when a stored draft is not everything the schema needs', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House"\n',
      updatedAt: 1755864000000,
    },
  ]);
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: 'src/content/listings/en/mill-house.yaml is missing something the schema needs',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// redirects.yaml and the globals share the prefix and belong to no collection; holding them
// to a schema nobody declared would block every publish for good.
test('a pending file no collection owns is not held to a collection schema', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/redirects.yaml', contents: 'rules: []\n', updatedAt: 1755864000000 },
  ]);
  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

test('discarding a draft drops the row and commits nothing', async () => {
  discardDraft.mockClear();
  publish.mockClear();
  const res = await DELETE(ctx('drafts/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
  );
  expect(publish).not.toHaveBeenCalled();
});

test('discarding a draft of a collection that is not configured is 404', async () => {
  discardDraft.mockClear();
  expect((await DELETE(ctx('drafts/nope/mill-house'))).status).toBe(404);
  expect(discardDraft).not.toHaveBeenCalled();
});

test('publishing is 409 when the branch moved under it', async () => {
  const { RefMovedError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new RefMovedError('main moved past abc123');
  });
  expect((await POST(post('publish', ''))).status).toBe(409);
});

test('the browser cannot hand file contents to the publish endpoint', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('entries/listings/mill-house', JSON.stringify({ data })))).status).toBe(
    404,
  );
  await POST(post('publish', JSON.stringify({ files: [{ path: 'evil.yaml', contents: 'x' }] })));
  expect(publish).not.toHaveBeenCalled();
});

test('the entry list is the built index with the pending drafts over it', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House, renamed"\n',
    },
  ]);
  const res = await GET(ctx('entries/listings'));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { entries: unknown }).entries).toEqual([
    {
      id: 'mill-house',
      locales: {
        en: {
          title: 'The Mill House, renamed',
          path: 'src/content/listings/en/mill-house.yaml',
        },
      },
    },
    {
      id: 'seaview-cottage',
      locales: {
        en: {
          title: 'Seaview Cottage',
          path: 'src/content/listings/en/seaview-cottage.yaml',
        },
      },
    },
  ]);
});

test('opening an entry names the field its collection is keyed on', async () => {
  draft = { contents: 'name: "Rosa Hale"\n', baseSha: 'head789', baseBlob: '' };
  const keyed = (await (await GET(ctx('entries/presenters/rosa-hale'))).json()) as {
    titleField?: string;
  };
  expect(keyed.titleField).toBe('name');
  const plain = (await (await GET(ctx('entries/listings/mill-house'))).json()) as {
    titleField?: string;
  };
  expect(plain.titleField).toBeUndefined();
  draft = undefined;
});

test('a collection keyed on another field lists its drafts by that field', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/presenters/en/ada-fenwick.yaml',
      contents: 'name: "Ada Fenwick"\n',
    },
  ]);
  const res = await GET(ctx('entries/presenters'));
  expect(((await res.json()) as { entries: unknown }).entries).toEqual([
    {
      id: 'ada-fenwick',
      locales: {
        en: { title: 'Ada Fenwick', path: 'src/content/presenters/en/ada-fenwick.yaml' },
      },
    },
    {
      id: 'rosa-hale',
      locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
    },
  ]);
});

test('listing an unknown collection is 404', async () => {
  expect((await GET(ctx('entries/nope'))).status).toBe(404);
});

test('creating an entry derives its file name and stores it as a draft, uncommitted', async () => {
  createDraft.mockClear();
  publish.mockClear();
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Café & Bar / 2026' })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'cafe-bar-2026' });
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/cafe-bar-2026.yaml',
    // Only the title: a required field is left absent rather than guessed at, and the editor
    // is shown what is still missing.
    { _version: 1, title: 'Café & Bar / 2026' },
  );
  expect(publish).not.toHaveBeenCalled();
});

test('a new entry keeps the title that named its file, under the declared field', async () => {
  createDraft.mockClear();
  const res = await POST(post('entries/presenters', JSON.stringify({ title: 'Ada Fenwick' })));
  expect(await res.json()).toEqual({ slug: 'ada-fenwick' });
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/presenters/en/ada-fenwick.yaml',
    { _version: 1, name: 'Ada Fenwick' },
  );
});

test('a title already used in the collection gets the collision suffix', async () => {
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Seaview Cottage' })));
  expect(await res.json()).toEqual({ slug: 'seaview-cottage-2' });
});

test('a name already taken by an unpublished entry counts as taken too', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/strandhaus-nord.yaml',
      contents: 'title: "Strandhaus Nord"\n',
    },
  ]);
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Strandhaus Nord' })));
  expect(await res.json()).toEqual({ slug: 'strandhaus-nord-2' });
});

test('creating in an unknown collection is 404', async () => {
  createDraft.mockClear();
  expect((await POST(post('entries/nope', JSON.stringify({ title: 'x' })))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
});

test('an entry that exists only as a draft opens from it', async () => {
  draft = { contents: 'title: "Strandhaus Nord"\nrooms: 0\n', baseSha: 'head789', baseBlob: '' };
  const res = await GET(ctx('entries/listings/strandhaus-nord'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown; pending: unknown; published: unknown };
  expect(body.data).toEqual({ title: 'Strandhaus Nord', rooms: 0 });
  expect(body.pending).toEqual(['en']);
  // Nothing of it is in the repository, so its preview is the only place this page exists.
  expect(body.published).toEqual([]);
  draft = undefined;
});

test('renaming moves the entry in one commit and takes its unpublished edits with it', async () => {
  publish.mockClear();
  recordRename.mockClear();
  const res = await POST(
    post('entries/listings/mill-house/rename', JSON.stringify({ to: 'The Old Mill' })),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'the-old-mill', commit_sha: 'def456' });
  expect(publish).toHaveBeenCalledTimes(1);
  const [files] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(files.map((f) => f.path)).toEqual([
    'src/content/listings/en/mill-house.yaml',
    'src/content/listings/en/the-old-mill.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(files[0]?.contents).toBe(null);
  expect(files[2]?.contents).toContain('from: "/listings/mill-house"');
  expect(recordRename).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    'src/content/listings/en/the-old-mill.yaml',
    'title: The Mill House\nlocation: Bakewell\nrooms: 3\n',
    'def456',
  );
});

test('renaming an entry that has never been published says so rather than failing', async () => {
  publish.mockClear();
  const res = await POST(
    post('entries/listings/strandhaus-nord/rename', JSON.stringify({ to: 'x' })),
  );
  expect(res.status).toBe(409);
  expect(await res.text()).toContain('Publish');
  expect(publish).not.toHaveBeenCalled();
});

test('deleting commits the removal with a redirect and says the file has gone', async () => {
  publish.mockClear();
  recordDelete.mockClear();
  const res = await DELETE(ctx('entries/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ commit_sha: 'def456' });
  const [files] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(files.map((f) => f.path)).toEqual([
    'src/content/listings/en/mill-house.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(files[1]?.contents).toContain('reason: "deleted"');
  // The list is the build's index and the build has not run yet, so something has to say so.
  expect(recordDelete).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    'def456',
  );
});

// The rule a rename or a delete owes is a URL on the site: it carries the language's segment,
// and on a collection with localized slugs the address that language actually served rather
// than the file name every language shares (F5 in 02-i18n.md).
test('deleting a bilingual entry sends each language its own URL to its own index', async () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
  publish.mockClear();

  const res = await DELETE(ctx('entries/posts/hello'));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  const rules = written.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '';
  expect(rules).toContain('from: "/blog/hello"\n    to: "/blog"');
  expect(rules).toContain('from: "/de/blog/hallo"\n    to: "/de/blog"');
});

test('deleting an entry that was never published makes no commit', async () => {
  publish.mockClear();
  discardDraft.mockClear();
  const res = await DELETE(ctx('entries/listings/strandhaus-nord'));
  expect(res.status).toBe(200);
  expect(publish).not.toHaveBeenCalled();
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/strandhaus-nord.yaml',
  );
});

// One entry in two languages, with a block only the German file has and nothing saying it is
// German-only: the fixture pair from @handover/core, through the routes the admin calls.
const home = {
  en: [
    '_version: 1',
    'title: "Home"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '    heading: "Move to the coast"',
    '',
  ].join('\n'),
  de: [
    '_version: 1',
    'title: "Startseite"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '    heading: "Zieh an die Küste"',
    '  - _type: "quote"',
    '    _id: "z9y8x7w6"',
    '    body: "Ein seltener Fund."',
    '',
  ].join('\n'),
};

const drifted = () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de;
};

test('opening an entry reports the blocks its languages disagree about', async () => {
  drifted();

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { drift: unknown };

  expect(body.drift).toEqual([
    {
      path: 'blocks[_id=z9y8x7w6]',
      type: 'quote',
      in: ['de'],
      expected: ['en', 'de'],
      values: { de: ['Ein seltener Fund.'] },
    },
  ]);
});

// Side by side: the second language is drawn from the same response, so opening an entry is
// still one read per language and the browser never asks for a file of its own.
test('an entry carries the languages it has a file in beside the one it opens on', async () => {
  drifted();

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    translations: Record<string, unknown>;
  };

  expect(body.translations).toEqual({
    de: {
      _version: 1,
      title: 'Startseite',
      blocks: [
        { _type: 'hero', _id: 'k3nf9a2p', heading: 'Zieh an die Küste' },
        { _type: 'quote', _id: 'z9y8x7w6', body: 'Ein seltener Fund.' },
      ],
    },
  });
});

test('the entry list says which languages the site declares', async () => {
  locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries/listings'))).json()) as { locales: unknown };

  expect(body.locales).toEqual(['en', 'de']);
});

// The page picker's one read. `presenters` renders nowhere, so it has entries and no
// addresses; `posts` has localized slugs, so the German file's own `slug` is its address.
test('the picker list carries every collection with the address each language serves', async () => {
  locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries'))).json()) as {
    entries: unknown[];
    locales: unknown;
  };

  expect(body.locales).toEqual(['en', 'de']);
  expect(body.entries).toEqual([
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/mill-house',
      title: 'The Mill House',
      locales: ['en'],
      urls: { en: '/listings/mill-house' },
    },
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      locales: ['en'],
      urls: { en: '/listings/seaview-cottage' },
    },
    {
      collection: 'presenters',
      hidden: false,
      path: 'presenters/rosa-hale',
      title: 'Rosa Hale',
      locales: ['en'],
      urls: {},
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/hello',
      title: 'Hello',
      locales: ['en'],
      urls: { en: '/blog/hello' },
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/taken',
      title: 'Taken',
      locales: ['en', 'de'],
      urls: { en: '/blog/taken', de: '/de/blog/belegt' },
    },
  ]);
});

// 3.26 listed a hidden entry with nothing to say about it; the picker draws the reason from
// this flag rather than deciding for itself what a status means.
test('the picker says which of its rows is off the site', async () => {
  overlayRows.mockResolvedValueOnce([
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\n',
    },
  ]);

  const body = (await (await GET(ctx('entries'))).json()) as { entries: { hidden: boolean }[] };

  expect(body.entries.map((e) => e.hidden)).toEqual([true, false, false, false, false]);
});

test('a save of a translation goes to that language and takes only the words it owns', async () => {
  drifted();
  saveDraft.mockClear();
  const data = { title: 'Startseite!' };

  const res = await PUT(put('drafts/pages/home/de', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    data,
    { form: expect.anything(), locale: 'de', siblings: {}, translation: true },
  );
});

test('a save to a language the site does not declare is refused', async () => {
  drifted();
  saveDraft.mockClear();

  const res = await PUT(put('drafts/pages/home/fr', JSON.stringify({ data: { title: 'x' } })));

  expect(res.status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('publishing an entry whose languages have drifted apart is refused', async () => {
  drifted();
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      "src/content/pages/en/home.yaml has drifted apart from the entry's other languages — resolve it in the editor",
    paths: ['src/content/pages/en/home.yaml'],
    // Which 409 it is: the drawer offers Discard for a conflict and the editor for this.
    reason: 'drift',
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

test('an entry whose languages agree publishes, drift or no drift elsewhere', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

// Staleness: the German file says which English it was translated from, and the entry says
// whether that is still the English it has. A warning and never a refusal.
test('an entry whose translation was made from an older source language says so', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en
    .replace('Home', 'Startseite')
    .replace('Move to the coast', 'Zieh an die Küste')
    .replace(
      '_version: 1\n',
      [
        '_version: 1',
        '_i18n:',
        '  sourceLocale: "en"',
        '  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"',
        '  sourceHash: "0000000000000000"',
        '  translatedAt: "2026-08-20T10:14:00Z"',
        '',
      ].join('\n'),
    );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    stale: unknown;
    drift: unknown;
  };

  expect(body.stale).toEqual(['de']);
  expect(body.drift).toEqual([]);
});

// It reads the entry rather than the path: which language a file was translated from is the
// entry's answer, and an entry with no English file has not been translated from English.
test('a publish names the language each translation it commits was made from', async () => {
  drifted();
  publishDrafts.mockClear();

  await POST(post('publish', ''));

  const sourceOf = publishDrafts.mock.calls[0]?.[3] as (
    path: string,
  ) => Promise<{ locale: string; path: string } | undefined>;
  expect(await sourceOf('src/content/pages/de/home.yaml')).toMatchObject({
    locale: 'en',
    path: 'src/content/pages/en/home.yaml',
  });
  expect(await sourceOf('src/content/pages/en/home.yaml')).toBe(undefined);
  expect(await sourceOf('src/content/redirects.yaml')).toBe(undefined);
});

// A site with one language has no second file to compare against and never reads for one:
// opening an entry is the one request it always was, and publishing reads nothing extra.
test('a one-language site is not asked for a second language of anything', async () => {
  getFile.mockClear();

  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as { drift: unknown };

  expect(body.drift).toEqual([]);
  expect(getFile).toHaveBeenCalledTimes(1);

  getFile.mockClear();
  await POST(post('publish', ''));

  expect(getFile).not.toHaveBeenCalled();
});

// Reconciling that drift: the answers are the editor's, and every language of the entry is
// written behind them. The entry is read again afterwards, so nothing is marked resolved.
const answer = (choices: unknown) => post('drift/pages/home', JSON.stringify({ choices }));

test("the answers to an entry's drift go to every language it has a file in", async () => {
  drifted();
  const choices = [{ path: 'blocks[_id=z9y8x7w6]', locales: ['de'] }];

  const res = await POST(answer(choices));

  expect(res.status).toBe(200);
  expect(resolveDrift).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ blocks: expect.anything() }),
    ['en', 'de'],
    {
      en: 'src/content/pages/en/home.yaml',
      de: 'src/content/pages/de/home.yaml',
    },
    choices,
  );
});

test('an answer about a block the languages agree on is refused rather than written', async () => {
  drifted();
  resolveDrift.mockClear();

  const res = await POST(answer([{ path: 'blocks[_id=k3nf9a2p]', locales: ['de'] }]));

  expect(res.status).toBe(409);
  expect(resolveDrift).not.toHaveBeenCalled();
  expect((await POST(answer([]))).status).toBe(409);
});

// The two ends of the done-when: the state an answer leaves behind is one that publishes, and
// the answer that puts a block into English leaves the schema's own complaint, not a refusal.
const resolved = (locales: string[]) => {
  drifted();
  const form = formOf('default', formSchema(page));
  const applied = applyDrift(
    'default',
    form,
    ['en', 'de'],
    { en: parseEntry('default', home.en), de: parseEntry('default', home.de) },
    [{ path: 'blocks[_id=z9y8x7w6]', locales }],
  );
  const written = Object.entries(applied).map(([locale, data]) => ({
    path: `src/content/pages/${locale}/home.yaml`,
    contents: stringifyEntry('default', data),
    updatedAt: 1755864000000,
  }));
  for (const row of written) files[row.path] = row.contents;
  readyDrafts.mockImplementationOnce(async () => written);
  return written;
};

test('an entry answered German-only publishes', async () => {
  publishDrafts.mockClear();
  resolved(['de']);

  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

test('a block answered into English is refused for what its schema needs, not for drift', async () => {
  publishDrafts.mockClear();
  resolved(['en', 'de']);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: 'src/content/pages/en/home.yaml is missing something the schema needs',
    paths: ['src/content/pages/en/home.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// An entry with no German file: the two things the editor offers there — make one from the
// English, or say this entry is not offered in German at all.
const untranslated = (english = home.en) => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = english;
};

test('creating a language copies the structure and the shared values, not the words', async () => {
  untranslated(home.en.replace('title: "Home"', 'title: "Home"\nlayout: "wide"'));
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(200);
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    {
      _version: 1,
      layout: 'wide',
      blocks: [{ _type: 'hero', _id: 'k3nf9a2p' }],
    },
  );
});

test('the new language is offered in the same ones the entry already is', async () => {
  locales = ['en', 'de', 'fr'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"\n  - "de"',
  );
  createDraft.mockClear();

  await POST(post('drafts/pages/home/de', ''));

  expect(createDraft.mock.calls[0]?.[4]).toMatchObject({ _locales: ['en', 'de'] });
});

test('creating a language the entry already has is refused', async () => {
  drifted();
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(createDraft).not.toHaveBeenCalled();
});

// The site's default language is no longer a language this route refuses on sight: an entry
// with no file in it is exactly what it is for. What refuses it here is the file this entry
// has — the same rule every other language is held to.
test('the language an entry is written in is refused for the file it has, not for being it', async () => {
  untranslated();
  createDraft.mockClear();

  expect((await POST(post('drafts/pages/home/en', ''))).status).toBe(409);
  expect((await POST(post('drafts/pages/home/fr', ''))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
});

// Create from English writes a draft in a language the entry's form does not draw, so the
// response has to name it: the editor offers Publish on any language being ahead, not on the
// one it happens to be showing.
test('an entry names every language whose draft is ahead of the repository', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { pending: unknown };

  expect(body.pending).toEqual(['de']);
});

test('turning a language off writes the ones it keeps into every file the entry has', async () => {
  untranslated();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  expect(setEntryLocales).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    ['src/content/pages/en/home.yaml'],
    ['en'],
    ['en', 'de'],
  );
});

// Turning off a language that has a file is a delete of that one file: it goes in a commit of
// its own, the languages the entry keeps go into the files that stay, and the URL that language
// served sends its readers to the collection's index under that language's segment — the
// address that language answered to, not the file name every language shares (F5's shape).
const bilingualPost = () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';
  files['src/content/posts/de/taken.yaml'] = '_version: 1\ntitle: "Belegt"\nslug: "belegt"\n';
};

test('turning off a language that has a file removes it in one commit, with its redirect', async () => {
  bilingualPost();
  publish.mockClear();
  recordDelete.mockClear();

  const res = await POST(post('entries/posts/taken/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written.map((f) => f.path)).toEqual([
    'src/content/posts/de/taken.yaml',
    'src/content/posts/en/taken.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(written[0]?.contents).toBe(null);
  expect(written[1]?.contents).toContain('_locales:\n  - "en"');
  expect(written[2]?.contents).toContain('from: "/de/blog/belegt"\n    to: "/de/blog"');
  // The list is the build's index and the build has not run yet, so something has to say so.
  expect(recordDelete).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/posts/de/taken.yaml',
    'def456',
  );
});

// The one refusal: with no other file left this is a delete of the entry, and a delete asks the
// redirect question for the whole entry rather than for one of its languages.
test('turning off the last language an entry has a file in is refused', async () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';
  publish.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/posts/taken/locales', JSON.stringify({ locales: ['de'] })));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('Delete');
  expect(publish).not.toHaveBeenCalled();
  expect(setEntryLocales).not.toHaveBeenCalled();
});

// A draft is not a file yet: discarding it afterwards would leave the entry with nothing, and
// the commit has already taken the published one away. Publishing it first is the way through.
test('a language whose only other file is a draft cannot be turned off', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };
  publish.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['de'] })));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('publish de first');
  expect(publish).not.toHaveBeenCalled();
  expect(setEntryLocales).not.toHaveBeenCalled();
});

// A collection nothing renders has nowhere to send anybody: the file goes anyway, and the
// dialog is where the client is told the old URL will 404.
test('a collection with no index writes no redirect for the language that went', async () => {
  drifted();
  publish.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written.map((f) => f.path)).toEqual([
    'src/content/pages/de/home.yaml',
    'src/content/pages/en/home.yaml',
  ]);
});

// The language a translation was made from can be the one that goes: what is left becomes the
// entry's own language, and a mark against a file the entry no longer has cannot say anything
// is stale — so it goes with it.
test('turning off the language a translation was made from drops the mark that named it', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en
    .replace(
      '_version: 1',
      '_version: 1\n_i18n:\n  sourceLocale: "en"\n  sourceHash: "8a41c0b2e9d7f350"',
    )
    .replace('Home', 'Startseite');
  publish.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['de'] })));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  const german = written.find((f) => f.path === 'src/content/pages/de/home.yaml')?.contents ?? '';
  expect(german).toContain('_locales:\n  - "de"');
  expect(german).not.toContain('_i18n');
});

// Nothing of that language is in the repository, so there is nothing to commit and no URL
// anybody could have followed: what Create from English left behind is thrown away, and the
// mark is drafted the way it is for a language that never had a file.
test('turning off a language whose file is only a draft commits nothing', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };
  publish.mockClear();
  discardDraft.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  expect(publish).not.toHaveBeenCalled();
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/pages/de/home.yaml',
  );
  expect(setEntryLocales).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    ['src/content/pages/en/home.yaml'],
    ['en'],
    ['en', 'de'],
  );
});

// A top-level `_locales` is written into every file the entry has, so one that names fewer
// languages than the entry has files is a hand edit or a bad merge: the list struck the
// language through while the editor let somebody type in it, and neither said why.
test('a _locales the files contradict is reported, and the file wins', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );
  files['src/content/pages/de/home.yaml'] = home.de;

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    offered: unknown;
    offerProblems: unknown;
  };

  expect(body.offered).toEqual(['en', 'de']);
  expect(body.offerProblems).toEqual([
    '_locales says this entry is not offered in de, and it has a file in de',
  ]);
});

test('creating a language is refused over a _locales naming one the site does not declare', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"\n  - "fr"',
  );
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('"fr"');
  expect(createDraft).not.toHaveBeenCalled();
});

test('an entry says which languages it is offered in', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { offered: unknown };

  expect(body.offered).toEqual(['en']);
});

// The `translate(from, to)` hook: whatever answers, the route asks it for prose and writes
// the answers into the translation's own draft with `_machine` naming them.
const machine = () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = [
    '_version: 1',
    'title: "Startseite"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '',
  ].join('\n');
};

test('a machine is asked for the fields the translation has not got, and no others', async () => {
  machine();
  translate.mockClear();
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(200);
  // `title` is there in German already; the hero's heading is the gap.
  expect(translate).toHaveBeenCalledWith(['Move to the coast'], 'en', 'de');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
  );
});

test('a named field is translated whether it is empty or not', async () => {
  machine();
  translate.mockClear();
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', JSON.stringify({ paths: ['title'] })));

  expect(res.status).toBe(200);
  expect(translate).toHaveBeenCalledWith(['Home'], 'en', 'de');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { title: '[de] Home' },
  );
});

test('a translation with nothing left to fill asks no machine anything', async () => {
  machine();
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  translate.mockClear();

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
});

// Every other test here supplies `i18n.translate`, so the fallback — and which DeepL the key
// then reaches — is the one wiring none of them walks.
test('a site with no hook of its own translates with the DEEPL_API_KEY it holds', async () => {
  machine();
  translator = undefined;
  deeplKey = 'key-123';
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const sent = JSON.parse(String(init.body)) as { text: string[] };
      return Response.json({ translations: sent.text.map((t) => ({ text: `[de] ${t}` })) });
    }),
  );
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(200);
  expect(calls[0]?.url).toBe('https://api.deepl.com/v2/translate');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('DeepL-Auth-Key key-123');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
  );
});

test('a site with nothing to translate with says so rather than failing quietly', async () => {
  machine();
  translator = undefined;

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('DEEPL_API_KEY');
});

test('the default language and a language with no file are both refused', async () => {
  machine();

  expect((await POST(post('translate/pages/home/en', ''))).status).toBe(404);
  expect((await POST(post('translate/pages/home/fr', ''))).status).toBe(404);
  delete files['src/content/pages/de/home.yaml'];
  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(404);
});

test('an entry says whether there is anything to translate with', async () => {
  machine();
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(true);
  translator = undefined;
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(false);
});

// Having nothing to translate with is about the site and not about this entry, so it is the
// answer even when the entry would have been refused for its own reasons.
test('nothing to translate with outranks the entry having no file in that language', async () => {
  machine();
  translator = undefined;
  delete files['src/content/pages/de/home.yaml'];

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(409);
});

// A collection with an address per language. The file name stays the entry's id across them;
// the address is only what a URL is built from.
// The redirect a hide owes is one per language, and each language's rule is read off the
// answer the client gave once. `files()` is the repository: a language with no file there was
// never on the site, so it has no URL anybody could have followed.
const hide = (body: Record<string, unknown>) =>
  POST(post('status/posts', JSON.stringify({ entries: ['hello'], hidden: true, ...body })));
const written = () => {
  const files = (setEntryStatus.mock.calls[0]?.[4] ?? []) as {
    path: string;
    redirect?: { from: string; to: string };
  }[];
  return files
    .filter((f) => f.redirect)
    .map((f) => [f.path.split('/')[3], f.redirect?.from, f.redirect?.to]);
};

test('hiding an entry sends each language to the overview under its own segment', async () => {
  addressed();

  expect((await hide({ redirect: { kind: 'index' } })).status).toBe(200);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(true);
  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/blog'],
    ['de', '/de/blog/hallo', '/de/blog'],
  ]);
});

// The page picker answers with an entry, and the entry's address in that language is what the
// rule is made of — not the English one under a German segment.
test('a picked page is the address that language serves it at', async () => {
  addressed();

  await hide({ redirect: { kind: 'entry', value: 'posts/taken' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/blog/taken'],
    ['de', '/de/blog/hallo', '/de/blog/belegt'],
  ]);
});

// The case redirects.md spells out: a target with no page in one of the languages sends that
// language to the target's own collection index instead of to a page it cannot read.
test('a picked page with no half in a language falls back to that collection overview', async () => {
  addressed();

  await hide({ redirect: { kind: 'entry', value: 'listings/mill-house' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/listings/mill-house'],
    ['de', '/de/blog/hallo', '/de/listings'],
  ]);
});

test('a typed web address is the one answer for every language', async () => {
  addressed();

  await hide({ redirect: { kind: 'url', value: 'https://example.com/gone' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', 'https://example.com/gone'],
    ['de', '/de/blog/hallo', 'https://example.com/gone'],
  ]);
});

test('"nowhere" hides the entry and writes no rule at all', async () => {
  addressed();

  await hide({ redirect: { kind: 'none' } });

  expect(written()).toEqual([]);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(true);
});

// A language whose file is only a draft has never been served, so hiding the entry before its
// first publish owes nothing: there is no old link for anybody to follow.
test('a language with no file in the repository owes no redirect', async () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\nslug: "hello-world"\n';

  await hide({ redirect: { kind: 'index' } });

  expect(written()).toEqual([['en', '/blog/hello-world', '/blog']]);
});

test('showing an entry again writes the files and no rules', async () => {
  addressed();

  const res = await POST(
    post('status/posts', JSON.stringify({ entries: ['hello'], hidden: false })),
  );

  expect(res.status).toBe(200);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(false);
  expect(written()).toEqual([]);
});

// Bulk hide asks the question once and applies that answer to every entry in the batch.
test('one answer covers every entry in a bulk hide', async () => {
  addressed();
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';

  await POST(
    post(
      'status/posts',
      JSON.stringify({ entries: ['hello', 'taken'], hidden: true, redirect: { kind: 'index' } }),
    ),
  );

  expect(setEntryStatus).toHaveBeenCalledTimes(2);
  expect(
    setEntryStatus.mock.calls.map((call) =>
      (call[4] as { path: string; redirect?: { from: string } }[])
        .filter((f) => f.redirect)
        .map((f) => f.redirect?.from),
    ),
  ).toEqual([['/blog/hello-world', '/de/blog/hallo'], ['/blog/taken']]);
});

test('a collection the site does not declare has no status route', async () => {
  expect((await POST(post('status/nope', '{"entries":["x"],"hidden":true}'))).status).toBe(404);
});

const addressed = () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\nslug: "hello-world"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
};

test('the address is not a field of the form and comes beside it instead', async () => {
  addressed();

  const body = (await (await GET(ctx('entries/posts/hello'))).json()) as {
    fields: { path: string[] }[];
    addresses: Record<string, string>;
    localizedSlugs: boolean;
    route: string;
  };

  expect(body.fields.map((f) => f.path[0])).toEqual(['title']);
  expect(body.addresses).toEqual({ en: 'hello-world', de: 'hallo' });
  expect(body.localizedSlugs).toBe(true);
  expect(body.route).toBe('/blog/[slug]');
});

test('a collection without localized slugs draws no address at all', async () => {
  files['src/content/listings/en/mill-house.yaml'] = 'title: "The Mill House"\nrooms: 3\n';

  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as {
    addresses?: unknown;
    localizedSlugs?: unknown;
  };

  expect(body.localizedSlugs).toBe(undefined);
  expect(body.addresses).toBe(undefined);
});

// It is a URL, not prose: a machine's guess at one is not a word anybody can read in the form
// and correct, and it would not survive the address rules anyway.
test('a machine is never asked to translate the address', async () => {
  addressed();
  translate.mockClear();

  const res = await POST(post('translate/posts/hello/de', JSON.stringify({ paths: ['slug'] })));

  expect(res.status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
});

test('an address that is not one is refused with the reason', async () => {
  addressed();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'Hallo Welt' })),
  );

  expect(res.status).toBe(422);
  expect(await res.text()).toMatch(/lowercase letters, digits and single dashes/);
});

test('an address another entry in that language already serves is refused', async () => {
  addressed();

  // `belegt` is another entry's address in German; `taken` is its file name, which is what it
  // would fall back to the moment somebody cleared that address.
  for (const address of ['belegt', 'taken']) {
    const res = await POST(post('entries/posts/hello/address/de', JSON.stringify({ address })));
    expect([address, res.status]).toEqual([address, 409]);
  }
});

// The same rule a file name follows: an entry nobody has published yet still holds its address.
test('an address an unpublished draft already claims is refused', async () => {
  addressed();
  overlayRows.mockResolvedValueOnce([
    {
      path: 'src/content/posts/de/fresh.yaml',
      contents: '_version: 1\ntitle: "Frisch"\nslug: "frisch"\n',
    },
  ]);

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'frisch' })),
  );

  expect(res.status).toBe(409);
});

test('an entry keeping the address it already has is not a clash with itself', async () => {
  addressed();
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'hallo' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalled();
});

test('moving a published address owes a redirect from where it was, in that language alone', async () => {
  addressed();
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'servus' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      fields: expect.arrayContaining([expect.objectContaining({ path: ['slug'] })]),
    }),
    'src/content/posts/de/hello.yaml',
    'servus',
    { from: '/de/blog/hallo', to: '/de/blog/servus', entry: 'posts/hello' },
  );
});

test('an entry with no file in the repository yet owes nothing', async () => {
  locales = ['en', 'de'];
  rows['src/content/posts/de/hello.yaml'] = {
    contents: '_version: 1\ntitle: "Hallo"\n',
    baseSha: 'head789',
    baseBlob: '',
  };
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'hallo' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      fields: expect.arrayContaining([expect.objectContaining({ path: ['slug'] })]),
    }),
    'src/content/posts/de/hello.yaml',
    'hallo',
    undefined,
  );
});

test('a collection without localized slugs has no address to set', async () => {
  const res = await POST(
    post('entries/listings/mill-house/address/en', JSON.stringify({ address: 'mill' })),
  );

  expect(res.status).toBe(404);
});

// An entry with no file in the site's default language — the demo's German-only Impressum.
// Its structure is German's, because that is the only language anybody wrote it in.
const germanOnly = () => {
  locales = ['en', 'de'];
  files['src/content/pages/de/impressum.yaml'] = [
    '_version: 1',
    'title: "Impressum"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "b7t4x1m9"',
    '    heading: "Impressum"',
    '',
  ].join('\n');
};

test('an entry with no file in the site default opens on the language it has', async () => {
  germanOnly();

  const res = await GET(ctx('entries/pages/impressum'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    sourceLocale: string;
    data: unknown;
    translations: unknown;
    offered: string[];
  };
  expect(body.sourceLocale).toBe('de');
  expect(body.data).toEqual({
    _version: 1,
    title: 'Impressum',
    blocks: [{ _type: 'hero', _id: 'b7t4x1m9', heading: 'Impressum' }],
  });
  // The language it is written in is the form, not a translation of something else.
  expect(body.translations).toEqual({});
  // No `_locales`, so English is a gap somebody can fill and not a decision.
  expect(body.offered).toEqual(['en', 'de']);
});

test('the missing default language is created from the language the entry has', async () => {
  germanOnly();
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/impressum/en', ''));

  expect(res.status).toBe(200);
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/en/impressum.yaml',
    { _version: 1, blocks: [{ _type: 'hero', _id: 'b7t4x1m9' }] },
  );
});

test("a save of the entry's own language carries the structure, whichever language it is", async () => {
  germanOnly();
  saveDraft.mockClear();
  const data = { title: 'Impressum!' };

  const res = await PUT(put('drafts/pages/impressum', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/impressum.yaml',
    data,
    {
      form: expect.anything(),
      locale: 'de',
      siblings: { en: 'src/content/pages/en/impressum.yaml' },
      translation: false,
    },
  );
});

test('a publish marks a translation from the language the entry is written in', async () => {
  locales = ['en', 'de', 'fr'];
  files['src/content/pages/de/impressum.yaml'] = home.de;
  files['src/content/pages/fr/impressum.yaml'] = home.de;
  publishDrafts.mockClear();

  await POST(post('publish', ''));

  const sourceOf = publishDrafts.mock.calls[0]?.[3] as (
    path: string,
  ) => Promise<{ locale: string; path: string } | undefined>;
  // German, not English: the entry has no English file, so nothing was translated from one.
  expect(await sourceOf('src/content/pages/fr/impressum.yaml')).toMatchObject({
    locale: 'de',
    path: 'src/content/pages/de/impressum.yaml',
  });
  expect(await sourceOf('src/content/pages/de/impressum.yaml')).toBe(undefined);
});

test('the account route refuses a caller with no session', async () => {
  const res = await GET(ctx('account', undefined, {}));
  expect(res.status).toBe(401);
});

// The path carries no id, and neither may the answer: an account page that read a user from
// the request would be one URL away from being everybody's account page.
test("the account route reads the session's own user, never the request's", async () => {
  const url = new URL('https://x/admin/api/account?userId=u9&sessionId=s9');
  const res = await GET({
    params: { path: 'account' },
    url,
    locals: { handover: { ...owner, sessionId: 's1' } },
  } as unknown as APIContext);

  expect(res.status).toBe(200);
  expect(asked).toEqual(['u1', 's1']);
});

const setting = (body: string) =>
  POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', { method: 'POST', body }),
      { handover: { ...owner, sessionId: 's1' } },
    ),
  );

test('setting a password with nothing in the body says so', async () => {
  const res = await setting('{}');
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('No password was sent');
});

// The account page shows the sentence, so which rule was broken has to survive the route.
test("a refused password comes back in Better Auth's own words", async () => {
  setPassword = async () => {
    throw { body: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } };
  };
  const res = await setting(JSON.stringify({ newPassword: 'beach' }));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Password too short');
});

test('a password Better Auth accepts answers ok', async () => {
  const res = await setting(JSON.stringify({ newPassword: 'a-brand-new-password' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

// A throw with no code is not Better Auth refusing — it is something broken, and answering
// `400` would tell the person at the keyboard to fix their password.
test('an error that is not a refusal is not turned into one', async () => {
  setPassword = async () => {
    throw new Error('D1 is unreachable');
  };
  await expect(setting(JSON.stringify({ newPassword: 'a-brand-new-password' }))).rejects.toThrow(
    'D1 is unreachable',
  );
});

// ─── members ─────────────────────────────────────────────────────────────────────────────

const member = (
  id: string,
  email: string,
  role: string,
  extra: Partial<MemberRow> = {},
): MemberRow => ({
  id,
  name: '',
  email,
  role,
  pending: false,
  method: 'link',
  lastSignIn: 1,
  invitedAt: 0,
  ...extra,
});

const memberPost = (path: string, body: unknown, session?: unknown) =>
  POST(
    ctx(
      path,
      new Request(`https://x/admin/api/${path}`, { method: 'POST', body: JSON.stringify(body) }),
      {
        handover: session,
      },
    ),
  );
const memberDelete = (path: string, session?: unknown) =>
  DELETE(
    ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'DELETE' }), {
      handover: session,
    }),
  );

test("the members list is the owner's and nobody else's", async () => {
  memberRows = [member('u1', 'martin@example.com', 'owner')];

  const asOwner = await GET(ctx('members', undefined, { handover: owner }));
  const asEditor = await GET(ctx('members', undefined, { handover: editor }));

  expect(asOwner.status).toBe(200);
  expect(await asOwner.json()).toEqual({
    members: [{ ...memberRows[0], editing: [] }],
  });
  expect(asEditor.status).toBe(403);
});

test('the members list says what each of them is editing, by the name on the entry', async () => {
  memberRows = [member('u1', 'martin@example.com', 'owner')];
  editing = { u1: ['listings/seaview-cottage', 'listings/nowhere'] };

  const res = await GET(ctx('members', undefined, { handover: owner }));

  // The index knows the first and has never seen the second, which is still an entry somebody
  // is holding: it is named by its file name rather than left out.
  expect(((await res.json()) as { members: { editing: string[] }[] }).members[0]?.editing).toEqual([
    'Seaview Cottage',
    'nowhere',
  ]);
});

const beat = (path: string, session?: unknown) =>
  POST(
    ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST' }), {
      handover: session,
    }),
  );

test('a beat on an entry nobody is editing takes it, with the base each file was loaded from', async () => {
  rows['src/content/listings/en/mill-house.yaml'] = {
    contents: 'title: The Mill House\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };

  const res = await beat('locks/listings/mill-house', editor);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    held_by: null,
    mine: true,
    expires_at: 1755864120000,
    base: {
      'src/content/listings/en/mill-house.yaml': { sha: 'head789', blob: 'abc123' },
    },
  });
});

test('a beat on an entry somebody else is editing names them and takes nothing', async () => {
  holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await beat('locks/listings/mill-house', editor);

  expect(await res.json()).toMatchObject({
    held_by: { id: 'u1', name: 'Anna Berg' },
    mine: false,
    expires_at: 1755864060000,
  });
});

// The read the second editor polls on: it watches the lock, and a poll arriving first is not a
// way to take an entry off somebody.
test('reading the lock never claims it', async () => {
  const res = await GET(ctx('locks/listings/mill-house', undefined, { handover: editor }));

  expect(await res.json()).toMatchObject({ held_by: null, mine: false, expires_at: null });
  expect(beats).toEqual([]);
});

test('a collection nothing declares has no lock to take', async () => {
  const res = await beat('locks/nothing/mill-house', editor);

  expect(res.status).toBe(404);
});

test('an editor cannot invite, change a role, resend an invite or remove anybody', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];
  siteMailer = fakeMailer;

  const invited = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, editor);
  const roled = await memberPost('members/u2/role', { role: 'owner' }, editor);
  const resent = await memberPost('members/u2/invite', {}, editor);
  const removed = await memberDelete('members/u2', editor);

  expect([invited.status, roled.status, resent.status, removed.status]).toEqual([
    403, 403, 403, 403,
  ]);
  expect(calls.createUser).toEqual([]);
  expect(calls.setRole).toEqual([]);
  expect(calls.removeUser).toEqual([]);
  expect(sent).toEqual([]);
});

test('an invite creates one row and mails exactly one address', async () => {
  siteMailer = fakeMailer;

  const res = await memberPost('members', { email: ' Lea@Example.com ', role: 'editor' }, owner);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, to: 'lea@example.com' });
  expect(calls.createUser).toEqual([
    { body: { email: 'Lea@Example.com', name: '', role: 'editor' }, invite: true },
  ]);
  expect(calls.signInMagicLink).toEqual([
    { body: { email: 'lea@example.com', callbackURL: '/admin/account' }, invite: true },
  ]);
});

// The endpoint also takes a `data` record that writes user columns directly, so a body spread
// into it would let an invite set `banned`, `emailVerified` or a role it was refused.
test('an invite carries the three values it is allowed to and nothing else the body holds', async () => {
  siteMailer = fakeMailer;

  const res = await memberPost(
    'members',
    {
      email: 'lea@example.com',
      role: 'editor',
      data: { role: 'owner', banned: true },
      name: 'Lea',
    },
    owner,
  );

  expect(res.status).toBe(200);
  expect(calls.createUser?.[0]?.body).toEqual({
    email: 'lea@example.com',
    name: '',
    role: 'editor',
  });
});

// `setRole` takes an array and stores it joined with commas; `hasPermission` splits on the
// comma and grants on any segment, while `roleOf` reads the whole string and sees an editor.
// So `owner,editor` is an owner Better Auth honours and a screen that shows Editor.
test('a role sent as an array is refused rather than stored', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];
  siteMailer = fakeMailer;

  const invited = await memberPost(
    'members',
    { email: 'lea@example.com', role: ['owner', 'editor'] },
    owner,
  );
  const roled = await memberPost('members/u2/role', { role: ['owner', 'editor'] }, owner);

  expect([invited.status, roled.status]).toEqual([400, 400]);
  expect(calls.createUser).toEqual([]);
  expect(calls.setRole).toEqual([]);
});

test('an invite with no mailer names the credential that is missing and writes nothing', async () => {
  siteMailer = { provider: 'resend', from: 'Handover <admin@example.com>' };

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('RESEND_API_KEY');
  expect(calls.createUser).toEqual([]);
});

// The row is written before the mail is tried, so the screen's failure notice can tell the
// owner to fix the mailer and resend rather than to invite the same person twice.
test('an invite whose mail fails leaves the row, and names no link', async () => {
  siteMailer = fakeMailer;
  magicLinkRefusal = new Error(
    'Resend refused the message (403): https://demo.example/x?token=abc',
  );

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);
  const body = (await res.json()) as { error: string; to: string };

  expect(res.status).toBe(502);
  expect(body).toEqual({ error: 'invite-not-sent', to: 'lea@example.com' });
  expect(calls.createUser ?? []).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain('token=');
});

test("an invite to somebody who is already a member comes back in Better Auth's own words", async () => {
  siteMailer = fakeMailer;
  createUserRefusal = {
    body: {
      code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      message: 'User already exists. Use another email.',
    },
  };

  const res = await memberPost('members', { email: 'anna@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(
    'User already exists. Use another email.',
  );
  expect(calls.signInMagicLink).toEqual([]);
});

test('an invite is only resent to somebody who has never signed in', async () => {
  memberRows = [
    member('u2', 'anna@example.com', 'editor'),
    member('u3', 'lea@example.com', 'editor', { pending: true, method: null, lastSignIn: null }),
  ];
  siteMailer = fakeMailer;

  const active = await memberPost('members/u2/invite', {}, owner);
  const pending = await memberPost('members/u3/invite', {}, owner);
  const nobody = await memberPost('members/u9/invite', {}, owner);

  expect([active.status, pending.status, nobody.status]).toEqual([400, 200, 404]);
  expect(calls.signInMagicLink).toEqual([
    { body: { email: 'lea@example.com', callbackURL: '/admin/account' }, invite: true },
  ]);
});

test('the last owner cannot be demoted', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberPost('members/u1/role', { role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('There must be at least one owner');
  expect(calls.setRole).toEqual([]);
});

test('demoting an owner goes through the statement that holds the rule', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberPost('members/u2/role', { role: 'editor' }, owner);

  expect(res.status).toBe(200);
  expect(demoted).toEqual(['u2']);
  // Not `setRole`: it would write the column behind a count another request can change.
  expect(calls.setRole).toEqual([]);
});

test('promoting an editor is still Better Auth setting the role', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberPost('members/u2/role', { role: 'owner' }, owner);

  expect(res.status).toBe(200);
  expect(calls.setRole).toEqual([{ body: { userId: 'u2', role: 'owner' }, invite: false }]);
  expect(demoted).toEqual([]);
});

// The guard, aimed at directly. Its premise is synthetic: reaching this route needs an owner
// session, so if there is one owner the caller *is* them and the self-check answers first. The
// database cannot produce a caller who is an owner and is not the owner — what this pins is
// that the rule is stated on the route rather than emerging from a different one.
test('the last owner is refused even to a caller who is not them', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u1', { ...owner, user: { ...owner.user, id: 'u2' } });

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('There must be at least one owner');
  expect(calls.removeUser).toEqual([]);
});

test('an owner cannot remove themselves, even when they are not the last one', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberDelete('members/u1', owner);

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('You cannot remove yourself');
  expect(calls.removeUser).toEqual([]);
});

test('removing somebody else takes their sessions and accounts with them', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u2', owner);

  expect(res.status).toBe(200);
  expect(calls.removeUser).toEqual([{ body: { userId: 'u2' }, invite: false }]);
  // The entries they had open go quiet with the account, rather than two minutes later.
  expect(released).toEqual(['u2']);
  // An editor is nobody's last owner, so nothing is taken out of the count first.
  expect(demoted).toEqual([]);
});

// The removal asks for the owner slot before it asks for the row, so two owners removing each
// other cannot both be told yes.
test('removing an owner takes them out of the count before it deletes them', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberDelete('members/u2', owner);

  expect(res.status).toBe(200);
  expect(demoted).toEqual(['u2']);
  expect(calls.removeUser).toEqual([{ body: { userId: 'u2' }, invite: false }]);
});

test('a member id the request made up is a 404, not a 500', async () => {
  memberRows = [member('u1', 'martin@example.com', 'owner')];

  const roled = await memberPost('members/u9/role', { role: 'editor' }, owner);
  const removed = await memberDelete('members/u9', owner);

  expect([roled.status, removed.status]).toEqual([404, 404]);
});

// ─── what reaches the activity log ───────────────────────────────────────────────────────

test('an invite is an invite event naming who invited whom', async () => {
  siteMailer = fakeMailer;

  await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'invite',
      subject: 'new',
      detail: { email: 'lea@example.com', role: 'editor' },
    },
  ]);
});

// The row exists whether or not the message went, so the log says so too — and the link that
// was minted for it is in neither the answer nor the row.
test('an invite whose mail fails is still an invite event, and carries no link', async () => {
  siteMailer = fakeMailer;
  magicLinkRefusal = new Error('https://x/admin/api/auth/magic-link/verify?token=SECRET_TOKEN');

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(502);
  expect(logged.map((e) => e.kind)).toEqual(['invite']);
  expect(JSON.stringify(logged)).not.toContain('SECRET_TOKEN');
});

test('an invite that was refused is no event at all', async () => {
  siteMailer = fakeMailer;
  createUserRefusal = { body: { code: 'USER_ALREADY_EXISTS', message: 'User already exists' } };

  await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(logged).toEqual([]);
});

test('promoting somebody is a role-change event', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  await memberPost('members/u2/role', { role: 'owner' }, owner);

  expect(logged).toEqual([
    { userId: 'u1', kind: 'role-change', subject: 'u2', detail: { role: 'owner' } },
  ]);
});

// Demotion is the branch that goes through `demoteOwner` rather than `setRole`, so it is the
// one a log line hung off Better Auth's endpoint would miss.
test('demoting an owner is a role-change event too', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'kim@example.com', 'owner'),
  ];

  await memberPost('members/u2/role', { role: 'editor' }, owner);

  expect(logged).toEqual([
    { userId: 'u1', kind: 'role-change', subject: 'u2', detail: { role: 'editor' } },
  ]);
});

test('a role change the last-owner rule refuses is no event', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberPost('members/u1/role', { role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(logged).toEqual([]);
});

test('setting a first password is a password-set event for the person who set it', async () => {
  await POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'a-password-of-twelve' }),
      }),
      { handover: editor },
    ),
  );

  expect(logged).toEqual([{ userId: 'u2', kind: 'password-set', detail: { how: 'first' } }]);
});

test('a password Better Auth refused is no event', async () => {
  setPassword = async () => {
    throw { body: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } };
  };

  await POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'short' }),
      }),
      { handover: editor },
    ),
  );

  expect(logged).toEqual([]);
});

test('a publish is a publish event carrying the commit and the file count', async () => {
  await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { files: 1 },
      commitSha: 'def456',
    },
  ]);
});

// Hazard 4: a Publish click with nothing pending must not spend a write. `publish-failed` and
// `publish-conflict` have no caller in this row either — a schema refusal is answered to the
// person who asked, in the same response.
test('a publish that commits nothing writes no event', async () => {
  publishDrafts.mockImplementationOnce(async () => undefined);

  await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(logged).toEqual([]);
});

test('a publish the schema refused writes no event', async () => {
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'rooms: 3\n', updatedAt: 1 },
  ]);

  const res = await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(res.status).toBe(422);
  expect(logged).toEqual([]);
});

// `params.path` is the route's own segment and the filters ride on the query string, so this
// one builds its context by hand rather than through `ctx`.
const activityGet = (query: string, session?: unknown) =>
  GET({
    params: { path: 'activity' },
    request: undefined,
    url: new URL(`https://x/admin/api/activity${query}`),
    locals: { handover: session },
  } as unknown as APIContext);

// The whole of `editor sees only their own`: the id is the session's and a `user` in the
// query is passed on for core to ignore, never swapped in for the caller.
test('the activity log is read as the signed-in person, whoever the query string names', async () => {
  await activityGet('?user=u1', editor);

  expect(read[0]).toEqual({ id: 'u2', role: 'editor' });
});

test('an editor may read the activity log', async () => {
  const res = await activityGet('', editor);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ events: [], cursor: null });
});

test('the filters and the cursor are passed on as they were asked for', async () => {
  await activityGet(
    '?group=Accounts&user=u3&entry=src/content/pages/en/about.yaml&cursor=5000.abc',
    owner,
  );

  expect(read[1]).toEqual({
    group: 'Accounts',
    user: 'u3',
    entry: 'src/content/pages/en/about.yaml',
    cursor: '5000.abc',
  });
});

// The row is gone by the time anybody reads this, so the address is in the event or it is
// nowhere: an id alone would name somebody nothing can look up.
test('removing a member is an event naming who was removed', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  await memberDelete('members/u2', owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'member-removed',
      subject: 'u2',
      detail: { email: 'anna@example.com', role: 'editor', pending: false },
    },
  ]);
});

test('revoking an invite nobody opened says it was still pending', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u3', 'lea@example.com', 'editor', { pending: true, method: null, lastSignIn: null }),
  ];

  await memberDelete('members/u3', owner);

  expect(logged[0]?.detail).toEqual({ email: 'lea@example.com', role: 'editor', pending: true });
});

test('a removal the last-owner rule refuses is no event', async () => {
  memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u1', { ...owner, user: { ...owner.user, id: 'u9' } });

  expect(res.status).toBe(400);
  expect(logged).toEqual([]);
});

test('removing somebody who is not there is no event', async () => {
  memberRows = [member('u1', 'martin@example.com', 'owner')];

  const res = await memberDelete('members/u9', owner);

  expect(res.status).toBe(404);
  expect(logged).toEqual([]);
});

// Take over is what makes the lock safe to lose: the person it was taken from finds out because
// the save their tab makes next is refused, not because a poll noticed.
test('an autosave from somebody who does not hold the lock is refused, naming who has it', async () => {
  holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };
  saveDraft.mockClear();

  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts', {
        method: 'PUT',
        body: JSON.stringify({ data }),
      }),
      { handover: editor },
    ),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    held_by: { id: 'u1', name: 'Anna Berg' },
    mine: false,
    expires_at: 1755864060000,
  });
  expect(saveDraft).not.toHaveBeenCalled();
});

test('the holder of the lock saves as they always did', async () => {
  holder = { userId: 'u2', name: 'Anna', expiresAt: 1755864060000 };

  const res = await PUT(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts', {
        method: 'PUT',
        body: JSON.stringify({
          data: { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } },
        }),
      }),
      { handover: editor },
    ),
  );

  expect(res.status).toBe(200);
});

test('Take over transfers the entry and says so in the log', async () => {
  holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await POST(
    ctx(
      'locks/listings/mill-house',
      new Request('https://x/admin/api/locks', {
        method: 'POST',
        body: JSON.stringify({ take: true }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toMatchObject({ held_by: null, mine: true, expires_at: 1755864120000 });
  expect(taken).toEqual(['listings/mill-house']);
  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'lock-takeover',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { from: 'Anna Berg' },
    },
  ]);
});

test('a beat is not a take-over, whatever else the body carries', async () => {
  holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await POST(
    ctx(
      'locks/listings/mill-house',
      new Request('https://x/admin/api/locks', {
        method: 'POST',
        body: JSON.stringify({ take: false }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toMatchObject({ mine: false });
  expect(taken).toEqual([]);
  expect(logged).toEqual([]);
});

test('a hold is written to every language the entry could have', async () => {
  locales = ['en', 'de'];

  const res = await POST(
    ctx(
      'hold/listings/mill-house',
      new Request('https://x/admin/api/hold', {
        method: 'POST',
        body: JSON.stringify({ hold: true }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toEqual({ held: true });
  expect(holdEntry).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    ['src/content/listings/en/mill-house.yaml', 'src/content/listings/de/mill-house.yaml'],
    'u2',
  );
  expect(logged).toEqual([]);
});

// Only the way off is an event: a hold is a promise to somebody else, and taking it off is the
// half they would want to read about afterwards.
test('taking a hold off clears the column and is logged', async () => {
  const res = await POST(
    ctx(
      'hold/listings/mill-house',
      new Request('https://x/admin/api/hold', {
        method: 'POST',
        body: JSON.stringify({ hold: false }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toEqual({ held: false });
  expect(holdEntry).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    ['src/content/listings/en/mill-house.yaml'],
    null,
  );
  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'hold-released',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: null,
    },
  ]);
});

test('the drawer reads the hold as the entry\u2019s, whichever of its files carries it', async () => {
  heldDrafts.mockResolvedValueOnce({
    'listings/mill-house': { id: 'u1', name: 'Anna Berg' },
  });

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: { id: 'u1', name: 'Anna Berg' },
      },
    ],
  });
});

// The checks a publish runs are about the files it is going to write, and a held entry is not
// one of them: a half-written draft somebody is holding back must not block everybody else's
// publish the way an unfinished one they are not holding back does.
test('a publish is checked against the files it will write, not the ones on hold', async () => {
  pendingDrafts.mockResolvedValueOnce([
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "Half written"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

// Selective publish. The body names entries and the server reads its own rows for them: the
// checks and the commit are made of the same set, and neither is made of what a browser sent.
const publishing = (body: string, session: Record<string, unknown> = owner) =>
  ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST', body }), {
    handover: session,
  });

test('a publish of a chosen set reads and commits exactly those entries', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockClear();

  const res = await POST(publishing(JSON.stringify({ entries: ['listings/mill-house'] })));

  expect(res.status).toBe(200);
  expect(readyDrafts).toHaveBeenCalledWith('default', expect.anything(), ['listings/mill-house']);
  expect(publishDrafts.mock.calls[0]?.[4]).toEqual(['listings/mill-house']);
});

// What the drawer sends: a POST with no body at all, which is not the same request as one
// carrying an empty string.
test('a publish with no body is still every entry that is ready', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockClear();

  const res = await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(res.status).toBe(200);

  expect(readyDrafts).toHaveBeenCalledWith('default', expect.anything(), undefined);
  expect(publishDrafts.mock.calls[0]?.[4]).toBe(undefined);
});

test('a publish that released a hold logs it against the person who set it', async () => {
  heldDrafts.mockResolvedValueOnce({ 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } });
  publishDrafts.mockImplementationOnce(async () => ({
    commit_sha: 'def456',
    paths: ['src/content/listings/en/mill-house.yaml'],
    released: ['listings/mill-house'],
  }));

  await POST(publishing(JSON.stringify({ entries: ['listings/mill-house'] })));

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'hold-released',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { from: 'Anna Berg' },
    },
    {
      userId: 'u1',
      kind: 'publish',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { files: 1 },
      commitSha: 'def456',
    },
  ]);
});

// The two refusals that are somebody else's work rather than the clicker's own drafts, and the
// only two a publish spends a write on.
test('a file that changed in the repository is logged as a conflict', async () => {
  const { DraftConflictError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new DraftConflictError(['src/content/listings/en/mill-house.yaml']);
  });

  const res = await POST(publishing(''));

  expect(res.status).toBe(409);
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish-conflict',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { files: 1 },
    },
  ]);
});

test('a branch that moved under the commit is logged as a failed publish', async () => {
  const { RefMovedError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new RefMovedError('main moved past abc123');
  });

  const res = await POST(publishing(''));

  expect(res.status).toBe(409);
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish-failed',
      subject: null,
      detail: { files: 1, reason: 'ref-moved' },
    },
  ]);
});

test('the build endpoint answers where the last commit has got to', async () => {
  const res = await GET(ctx('build'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'def456',
    state: 'building',
    started_at: 1755864100000,
    committed_at: 1755864000000,
  });
});

// Rule 3 of "your own publish must not look like a conflict": the rows go when the build
// carrying them is live, and this is the one moment the Worker learns that it is.
test('the rows a live build carries are cleared when it reports live', async () => {
  commitBuild.mockImplementationOnce(
    async (_cfg: unknown, commit: { sha: string } | undefined) => ({
      commit_sha: commit?.sha,
      state: 'live',
      started_at: 1755864100000,
    }),
  );
  await GET(ctx('build'));
  expect(clearPublished).toHaveBeenCalledWith('default', expect.anything(), 'def456');
});

// `committed_at` is what the pill's counter runs from, so an answer that is no longer about
// the commit must not carry it — 3.21 found a pill counting sixteen hours from a day-old
// publish. The build the answer *is* about brings its own `started_at`.
test('an answer that names no commit carries no committed_at', async () => {
  commitBuild.mockImplementationOnce(async () => ({
    state: 'live',
    started_at: 1755864100000,
    live_at: 1755864200000,
  }));
  expect(await (await GET(ctx('build'))).json()).toEqual({
    state: 'live',
    started_at: 1755864100000,
    live_at: 1755864200000,
  });
});

test('a build that is still running clears nothing', async () => {
  await GET(ctx('build'));
  expect(clearPublished).not.toHaveBeenCalled();
});

test('a site with no Cloudflare token draws no build status at all', async () => {
  cloudflareToken = undefined;
  const res = await GET(ctx('build'));
  expect(await res.json()).toEqual({});
  expect(commitBuild).not.toHaveBeenCalled();
});

// No commit of ours to ask about, but the site is serving something: the worker's newest build
// answers for it, with no commit_sha so nothing offers to revert a developer's own deploy.
test("a site that has published nothing reads the worker's newest build", async () => {
  lastCommitRow = undefined;
  expect(await (await GET(ctx('build'))).json()).toEqual({
    state: 'building',
    started_at: 1755864100000,
  });
  expect(commitBuild).toHaveBeenCalledWith(expect.anything(), undefined);
  expect(clearPublished).not.toHaveBeenCalled();
});

// An API that cannot be asked is the site's configuration rather than a state the site is in,
// so the pill goes away instead of claiming something.
test('an unreachable Workers Builds API answers as no build status', async () => {
  commitBuild.mockImplementationOnce(async () => {
    throw new Error('Cloudflare builds failed: 403');
  });
  const res = await GET(ctx('build'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test('revert undoes the commit the body names and logs it', async () => {
  const session = { user: { id: 'u1', name: 'Anna', email: 'a@x' }, role: 'editor' };
  const res = await POST(
    ctx(
      'revert',
      new Request('https://x/admin/api/revert', {
        method: 'POST',
        body: JSON.stringify({ commit_sha: 'def456' }),
      }),
      { handover: session },
    ),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'rev999',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(revertCommit).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'def456',
  );
  expect(logged.at(-1)).toMatchObject({
    kind: 'revert',
    commitSha: 'rev999',
    detail: { of: 'def456' },
  });
});

test('revert with no commit named is refused', async () => {
  const res = await POST(post('revert', '{}'));
  expect(res.status).toBe(400);
  expect(revertCommit).not.toHaveBeenCalled();
});

// The one thing an inverse composed against HEAD cannot decide on its own; the drawer says so
// on the panel the button sits on.
test('revert is 409 naming the file that has moved on since', async () => {
  const { RevertConflictError } = await import('@handover/core');
  revertCommit.mockImplementationOnce(async () => {
    throw new RevertConflictError(['src/content/listings/en/mill-house.yaml']);
  });
  const res = await POST(post('revert', JSON.stringify({ commit_sha: 'def456' })));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      'src/content/listings/en/mill-house.yaml has changed since that commit, so it cannot be put back',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
});

const HASH = 'a'.repeat(64);
const declared = JSON.stringify({
  hash: HASH,
  bytes: 12_345,
  mime: 'image/webp',
  filename: 'seaview.jpg',
  width: 2400,
  height: 1350,
});

// Step 3 of the upload flow: the free dedupe, and the reason the client hashes before it uploads.
test('bytes the site already holds are answered from the row, with nothing signed', async () => {
  findMedia.mockResolvedValueOnce({
    id: HASH,
    r2Key: `media/${HASH}.webp`,
    mime: 'image/webp',
    bytes: 12_345,
    width: 2400,
    height: 1350,
  });
  const res = await POST(post('media', declared));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    media: {
      id: HASH,
      src: `media/${HASH}.webp`,
      mime: 'image/webp',
      bytes: 12_345,
      width: 2400,
      height: 1350,
      url: `https://media.example.com/media/${HASH}.webp`,
    },
  });
});

test('a hash the site does not have is answered with a presigned PUT to its own key', async () => {
  const res = await POST(post('media', declared));
  expect(res.status).toBe(200);
  const { upload } = (await res.json()) as { upload: { key: string; url: string } };
  expect(upload.key).toBe(`media/${HASH}.webp`);
  const url = new URL(upload.url);
  expect(url.pathname).toBe(`/site-media/media/${HASH}.webp`);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});

test('a type the bucket does not serve is refused rather than signed', async () => {
  const res = await POST(
    post('media', JSON.stringify({ hash: HASH, bytes: 10, mime: 'text/html' })),
  );
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: expect.stringContaining('cannot be uploaded') });
});

test('a verified upload answers with the asset and is one line in the log', async () => {
  const res = await PUT(put(`media/${HASH}`, declared));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ media: { id: HASH, src: `media/${HASH}.webp` } });
  expect(confirmUpload).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    {
      accountId: 'acct-1',
      bucket: 'site-media',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
    },
    {
      hash: HASH,
      bytes: 12_345,
      mime: 'image/webp',
      filename: 'seaview.jpg',
      width: 2400,
      height: 1350,
    },
  );
  expect(logged.at(-1)).toMatchObject({
    kind: 'upload',
    subject: HASH,
    detail: { name: 'seaview.jpg', bytes: 12_345 },
  });
});

// Bytes the site already had are a reuse, not an upload: the row is answered and nothing is logged.
test('confirming bytes that were already there writes no second log line', async () => {
  confirmUpload.mockImplementationOnce(async () => ({
    media: {
      id: HASH,
      r2Key: `media/${HASH}.webp`,
      filename: 'seaview.jpg',
      mime: 'image/webp',
      bytes: 12_345,
      width: null,
      height: null,
    },
    created: false,
  }));
  await PUT(put(`media/${HASH}`, declared));
  expect(logged.filter((row) => row.kind === 'upload')).toEqual([]);
});

// The query is on the url rather than in the path, so this one builds its context by hand.
const library = (query: string) =>
  ({
    params: { path: 'media' },
    request: undefined,
    url: new URL(`https://x/admin/api/media${query}`),
    locals: {},
  }) as unknown as APIContext;

test('the picker is answered the library of the kind its field takes', async () => {
  mediaList.mockResolvedValueOnce([
    {
      id: HASH,
      r2Key: `files/${HASH}.pdf`,
      filename: 'brochure.pdf',
      mime: 'application/pdf',
      bytes: 2_481_033,
      width: null,
      height: null,
    },
  ]);
  const res = await GET(library('?kind=files'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    media: [
      {
        id: HASH,
        src: `files/${HASH}.pdf`,
        filename: 'brochure.pdf',
        mime: 'application/pdf',
        bytes: 2_481_033,
        width: null,
        height: null,
        url: `https://media.example.com/files/${HASH}.pdf`,
      },
    ],
  });
  expect(mediaList).toHaveBeenCalledWith('default', expect.anything(), 'files');
});

// An unknown kind is the pictures: a picker that asked for nothing is an image field.
test('the library defaults to the pictures', async () => {
  await GET(library(''));
  expect(mediaList).toHaveBeenCalledWith('default', expect.anything(), 'images');
});

test('a site that has not been told where its bucket is names all four values', async () => {
  bucketed = false;
  const res = await POST(post('media', declared));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({
    error: expect.stringContaining('R2_ACCOUNT_ID and R2_BUCKET in wrangler.jsonc'),
  });
});

// The drawer's expanded row: what one entry would put in the next commit, read against the
// repository as it is now rather than against the commit the draft was loaded from.
test('the expanded row is the draft against the file at HEAD, redirects riding along', async () => {
  rows['src/content/listings/en/mill-house.yaml'] = {
    contents: '_version: 1\ntitle: "The Mill House"\nlocation: "Bakewell"\nrooms: 4\n',
    baseSha: 'def456',
    baseBlob: 'abc123',
    pendingRedirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
  };

  const res = await GET(ctx('diff/listings/mill-house'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    groups: { locale?: string; changes: { label: string }[] }[];
    redirects: { from: string; to: string }[];
  };
  expect(body.groups.map((g) => g.locale)).toEqual(['en']);
  expect(body.groups[0]?.changes.map((c) => c.label)).toEqual(['Rooms']);
  expect(body.redirects).toEqual([{ from: '/listings/mill', to: '/listings/mill-house' }]);
});

// The three-way view behind Resolve. What the route owes: the entry's files, both languages
// or one, and a refusal that says the conflict is already settled rather than 404.
test('the three-way view asks about every language of the entry', async () => {
  locales = ['en', 'de'];
  entryConflict.mockResolvedValue({
    head: 'commit-B',
    sides: {},
    conflicted: { en: { path: 'src/content/listings/en/mill-house.yaml', blob: 'b1' } },
    questions: [{ path: 'rooms', label: 'Rooms', locale: 'en', base: '3' }],
    merged: [{ label: 'Location', side: 'theirs' }],
  });

  const res = await GET(ctx('conflict/listings/mill-house'));

  expect(res.status).toBe(200);
  expect(entryConflict).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ fields: expect.anything() }),
    {
      en: 'src/content/listings/en/mill-house.yaml',
      de: 'src/content/listings/de/mill-house.yaml',
    },
  );
  expect(await res.json()).toEqual({
    head: 'commit-B',
    questions: [{ path: 'rooms', label: 'Rooms', locale: 'en', base: '3' }],
    merged: [{ label: 'Location', side: 'theirs' }],
    files: ['src/content/listings/en/mill-house.yaml'],
  });
});

test('a conflict somebody has already settled is refused rather than drawn', async () => {
  const res = await GET(ctx('conflict/listings/mill-house'));

  expect(res.status).toBe(409);
  expect((await GET(ctx('conflict/nothing/at-all'))).status).toBe(404);
});

// Every question or none: written half-answered, the fields nobody reached would silently
// take the repository's value, which is not what leaving a question alone means.
const conflicted = () => {
  entryConflict.mockResolvedValue({
    head: 'commit-B',
    sides: {},
    conflicted: { en: { path: 'src/content/listings/en/mill-house.yaml', blob: 'b1' } },
    questions: [
      { path: 'rooms', label: 'Rooms', locale: 'en' },
      { path: 'location', label: 'Location', locale: 'en' },
    ],
    merged: [],
  });
};
const answers = (list: unknown) =>
  post('conflict/listings/mill-house', JSON.stringify({ answers: list }));

test('the answers to a conflict are written for the entry', async () => {
  conflicted();
  const list = [
    { path: 'rooms', locale: 'en', side: 'ours' },
    { path: 'location', locale: 'en', side: 'theirs' },
  ];

  const res = await POST(answers(list));

  expect(res.status).toBe(200);
  expect(resolveConflict).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.objectContaining({ fields: expect.anything() }),
    expect.objectContaining({ head: 'commit-B' }),
    list,
  );
});

test('a half-answered conflict is refused and nothing is written', async () => {
  conflicted();

  const res = await POST(answers([{ path: 'rooms', locale: 'en', side: 'ours' }]));

  expect(res.status).toBe(409);
  expect(resolveConflict).not.toHaveBeenCalled();
  expect(
    (
      await POST(
        answers([
          { path: 'nothing', locale: 'en', side: 'ours' },
          { path: 'rooms', locale: 'en', side: 'ours' },
        ]),
      )
    ).status,
  ).toBe(409);
  expect(resolveConflict).not.toHaveBeenCalled();
});

// "Simulate conflict": the diagnostics button's endpoint. It writes to the repository, so what
// is proven here is that it only writes where a scratch entry can be made valid — a file the
// site's own content schema rejects would break the build behind it — and only for an owner.
test('the simulated conflict is made in a collection its schema can be filled in', async () => {
  publish.mockClear();

  const res = await POST(ctx('checks/conflict', undefined, { handover: owner }));

  expect(res.status).toBe(200);
  const body = (await res.json()) as { entry: string; path: string };
  // Named after the commit it is made against, so a second run does not land on the first
  // run's entry while the built index still knows nothing about it.
  expect(body.entry).toBe('listings/conflict-check-head789');
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    body.path,
    expect.objectContaining({ title: 'Conflict check', rooms: 0 }),
  );
  // The draft says one thing and the commit that follows it says another: that is the conflict.
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    body.path,
    // Two fields both sides write, so the answers can differ from each other.
    expect.objectContaining({ title: 'Your version', location: 'Yours here too' }),
  );
  expect(publish).toHaveBeenCalledWith(
    [
      {
        path: body.path,
        contents: expect.stringMatching(/The version in the code[\s\S]*And the code here too/),
      },
    ],
    expect.objectContaining({ base_sha: 'def456' }),
  );
});

test("simulating a conflict is the owner's, not an editor's", async () => {
  publish.mockClear();

  expect((await POST(ctx('checks/conflict', undefined, { handover: editor }))).status).toBe(403);
  expect(publish).not.toHaveBeenCalled();
});
