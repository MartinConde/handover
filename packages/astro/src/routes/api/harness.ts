import type { EmailSender, Mailer } from '@handover/core';
import type { APIContext } from 'astro';
import { vi } from 'vitest';
import type { HandoverConfig } from '../../index.js';

// The row GET should overlay; `rows` is the same keyed by path when the languages differ in state.
export type Row = {
  contents: string;
  baseSha: string;
  baseBlob: string;
  pendingRedirects?: { from: string; to: string }[];
};

export type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  pending: boolean;
  method: string | null;
  lastSignIn: number | null;
  invitedAt: number;
};

// The ~34 values a test reassigns wholesale (`x = ...`) between calling a route and asserting
// on it. One shared, mutable instance per test *file* (Vitest gives every test file its own
// fresh copy of this module): mock builders below close over `state` directly, and test bodies
// read and write `state.<name>` the same way -- a static import and the `vi.hoisted` dynamic
// import used for the mock builders resolve to the same module instance, so it's the same object
// either way (proven in this session by breaking `resetState` and watching state leak).
export type State = {
  draft: Row | undefined;
  locales: string[];
  translator: typeof translate | undefined;
  siteMailer: HandoverConfig['mailer'];
  resendKey: string | undefined;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  emailBinding: EmailSender | undefined;
  baseUrl: string | undefined;
  smtpRefusal: Error | undefined;
  deeplKey: string | undefined;
  settingsSecret: string | undefined;
  lastCommitRow: { sha: string; at: number; kind: string; by: string | null } | undefined;
  publishes: { entry: string; at: number; by: string | null }[];
  editors: Record<string, string | null>;
  hiddenLong: { path: string; since: string }[];
  siteChecks: { ignore?: string[] } | undefined;
  bucketed: boolean;
  uploadIntentAvailable: boolean;
  storeRefusal: Error | undefined;
  dbRefusal: Error | undefined;
  cloudflareToken: string | undefined;
  cloudflareWorker: string | undefined;
  setPassword: (args: unknown) => Promise<unknown>;
  facts: { hasPassword: boolean; sessions: unknown[] };
  memberRows: MemberRow[];
  read: unknown[];
  holder: { userId: string; name: string; expiresAt: number; tab?: string } | undefined;
  editing: Record<string, string[]>;
  holders: Record<string, { id: string; name: string | null }>;
  asked: unknown[];
  createUserRefusal: unknown;
  magicLinkRefusal: unknown;
  setRoleRefusal: unknown;
};

function defaultState(): State {
  return {
    draft: undefined,
    locales: ['en'],
    translator: translate,
    siteMailer: undefined,
    resendKey: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    emailBinding: undefined,
    baseUrl: undefined,
    smtpRefusal: undefined,
    deeplKey: undefined,
    settingsSecret: 'c2VjcmV0',
    lastCommitRow: { sha: 'def456', at: 1755864000000, kind: 'publish', by: 'Anna Berg' },
    publishes: [],
    editors: {},
    hiddenLong: [],
    siteChecks: undefined,
    bucketed: true,
    uploadIntentAvailable: true,
    storeRefusal: undefined,
    dbRefusal: undefined,
    cloudflareToken: 'cf-token',
    cloudflareWorker: 'acct/handover-demo',
    setPassword: async () => ({ status: true }),
    facts: { hasPassword: true, sessions: [] },
    memberRows: [],
    read: [],
    holder: undefined,
    editing: {},
    holders: {},
    asked: [],
    createUserRefusal: undefined,
    magicLinkRefusal: undefined,
    setRoleRefusal: undefined,
  };
}

// The containers every mock reads and mutates in place (never reassigned wholesale), so they
// are safe to share as plain module-level exports: each test *file* gets its own fresh copy
// of this module (Vitest isolates modules per test file), and within a file the mocks and the
// test bodies that index into `files['...'] = ...` etc. see the same object either way.
export const files: Record<string, string> = {};
export const blobs: Record<string, string> = {};
export const commitLog: Record<
  string,
  { sha: string; date: string; message: string; author?: string }[]
> = {};
export const rows: Record<string, Row> = {};
export const stored: Record<
  string,
  { value: string; hint: string; updatedAt: number; updatedBy: string | null }
