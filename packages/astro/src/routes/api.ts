import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { Db, EntryLocation, GitClient } from '@handover/core';
import {
  blobSha,
  collectionEntries,
  createDraft,
  createGitClient,
  DraftConflictError,
  deleteEntry,
  discardDraft,
  entryName,
  FORMAT_VERSION,
  formOf,
  loadDraft,
  openDb,
  overlayRows,
  parseEntry,
  pendingDrafts,
  publishDrafts,
  RefMovedError,
  recordDelete,
  recordRename,
  renameEntry,
  saveDraft,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { login } from '../auth.js';
import { formSchema } from '../index.js';
import { entryProblems } from '../problems.js';

function gitClient(): GitClient {
  const e = env as Record<string, string | undefined>;
  const [owner, repo] = (e.GITHUB_REPO ?? '').split('/');
  if (!e.GITHUB_APP_ID || !e.GITHUB_INSTALLATION_ID || !e.GITHUB_PRIVATE_KEY || !owner || !repo) {
    throw new Error(
      'GitHub App is not configured: set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY and GITHUB_REPO (owner/repo) with `wrangler secret put`',
    );
  }
  return createGitClient('default', {
    appId: e.GITHUB_APP_ID,
    installationId: e.GITHUB_INSTALLATION_ID,
    privateKey: e.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
    owner,
    repo,
    branch: e.GITHUB_BRANCH,
  });
}

function db(): Db {
  return openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
}

// Every entry lives in en/ until Phase 1 adds locales.
const entryPath = (collection: string, slug: string) => `src/content/${collection}/en/${slug}.yaml`;

// The draft is what the editor was last looking at, so it wins over the file. No sha goes
// to the browser: a publish commits the stored bytes and compares the bases server-side.
async function getEntry(collection: string, slug: string): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const path = entryPath(collection, slug);
  const [file, draft] = await Promise.all([
    gitClient().getFile(path),
    loadDraft('default', db(), path),
  ]);
  const contents = draft?.contents ?? file?.contents;
  if (contents === undefined) return new Response('Not found', { status: 404 });
  const data = parseEntry('default', contents);
  return Response.json({
    ...formOf('default', formSchema(schema)),
    data,
    pending: draft ? (await blobSha(draft.contents)) !== file?.blob_sha : false,
    problems: entryProblems(schema, data),
  });
}

// The `_` keys belong to the file, not to the form: `mergeEntry` reads them off the entry as
// it stands, so a browser posting `_status` must not be able to set it.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

/**
 * Autosave. A draft holds what the editor typed, whether the schema accepts it yet or not: a
 * new entry in a collection with a required `reference` has no way to satisfy it from a form
 * whose widget is read-only, and refusing the write would throw the typed text away. What is
 * missing comes back named instead, and the publish is where the schema decides.
 *
 * No base comes from the browser: saveDraft reads it from git the first time it writes a row
 * and keeps it afterwards.
 */
async function autosave(collection: string, slug: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const data = editable(body?.data);
  if (!data) return new Response('Bad request', { status: 400 });
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft('default', db(), gitClient(), entryPath(collection, slug), data);
  } catch (err) {
    // A shape the serialiser cannot write back — a nested array above all — leaves nothing to
    // store, so this one is still a refusal, with the reason rather than "Bad request".
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

// The titles come from the build, the pending edits from D1. Nothing here touches GitHub:
// listing a collection through the contents API is one request per file.
async function listEntries(collection: string): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const rows = await overlayRows('default', db(), index);
  return Response.json({ entries: collectionEntries('default', index, collection, rows) });
}

/** Every name the collection already uses, published or only drafted. */
async function takenNames(collection: string, database: Db): Promise<string[]> {
  const rows = await overlayRows('default', database, index);
  return collectionEntries('default', index, collection, rows).map((e) => e.id);
}

// Phase 2 turns `locales` into the configured list; today an entry is one file under en/.
const locationOf = (collection: string): EntryLocation => ({
  collection,
  route: config.collections[collection]?.route,
  locales: ['en'],
});

/**
 * A new entry is a draft, not a commit: nothing is in the repository until it is published,
 * which is what lets the file name stay editable and keeps an abandoned entry out of git.
 * It starts empty apart from its title — a field the schema requires is left absent rather
 * than guessed at, and the editor is shown what is still missing until the publish.
 */
async function createEntry(collection: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { title?: unknown } | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const database = db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(schema));
  const values: Record<string, unknown> = { _version: FORMAT_VERSION };
  if (fields.some((f) => f.path[0] === 'title' && f.type === 'text')) values.title = title;
  await createDraft('default', database, gitClient(), entryPath(collection, slug), values);
  return Response.json({ slug });
}

