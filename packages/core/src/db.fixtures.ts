import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, vi } from 'vitest';
import { parse } from 'yaml';
import { type ContentIndex, collectionEntries, indexFrom } from './content/entries.js';
import type { Form } from './content/schema.js';
import { openDb } from './db.js';
import { overlayRows } from './drafts/drafts.js';
import { blobSha, type GitClient, type PublishFile } from './publishing/git.js';
import * as tables from './tables.js';
import { drafts } from './tables.js';

/** One in-memory D1 per test file; never share a Miniflare instance across files. */
export function newTestD1() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    d1Databases: { DB: ':memory:' },
  });
  afterAll(() => mf.dispose());
  return mf;
}

// Generated once per file: the reset below migrates before every test.
let ddl: Promise<string[]> | undefined;

// The same generator the client repo's `drizzle-kit generate` runs, against a real D1.
export async function migrateTestD1(binding: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  ddl ??= (async () =>
    generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      await generateSQLiteDrizzleJson({ ...tables }),
    ))();
  const statements = await ddl;
  await binding.batch(statements.map((sql) => binding.prepare(sql)));
}

/** Drop every table and migrate again, for files whose tests each need an empty database. */
export async function resetTestD1(binding: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  const rows = (await binding.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
    .results as { name: string }[];
  for (const { name } of rows.filter((r) => !/^(sqlite_|_cf_)/.test(r.name))) {
    await binding.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  await migrateTestD1(binding);
}

/** Bound to a test file's own `binding`, read live so it works whenever `beforeAll` finishes. */
export function draftDb(getBinding: () => Awaited<ReturnType<Miniflare['getD1Database']>>) {
  return async () => {
    const db = openDb('default', getBinding());
    await db.delete(drafts);
    await db.delete(tables.activity);
    await db.delete(tables.operations);
    await db.delete(tables.locks);
    return db;
  };
}

export const only = async (db: ReturnType<typeof openDb>) => (await db.select().from(drafts))[0];

// A file as it sits in the repo, with the two reserved keys no collection schema declares.
export const FILE =
  '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\nprice: "£950 per week"\nrooms: 3\n';
export const BLOB = '0a682b93c14fc8fe88c614f5a2581c38120d7f69'; // git hash-object of FILE
export const PATH = 'src/content/listings/en/mill-house.yaml';
// The form sends the schema's fields only — reserved keys are stripped by `schema.parse`.
export const VALUES = { title: 'The Mill House', price: '£950 per week', rooms: 3 };

export const git = {
  getHead: async () => 'commit-A',
  getFile: async (path: string) => (path === PATH ? { contents: FILE, blob_sha: BLOB } : undefined),
};

// A read with no ref is the branch, which `lag` can hold behind the last publish.
export function fakeRepo(files: Record<string, string>) {
  let head = 'commit-A';
  let n = 0;
  const behind: Record<string, string> = {};
  return {
    async getHead() {
      return head;
    },
    async getFile(path: string, ref?: string) {
      const contents = ref ? files[path] : (behind[path] ?? files[path]);
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    publish: vi.fn(async (list: { path: string; contents: string | null }[]) => {
      for (const f of list) if (f.contents !== null) files[f.path] = f.contents;
      head = `commit-${++n}`;
      return { commit_sha: head };
    }),
    write(path: string, contents: string) {
      files[path] = contents;
    },
    /** What a read of the branch still answers: the API serves one from a cache under its name. */
    lag(path: string, contents: string) {
      behind[path] = contents;
    },
    read(path: string) {
      return files[path] ?? '';
    },
  };
}

// An inverse reads the same path at three commits, so the fake above cannot stand in for one.
export function fakeHistory(initial: Record<string, string>) {
  const trees: Record<string, Record<string, string>> = { 'commit-0': { ...initial } };
  const commits: Record<string, { parent?: string; message: string; paths: string[] }> = {};
  let head = 'commit-0';
  let n = 0;
  const commit = (
    list: { path: string; contents: string | null }[],
    base: string,
    message: string,
  ) => {
    const tree = { ...trees[base] };
    for (const f of list) {
      if (f.contents === null) delete tree[f.path];
      else tree[f.path] = f.contents;
    }
    head = `commit-${++n}`;
    trees[head] = tree;
    commits[head] = { parent: base, message, paths: list.map((f) => f.path) };
    return head;
  };
  const descendsFrom = (candidate: string, ancestor: string) => {
    for (let at: string | undefined = candidate; at; at = commits[at]?.parent)
      if (at === ancestor) return true;
    return false;
  };
  return {
    async getHead() {
      return head;
    },
    async getFile(path: string, ref?: string) {
      const contents = trees[ref ?? head]?.[path];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    async getCommit(sha: string) {
      const found = commits[sha];
      if (!found) throw new Error(`no commit ${sha}`);
      return { sha, ...found };
    },
    async contentFiles(ref = head) {
      return Object.entries(trees[ref] ?? {}).map(([path, contents]) => ({ path, contents }));
    },
    async compareCommits(base: string, tip: string) {
      if (base === tip) return 'identical' as const;
      if (descendsFrom(tip, base)) return 'ahead' as const;
      if (descendsFrom(base, tip)) return 'behind' as const;
      return 'diverged' as const;
    },
    async fileCommits(path: string) {
      return Object.entries(commits)
        .filter(([, found]) => found.paths.includes(path))
        .toReversed()
        .map(([sha, found]) => ({
          sha,
          date: '2026-09-12T00:00:00Z',
          message: found.message,
        }));
    },
    publish: vi.fn(async (list, opts: { base_sha: string; message: string }) => ({
      commit_sha: commit(list, opts.base_sha, opts.message),
    })),
    /** A commit nobody here made: what moves a file on after a publish. */
    push(list: { path: string; contents: string | null }[]) {
      return commit(list, head, 'Someone else');
    },
    at(sha: string) {
      return trees[sha] ?? {};
    },
    now() {
      return trees[head] ?? {};
    },
  };
}

export const OTHER = 'src/content/listings/en/barn.yaml';
export const RENAMED = 'src/content/listings/en/the-old-mill.yaml';
export const OTHER_FILE = '_version: 1\ntitle: "The Barn"\nrooms: 1\n';

export const NEW = 'src/content/listings/en/strandhaus-nord.yaml';

// The structure is shared, so a block moved in English moves in German in the same write.
export const PAGE_EN = 'src/content/pages/en/home.yaml';
export const PAGE_DE = 'src/content/pages/de/home.yaml';
export const page = (title: string, first: string, second: string) =>
  [
    '_version: 1',
    `title: "${title}"`,
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    `    heading: "${first}"`,
    '  - _type: "cta"',
    '    _id: "q1w2e3r4"',
    `    heading: "${second}"`,
    '',
  ].join('\n');
export const PAGE_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'cta', 'quote'],
    },
  ],
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};
export const SYNC = { form: PAGE_FORM, locale: 'en', siblings: { de: PAGE_DE } };
export const block = (id: string) => ({ _type: id === 'k3nf9a2p' ? 'hero' : 'cta', _id: id });
export const MOVED = {
  title: 'Home',
  blocks: [
    { ...block('q1w2e3r4'), heading: 'Ready to move?' },
    { ...block('k3nf9a2p'), heading: 'Move to the coast' },
  ],
};

