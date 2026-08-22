import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import type { Db, GitClient } from '@handover/core';
import {
  blobSha,
  createGitClient,
  DraftConflictError,
  formOf,
  loadDraft,
  openDb,
  parseEntry,
  pendingDrafts,
  publishDrafts,
  RefMovedError,
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
  if (!file) return new Response('Not found', { status: 404 });
  return Response.json({
    ...formOf('default', formSchema(schema)),
    data: parseEntry('default', draft?.contents ?? file.contents),
    pending: draft ? (await blobSha(draft.contents)) !== file.blob_sha : false,
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

const ENTRY = /^entries\/([\w-]+)\/([\w-]+)$/;
const DRAFT = /^drafts\/([\w-]+)\/([\w-]+)$/;

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
  try {
    const result = await publishDrafts('default', db(), gitClient());
    return Response.json(result ?? { paths: [] });
  } catch (err) {
    if (err instanceof DraftConflictError || err instanceof RefMovedError)
      return new Response(err.message, { status: 409 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  if (params.path === 'publish') return publish();
  return new Response('Not found', { status: 404 });
};