// The new name goes through the same derivation as a new entry's, so a rename can never
// produce a file name the CMS could not have created.
async function rename(collection: string, slug: string, request: Request): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { to?: unknown } | undefined;
  const database = db();
  const git = gitClient();
  const from = entryPath(collection, slug);
  const file = await git.getFile(from);
  if (!file) return new Response('Publish this entry before renaming it', { status: 409 });
  const taken = (await takenNames(collection, database)).filter((id) => id !== slug);
  const to = entryName('default', typeof body?.to === 'string' ? body.to : '', taken);
  if (to === slug) return Response.json({ slug });
  const { commit_sha } = await renameEntry('default', git, locationOf(collection), slug, to);
  await recordRename(
    'default',
    database,
    from,
    entryPath(collection, to),
    file.contents,
    commit_sha,
  );
  return Response.json({ slug: to, commit_sha });
}

// An entry that was never published has nothing to remove from the repository and no URL
// anyone could have followed, so it goes without a commit and without a redirect.
async function remove(collection: string, slug: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const git = gitClient();
  const database = db();
  const path = entryPath(collection, slug);
  if (!(await git.getFile(path))) {
    await discardDraft('default', database, path);
    return Response.json({});
  }
  const result = await deleteEntry('default', git, locationOf(collection), slug, collected.index);
  await recordDelete('default', database, path, result.commit_sha);
  return Response.json(result);
}

// The way out of a publish conflict: the entry gives up its draft and is read from the
// repository again on the next open. Taking theirs whole — picking field by field is later.
async function discard(collection: string, slug: string): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  await discardDraft('default', db(), entryPath(collection, slug));
  return Response.json({});
}

const ENTRIES = /^entries\/([\w-]+)$/;
const ENTRY = /^entries\/([\w-]+)\/([\w-]+)$/;
const DRAFT = /^drafts\/([\w-]+)\/([\w-]+)$/;
const RENAME = /^entries\/([\w-]+)\/([\w-]+)\/rename$/;

export const GET: APIRoute = async ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  if (params.path === 'drafts') {
    const rows = await pendingDrafts('default', db());
    return Response.json({
      files: rows.map((r) => ({ path: r.path, updated_at: r.updatedAt })),
    });
  }
  const entry = params.path?.match(ENTRY);
  if (entry) return getEntry(entry[1] ?? '', entry[2] ?? '');
  const list = params.path?.match(ENTRIES);
  if (list) return listEntries(list[1] ?? '');
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request }) => {
  const draft = params.path?.match(DRAFT);
  if (draft) return autosave(draft[1] ?? '', draft[2] ?? '', request);
  return new Response('Not found', { status: 404 });
};

// `src/content/<collection>/<locale>/<slug>.yaml`. redirects.yaml and the globals share the
// prefix and belong to no collection: there is no schema to hold them to.
const schemaFor = (path: string) => config.collections[path.split('/')[2] ?? '']?.schema;

/**
 * One commit for every draft that differs from the repository, then the rows are gone:
 * nothing keeps them, since the next open reads the file the publish just wrote.
 *
 * The schema decides here rather than at every keystroke, so a blank new entry cannot commit
 * a file the site's own content schema rejects and break the build behind it. The set is read
 * again inside publishDrafts; a draft written between the two reads is a window this phase
 * accepts, since the entry it belongs to is the one whose tab is doing the publishing.
 */
async function publish(): Promise<Response> {
  const database = db();
  const unready = (await pendingDrafts('default', database)).filter((row) => {
    const schema = schemaFor(row.path);
    return schema && row.contents
      ? entryProblems(schema, parseEntry('default', row.contents)).length > 0
      : false;
  });
  if (unready.length) {
    const paths = unready.map((r) => r.path);
    return Response.json(
      {
        error:
          paths.length === 1
            ? `${paths[0]} is missing something the schema needs`
            : `${paths.length} files are missing something the schema needs — ${paths.join(', ')}`,
        paths,
      },
      { status: 422 },
    );
  }
  const result = await publishDrafts('default', database, gitClient());
  return Response.json(result ?? { paths: [] });
}

// Every write that commits answers the same way when someone got there first.
async function committing(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // A conflict names its files as data as well as prose: the drawer badges those rows and
    // offers each one the way out. A ref that moved has no file to name.
    if (err instanceof DraftConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  if (params.path === 'publish') return committing(publish);
  const renamed = params.path?.match(RENAME);
  if (renamed) return committing(() => rename(renamed[1] ?? '', renamed[2] ?? '', request));
  const created = params.path?.match(ENTRIES);
  if (created) return createEntry(created[1] ?? '', request);
  return new Response('Not found', { status: 404 });
};

export const DELETE: APIRoute = async ({ params }) => {
  const draft = params.path?.match(DRAFT);
  if (draft) return discard(draft[1] ?? '', draft[2] ?? '');
  const entry = params.path?.match(ENTRY);
  if (entry) return committing(() => remove(entry[1] ?? '', entry[2] ?? ''));
  return new Response('Not found', { status: 404 });
};
