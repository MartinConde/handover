import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { Db, EntryLocation, GitClient } from '@handover/core';
import {
  blankValues,
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
  return Response.json({
    ...formOf('default', formSchema(schema)),
    data: parseEntry('default', contents),
    pending: draft ? (await blobSha(draft.contents)) !== file?.blob_sha : false,
  });
}

// Autosave. No base comes from the browser: saveDraft reads it from git the first time it
// writes a row and keeps it afterwards.
async function autosave(collection: string, slug: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const data = schema.safeParse(body?.data);
  if (!data.success) return new Response('Bad request', { status: 400 });
  const saved = await saveDraft(
    'default',
    db(),
    gitClient(),
    entryPath(collection, slug),
    data.data as Record<string, unknown>,
  );
  return saved ? Response.json(saved) : new Response('Not found', { status: 404 });
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
 * The blanks matter — an autosave validates against the collection schema, so a required
 * field that is missing rather than empty would throw away everything typed after it.
 */
async function createEntry(collection: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { title?: unknown } | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const database = db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(schema));
  const values: Record<string, unknown> = {
    _version: FORMAT_VERSION,
    ...blankValues('default', fields),
  };
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

// One commit for every draft that differs from the repository, then the rows are gone:
// nothing keeps them, since the next open reads the file the publish just wrote.
async function publish(): Promise<Response> {
  const result = await publishDrafts('default', db(), gitClient());
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