> = {};
export type Call = { body: Record<string, unknown>; invite: boolean };
export const calls: Record<string, Call[]> = {
  createUser: [],
  signInMagicLink: [],
  setRole: [],
  removeUser: [],
};
export const logged: Record<string, unknown>[] = [];
export const committedBy: Record<string, string> = {};
export const demoted: string[] = [];
export const released: string[] = [];
export const beats: string[] = [];
export const taken: string[] = [];
export const moved: string[] = [];
export const dropped: string[] = [];
export const privateUploads: { key: string; bytes: number; type?: string }[] = [];
export const smtpCalls: { options: Record<string, unknown>; email: Record<string, unknown> }[] = [];
export const sent: { to: string; subject: string; text: string }[] = [];
export const fakeMailer: Mailer = async (message) => {
  sent.push(message);
  return { id: 'fake-1' };
};
export const HASH = 'a'.repeat(64);

// Everything `@handover/core` reads verbatim (no `let` behind it): built once per test file via
// `vi.hoisted`, exactly as the un-split file built it -- so vi.mock in each file's own
// `@handover/core` factory can still spread it in ahead of the per-file overrides below.
const {
  listing,
  presenter,
  page,
  article,
  notice,
  site,
  getFile,
  getBlob,
  getHead,
  getCommit,
  contentFiles,
  fileCommits,
  publish,
  saveDraft,
  createDraft,
  recordRenames,
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
  restoreDraft,
  translate,
  commitBuild,
  clearPublished,
  revertCommit,
  restoreCommit,
  deletedEntries,
  savedTemplates,
  findMedia,
  mediaList,
  draftFiles,
  deleteMedia,
  setMediaDetails,
  confirmUpload,
} = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  const { blocks, defineBlock, image, link, seo, seoDefaults } = await import('../../index.js');
  return {
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
    presenter: z.object({
      name: z.string(),
      portrait: image({ ratio: '1:1', max: 512 }).optional(),
    }),
    // Localized addresses per language, and the one collection that carries the SEO panel.
    article: z.object({ title: z.string(), slug: z.string().optional(), seo: seo.optional() }),
    // The collection with the link the pre-publish checks follow.
    // A refinement of the site's own: readiness reports what the schema says, not only what is required.
    notice: z.object({
      title: z.string().refine((title) => title.trim() !== 'TBD', 'Replace the placeholder title'),
      cta: link.optional(),
    }),
    // A global: the same editor path with no collection behind it; it also holds the SEO defaults.
    site: z
      .object({
        footerText: z.string(),
        phone: z.string().optional().meta({ i18n: 'duplicate' }),
        defaultSeo: seoDefaults.optional(),
      })
      .meta({
        label: { en: 'Site details', de: 'Website-Angaben' },
        description: 'Contact details and footer text',
      }),
    // The GitHub boundary: one file in the repo, nothing else.
    getFile: vi.fn(async (path: string, ref?: string) => {
      // `<ref>:<path>` is the file as one commit has it, which is what a version diff reads.
      const atRef = ref === undefined ? undefined : files[`${ref}:${path}`];
      if (atRef !== undefined) return { contents: atRef, blob_sha: `blob-${ref}-${path}` };
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
    // Which files the commit touched and its parent: what a restore and a publish diff ask.
    getCommit: vi.fn(
      async (
        sha: string,
      ): Promise<{ sha: string; parent?: string; message: string; paths: string[] }> => ({
        sha,
        message: 'Delete The Mill House',
        paths: ['src/content/listings/en/mill-house.yaml', 'src/content/redirects.yaml'],
      }),
    ),
    // Filled per test with blobs named by commit id.
    getBlob: vi.fn(async (sha: string) => blobs[sha]),
    // Every commit that touched one path, newest first; filled per test.
    fileCommits: vi.fn(
      async (path: string, { perPage = 30, page = 1 }: { perPage?: number; page?: number } = {}) =>
        (commitLog[path] ?? []).slice((page - 1) * perPage, page * perPage),
    ),
    // The one-request read the delete gate is made on; the walk is tested in core's git.test.ts.
    contentFiles: vi.fn<() => Promise<{ path: string; contents: string }[]>>(async () => []),
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
    // What a publish will write: `pendingDrafts` minus the held entries; the filter is core's.
    readyDrafts: vi.fn<
      (...args: unknown[]) => Promise<
        {
          path: string;
          contents: string;
          updatedAt: number;
          revision?: string;
          heldBy?: string | null;
        }[]
      >
    >(async () => [
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
    // The three-way view is proven in core; only the route's ask and its handling are tested here.
    entryConflict: vi.fn(async () => undefined as unknown),
    resolveConflict: vi.fn(async () => ({ paths: [] })),
    saveTranslated: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    setEntryLocales: vi.fn(async () => {}),
    setEntryStatus: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    restoreDraft: vi.fn<(...args: unknown[]) => Promise<{ paths: string[] }>>(async () => ({
      paths: [],
    })),
    setEntryAddress: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    // The provider behind the hook: whatever the site configured, seen from the route.
    translate: vi.fn(async (texts: string[], _from: string, to: string) =>
      texts.map((t) => `[${to}] ${t}`),
    ),
    recordRenames: vi.fn(async () => {}),
    recordDelete: vi.fn(async () => {}),
    recordOffer: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {}),
    // What the entry list lays over the index: the pending drafts plus what a commit left.
    overlayRows: vi.fn(async () => [] as { path: string; contents: string }[]),
    // The Workers Builds boundary; the mapping runs against a faked API in core's builds.test.ts.
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
    // The library lays these over the built scan; the overlay itself runs for real.
    draftFiles: vi.fn<(...args: unknown[]) => Promise<{ path: string; contents: string }[]>>(
      async () => [],
    ),
    // The D1-and-R2 boundary of a delete; the order it does the two in is core's own test.
    deleteMedia: vi.fn(async () => {}),
    setMediaDetails: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | undefined>>(
      async (...args: unknown[]) => ({
        id: args[2] as string,
        r2Key: `media/${args[2] as string}.webp`,
        filename: 'seaview.jpg',
        mime: 'image/webp',
        bytes: 12,
        width: 2400,
        height: 1600,
        alt: null,
        tags: null,
        archived: 0,
        createdAt: 1_755_000_000_000,
        ...(args[3] as Record<string, unknown>),
      }),
    ),
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
    restoreCommit: vi.fn(async () => ({
      commit_sha: 'res888',
      paths: ['src/content/listings/en/mill-house.yaml'],
    })),
    // The query is core's; what the route makes of the rows is tested here.
    deletedEntries: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(
      async () => [],
    ),
    // The template names the log remembers, per collection; the query is core's.
    savedTemplates: vi.fn<(...args: unknown[]) => Promise<string[]>>(async () => []),
  };
});

export {
  article,
  clearPublished,
  commitBuild,
  confirmUpload,
  contentFiles,
  createDraft,
  deletedEntries,
  deleteMedia,
  discardDraft,
  draftFiles,
  entryConflict,
  fileCommits,
  findMedia,
  getBlob,
  getCommit,
  getFile,
  getHead,
  heldDrafts,
  holdEntry,
  listing,
  mediaList,
  notice,
  overlayRows,
  page,
  pendingDrafts,
  presenter,
  publish,
  publishDrafts,
  readyDrafts,
  recordDelete,
  recordOffer,
  recordRenames,
  resolveConflict,
  resolveDrift,
  restoreCommit,
  restoreDraft,
  revertCommit,
  saveDraft,
  savedTemplates,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  setMediaDetails,
  site,
  translate,
};

export const state: State = defaultState();
export function resetState() {
  Object.assign(state, defaultState());
}

export function workerMailerMock() {
  return {
    LogLevel: { NONE: 4 },
    WorkerMailer: {
      send: async (options: Record<string, unknown>, email: Record<string, unknown>) => {
        smtpCalls.push({ options, email });
        if (state.smtpRefusal) throw state.smtpRefusal;
      },
    },
  };
}

export function indexMock() {
  return {
    preview: true,
    site: 'https://coastalhomes.example',
    // Only `posts/taken` has two languages, so it is the only entry the build can mark stale.
    stale: { 'posts/taken': ['de'] },
    texts: {},
    // The mill house's two languages and the cottage share the photo: two places, not three.
    uses: {
      'src/content/listings/en/mill-house.yaml': [`media/${'a'.repeat(64)}.webp`],
      'src/content/listings/de/mill-house.yaml': [`media/${'a'.repeat(64)}.webp`],
      'src/content/listings/en/seaview-cottage.yaml': [`media/${'a'.repeat(64)}.webp`],
    },
    // No `_id` anywhere: a hand-written starter is the file that arrives without any.
    templates: {
      listings: [
        {
          name: 'house',
          data: {
            _version: 1,
            title: 'New house',
            location: 'Devon',
            rooms: 4,
            address: { street: 'Somewhere' },
          },
        },
      ],
      pages: [
        {
          name: 'landing',
          // A hand-made starter may name a language; the entry made from it records its own.
          data: {
            _version: 1,
            _source: 'de',
            title: 'New page',
            blocks: [{ _type: 'hero', heading: 'Move to the coast' }],
          },
        },
      ],
    },
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
        {
          id: 'site',
          locales: { en: { title: 'site', path: 'src/content/globals/en/site.yaml' } },
        },
      ],
    },
  };
}