// A translation owns only its words; the rest is the file's (decap-cms#6978).
export const LISTING_DE = 'src/content/listings/de/mill-house.yaml';
export const GERMAN = [
  '_version: 1',
  'title: "Das Mühlenhaus"',
  'price: "£950 per week"',
  'blocks:',
  '  - _type: "hero"',
  '    _id: "k3nf9a2p"',
  '    heading: "Zieh an die Küste"',
  '  - _type: "cta"',
  '    _id: "q1w2e3r4"',
  '    heading: "Bereit für den Umzug?"',
  '',
].join('\n');

export const bilingual = () =>
  fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });

// The redirect an address owes cannot be committed until the entry is published.
export const REDIRECT = { from: '/de/home', to: '/de/startseite', entry: 'pages/home' };
// The address goes where the schema puts `slug`, not at the end of the file (F4 in 02-i18n.md).
export const ADDRESSED: Form = {
  ...PAGE_FORM,
  fields: [
    { path: ['slug'], label: 'Address', type: 'text', required: false },
    ...PAGE_FORM.fields,
  ],
};

export const HIDE_DE = { from: '/de/home', to: '/de/pages' };
export const HIDE_EN = { from: '/home', to: '/pages' };
export const ruleFor = async (db: ReturnType<typeof openDb>, path: string) =>
  (await db.select().from(drafts)).find((r) => r.path === path)?.pendingRedirects ?? [];