export function configMock() {
  return {
    default: {
      i18n: {
        get locales() {
          return state.locales;
        },
        defaultLocale: 'en',
        get translate() {
          return state.translator;
        },
      },
      get mailer() {
        return state.siteMailer;
      },
      media: { publicBase: 'https://media.example.com' },
      collections: {
        // Pages first and its blocks are required, so "Simulate conflict" has to walk past it.
        pages: { schema: page },
        listings: {
          schema: listing,
          route: '/listings/[slug]',
          index: '/listings',
          label: { en: 'homes', de: 'Häuser' },
          singular: { en: 'home', de: 'Haus' },
        },
        presenters: { schema: presenter, titleField: 'name' },
        posts: { schema: article, route: '/blog/[slug]', index: '/blog', localizedSlugs: true },
        notices: { schema: notice, route: '/notices/[slug]' },
      },
      globals: { site },
      get checks() {
        return state.siteChecks;
      },
    },
  };
}

export function cloudflareMock() {
  return {
    env: {
      GITHUB_APP_ID: '1',
      GITHUB_INSTALLATION_ID: '2',
      GITHUB_PRIVATE_KEY: 'key',
      GITHUB_REPO: 'acme/site',
      get DEEPL_API_KEY() {
        return state.deeplKey;
      },
      get HANDOVER_SETTINGS_KEY() {
        return state.settingsSecret;
      },
      get RESEND_API_KEY() {
        return state.resendKey;
      },
      get SMTP_USER() {
        return state.smtpUser;
      },
      get SMTP_PASS() {
        return state.smtpPass;
      },
      get EMAIL() {
        return state.emailBinding;
      },
      get HANDOVER_BASE_URL() {
        return state.baseUrl;
      },
      get CLOUDFLARE_API_TOKEN() {
        return state.cloudflareToken;
      },
      get CLOUDFLARE_WORKER() {
        return state.cloudflareWorker;
      },
      get R2_ACCOUNT_ID() {
        return state.bucketed ? 'acct-1' : undefined;
      },
      get R2_BUCKET() {
        return state.bucketed ? 'site-media' : undefined;
      },
      get R2_ACCESS_KEY_ID() {
        return state.bucketed ? 'AKIDEXAMPLE' : undefined;
      },
      get R2_SECRET_ACCESS_KEY() {
        return state.bucketed ? 'secret' : undefined;
      },
      get MEDIA_UPLOADS() {
        return state.bucketed
          ? {
              put: vi.fn(
                async (
                  key: string,
                  value: ArrayBufferView,
                  options?: { httpMetadata?: { contentType?: string } },
                ) => {
                  privateUploads.push({
                    key,
                    bytes: value.byteLength,
                    type: options?.httpMetadata?.contentType,
                  });
                },
              ),
              get: vi.fn(async () => null),
              delete: vi.fn(async () => {}),
            }
          : undefined;
      },
      DB: {},
    },
  };
}

export function authMock(original: Record<string, unknown>) {
  return {
    ...original,
    createAuth: (_url: URL, _ctx: unknown, options?: { invite?: true }) => {
      const record = (name: string) => async (args: { body: Record<string, unknown> }) => {
        calls[name]?.push({ body: args.body, invite: Boolean(options?.invite) });
        if (name === 'createUser') {
          if (state.createUserRefusal) throw state.createUserRefusal;
          return { user: { id: 'new', email: String(args.body.email).toLowerCase() } };
        }
        if (name === 'signInMagicLink' && state.magicLinkRefusal) throw state.magicLinkRefusal;
        if (name === 'setRole' && state.setRoleRefusal) throw state.setRoleRefusal;
        return { status: true };
      };
      return {
        api: {
          setPassword: (args: unknown) => state.setPassword(args),
          createUser: record('createUser'),
          signInMagicLink: record('signInMagicLink'),
          setRole: record('setRole'),
          removeUser: record('removeUser'),
        },
      };
    },
  };
}

export function coreMock(original: Record<string, unknown>) {
  return {
    ...original,
    claimResource: vi.fn(async () => ({ subject: 'u1', kind: 'test', windowAt: 0, cost: 1 })),
    releaseResource: vi.fn(async () => {}),
    claimCostlyOperation: async () => ({ owner: true }),
    completeCostlyOperation: async () => {},
    costlyOperationResult: async () => undefined,
    abandonCostlyOperation: async () => {},
    issueUploadIntent: async () => {},
    claimUploadIntent: async (_site: string, _db: unknown, key: string) =>
      state.uploadIntentAvailable
        ? {
            key,
            userId: 'u1',
            hash: key.match(/[0-9a-f]{64}/)?.[0] ?? HASH,
            bytes: key.includes(HASH) ? 12_345 : 4,
            mime: 'image/webp',
            state: 'pending',
          }
        : undefined,
    releaseUploadIntent: vi.fn(async () => {}),
    markUploadStored: async () => {},
    finishUploadIntent: async () => {},
    storedUploadIntent: async (_site: string, _db: unknown, key: string) => ({
      key,
      hash: key.match(/[0-9a-f]{64}/)?.[0] ?? HASH,
      bytes: key.includes(HASH) ? 12_345 : 4,
      mime: 'image/webp',
      state: 'stored',
    }),
    findOperation: async () => undefined,
    recentOperations: async () => [],
    beginOperation: async (_site: string, _db: unknown, intent: Record<string, unknown>) => ({
      id: 'operation-1',
      state: 'intent',
      commitSha: null,
      result: null,
      revisions: intent.revisions ?? {},
      baseSha: intent.baseSha,
    }),
    recoverOperationCommit: async () => undefined,
    markOperationCommitted: async () => {},
    finalizeOperation: async () => {},
    commitScope: async () => ({ kind: 'publish', allows: () => true }),
    reservePaths: async (_site: string, _db: unknown, paths: string[], operationId: string) => ({
      operationId,
      paths,
      token: 'reservation',
    }),
    releaseOperationPaths: async () => {},
    releasePaths: async () => {},
    openDraft: async (_site: string, _db: unknown, path: string) => rows[path] ?? state.draft,
    memberList: async () => state.memberRows,
    // The real UPDATE holds the rule and is core's; the route must ask it before removing anybody.
    demoteOwner: async (_site: string, _db: unknown, id: string) => {
      const memberRows = state.memberRows;
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
    // The real join is core's; the route must ask it and prefer its answer to git's.
    commitAuthors: async (_site: string, _db: unknown, shas: string[]) =>
      Object.fromEntries(
        shas.filter((sha) => sha in committedBy).map((sha) => [sha, committedBy[sha]]),
      ),
    activityPage: async (..._args: unknown[]) => {
      state.read = _args.slice(2);
      return { events: [], cursor: null };
    },
    accountFacts: async (..._args: unknown[]) => {
      state.asked = _args.slice(2);
      return state.facts;
    },
    claimLock: async (_site: string, _db: unknown, entry: string, userId: string, tab: string) => {
      beats.push(entry);
      const holder = state.holder;
      return holder && !(holder.userId === userId && (holder.tab ?? '') === tab)
        ? undefined
        : 1755864120000;
    },
    takeLock: async (_site: string, _db: unknown, entry: string) => {
      taken.push(entry);
      state.holder = undefined;
      return 1755864120000;
    },
    lockHolder: async () => {
      const holder = state.holder;
      return holder && { tab: '', ...holder };
    },
    heldEntries: async () => state.editing,
    lockHolders: async () => state.holders,
    // The real query is core's; the routes must ask it and prefer a draft row to its answer.
    publishedEntries: async () => state.publishes,
    // And the join that turns a draft's `updated_by` into a name, proven in core's own db.test.ts.
    draftEditors: async () => state.editors,
    lastHiddenLong: async () => state.hiddenLong,
    releaseLocks: async (_site: string, _db: unknown, userId: string) => {
      released.push(userId);
    },
    moveLock: async (_site: string, _db: unknown, from: string, to: string) => {
      moved.push(`${from} -> ${to}`);
    },
    dropLock: async (_site: string, _db: unknown, entry: string) => {
      dropped.push(entry);
    },
    createGitClient: vi.fn(() => ({
      getFile,
      getBlob,
      getHead,
      contentFiles,
      fileCommits,
      publish,
      getCommit,
    })),
    openDb: vi.fn(() => {
      if (state.dbRefusal) throw state.dbRefusal;
      return { query: { drafts: { findFirst: async () => undefined } } };
    }),
    checkStore: async () => {
      if (state.storeRefusal) throw state.storeRefusal;
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
        throw new Error(
          'HANDOVER_SETTINGS_KEY is not set: make one with `openssl rand -base64 32`',
        );
      stored[key] = { value, hint: value.slice(-4), updatedAt: 1755864000000, updatedBy: userId };
    },
    removeSetting: async (_site: string, _db: unknown, key: string) => {
      delete stored[key];
    },
    loadDraft: vi.fn(
      async (_site: string, _db: unknown, path: string) => rows[path] ?? state.draft,
    ),
    saveDraft,
    createDraft,
    createDrafts: async (
      site: string,
      database: unknown,
      git: unknown,
      files: { path: string; values: Record<string, unknown> }[],
    ) => {
      for (const file of files) await createDraft(site, database, git, file.path, file.values);
    },
    recordRenames,
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
    restoreDraft,
    commitBuild,
    clearPublished,
    revertCommit,
    restoreCommit,
    deletedEntries,
    savedTemplates,
    findMedia,
    mediaList,
    draftFiles,
    deleteMedia,
    setMediaDetails,
    confirmUpload,
    lastCommit: async () => state.lastCommitRow,
  };
}

export function resetContainers() {
  for (const key of Object.keys(stored)) delete stored[key];
  for (const list of Object.values(calls)) list.length = 0;
  logged.length = 0;
  demoted.length = 0;
  released.length = 0;
  beats.length = 0;
  taken.length = 0;
  moved.length = 0;
  dropped.length = 0;
  privateUploads.length = 0;
  smtpCalls.length = 0;
  sent.length = 0;
  for (const path of Object.keys(files)) delete files[path];
  for (const sha of Object.keys(blobs)) delete blobs[sha];
  for (const path of Object.keys(commitLog)) delete commitLog[path];
  for (const sha of Object.keys(committedBy)) delete committedBy[sha];
  for (const path of Object.keys(rows)) delete rows[path];
}

export function resetMocks() {
  findMedia.mockClear();
  findMedia.mockResolvedValue(undefined);
  mediaList.mockClear();
  draftFiles.mockClear();
  draftFiles.mockResolvedValue([]);
  setMediaDetails.mockClear();
  deleteMedia.mockClear();
  confirmUpload.mockClear();
  contentFiles.mockClear();
  contentFiles.mockResolvedValue([]);
  commitBuild.mockClear();
  clearPublished.mockClear();
  revertCommit.mockClear();
  restoreCommit.mockClear();
  restoreDraft.mockClear();
  deletedEntries.mockClear();
  savedTemplates.mockClear();
  entryConflict.mockClear();
  entryConflict.mockResolvedValue(undefined);
  // A `…Once` nobody consumed outlives its test and is handed to the next caller.
  pendingDrafts.mockReset();
  publish.mockClear();
  setEntryStatus.mockClear();
  resolveConflict.mockClear();
}

export const owner = {
  user: { id: 'u1', name: 'Martin', email: 'martin@example.com' },
  role: 'owner',
};
export const editor = {
  user: { id: 'u2', name: 'Anna', email: 'anna@example.com' },
  role: 'editor',
};

// The fixture covers language-specific block structure.
export const home = {
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

// The German file as a publish of a translation leaves it.
export const translated = [
  '_version: 1',
  '_i18n:',
  '  sourceLocale: "en"',
  '  sourceBlob: "deadbeef"',
  '  sourceHash: "0000000000000000"',
  '  translatedAt: "2026-08-20T10:14:00Z"',
  'title: "Startseite"',
  'blocks:',
  '  - _type: "hero"',
  '    _id: "k3nf9a2p"',
  '    heading: "Zieh an die Küste"',
  '',
].join('\n');

export const ctx = (path: string, request?: Request, locals: Record<string, unknown> = {}) =>
  ({
    params: { path },
    request,
    url: new URL(`https://x/admin/api/${path}`),
    locals,
  }) as unknown as APIContext;
export const post = (path: string, body: string, session?: unknown) =>
  ctx(
    path,
    new Request(`https://x/admin/api/${path}`, { method: 'POST', body }),
    session ? { handover: session } : {},
  );
export const put = (path: string, body: string) => {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object')
      body = JSON.stringify({ revision: 'opened', ...parsed });
  } catch {}
  return ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'PUT', body }));
};
export const patch = (path: string, body: unknown, locals: Record<string, unknown> = {}) =>
  ctx(
    path,
    new Request(`https://x/admin/api/${path}`, { method: 'PATCH', body: JSON.stringify(body) }),
    locals,
  );