// The index as the last build made it: one build behind whatever a rename or delete commits.
export const indexOf = (files: Record<string, string>) =>
  indexFrom(
    'default',
    Object.entries(files).map(([path, contents]) => ({ path, contents })),
  );
export const listed = async (db: ReturnType<typeof openDb>, index: ContentIndex) =>
  collectionEntries('default', index, 'listings', await overlayRows('default', db, index)).map(
    (e) => [e.id, e.locales.en?.title],
  );

export async function seedPublishedRows(db: ReturnType<typeof openDb>, count: number) {
  const publishedSha = 'deployed-commit';
  const paths = Array.from({ length: count }, (_, i) => {
    const locale = ['en', 'de', 'fr'][i % 3];
    return `src/content/listings/${locale}/entry-${Math.floor(i / 3)}.yaml`;
  });
  const statements = paths.map((path, i) =>
    db.insert(drafts).values({
      siteId: 'default',
      path,
      revision: `revision-${i}`,
      contents: `_version: 1\ntitle: "Entry ${i}"\n`,
      baseSha: publishedSha,
      baseBlob: `blob-${i}`,
      updatedAt: i,
      publishedSha,
    }),
  );
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return { paths, publishedSha };
}

export const MILL_DE_FILE =
  '_version: 1\ntitle: "Die Muehle"\nprice: "950 GBP pro Woche"\nrooms: 3\n';

/** Pause a real D1 read after it completes; subsequent SQL still runs against the same DB. */
export function afterRead(
  binding: Awaited<ReturnType<Miniflare['getD1Database']>>,
  match: (query: string) => boolean,
  work: () => Promise<void>,
) {
  let waiting = true;
  const wrapped = new Proxy(binding, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string) => {
        const wrap = (
          statement: ReturnType<typeof binding.prepare>,
        ): ReturnType<typeof binding.prepare> =>
          new Proxy(statement, {
            get(stmt, method) {
              if (method === 'bind') return (...args: unknown[]) => wrap(stmt.bind(...args));
              const value = Reflect.get(stmt, method, stmt);
              if (typeof value !== 'function') return value;
              return async (...args: unknown[]) => {
                const result = await value.apply(stmt, args);
                if (waiting && match(query) && (method === 'raw' || method === 'all')) {
                  waiting = false;
                  await work();
                }
                return result;
              };
            },
          });
        return wrap(target.prepare(query));
      };
    },
  });
  return openDb('default', wrapped);
}

// Records every publish call and every read, with the commit it named.
export function fakeGit(files: Record<string, string>) {
  const published: { files: PublishFile[]; message: string; base_sha: string }[] = [];
  const read: { path: string; at?: string }[] = [];
  const git: GitClient = {
    request: () => Promise.reject(new Error('not used')),
    getHead: async () => 'commit-A',
    getCommit: () => Promise.reject(new Error('not used')),
    getBlob: () => Promise.reject(new Error('not used')),
    contentFiles: () => Promise.reject(new Error('not used')),
    compareCommits: () => Promise.reject(new Error('not used')),
    fileCommits: () => Promise.reject(new Error('not used')),
    getFile: async (path, at) => {
      read.push({ path, at });
      const contents = files[path];
      return contents === undefined ? undefined : { contents, blob_sha: `sha-of-${path}` };
    },
    publish: async (list, opts) => {
      published.push({ files: list, ...opts });
      return { commit_sha: 'commit-B' };
    },
  };
  return { git, published, read };
}

export const redirects = (files: PublishFile[]) =>
  parse(files.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '');

export const RULE = { _id: 'aaaaaaaa', status: 301 as const, createdAt: '2026-01-01T00:00:00Z' };
export const manual = (from: string, to: string, _id = 'bbbbbbbb') => ({
  ...RULE,
  _id,
  from,
  to,
  reason: 'manual' as const,
});
