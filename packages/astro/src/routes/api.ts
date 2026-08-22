import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import type { Db, GitClient } from '@handover/core';
import {
  blobSha,
  createGitClient,
  formOf,
  loadDraft,
  mergeEntry,
  openDb,
  parseEntry,
  RefMovedError,
  saveDraft,
  stringifyEntry,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
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

// The draft is what the editor was last looking at, so it wins over the file. head_sha is
// what a later PUT publishes on top of, so a publish in between is a 409, not a clobber.
async function getEntry(collection: string, slug: string): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const git = gitClient();
  const path = entryPath(collection, slug);
  const [file, head_sha, draft] = await Promise.all([
    git.getFile(path),
    git.getHead(),
    loadDraft('default', db(), path),
  ]);
  if (!file) return new Response('Not found', { status: 404 });
  return Response.json({
    ...formOf('default', formSchema(schema)),
    data: parseEntry('default', draft?.contents ?? file.contents),
    pending: draft ? (await blobSha(draft.contents)) !== file.blob_sha : false,
    blob_sha: file.blob_sha,
    head_sha,
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

const saveBody = z.object({ data: z.unknown(), base_sha: z.string().min(1) });

async function saveEntry(collection: string, slug: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = saveBody.safeParse(await request.json().catch(() => undefined));
  const data = body.success ? schema.safeParse(body.data.data) : undefined;
  if (!body.success || !data?.success) return new Response('Bad request', { status: 400 });
  const git = gitClient();
  const path = entryPath(collection, slug);
  // Read the file for its reserved keys, so a publish writes the same bytes an autosave does.
  const file = await git.getFile(path);
  const contents = stringifyEntry(
    'default',
    mergeEntry('default', file && parseEntry('default', file.contents), data.data as never),
  );
  try {
    const result = await git.publish([{ path, contents }], {
      base_sha: body.data.base_sha,
      message: `Update ${collection}/${slug}`,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    throw err;
  }
}

const ENTRY = /^entries\/([\w-]+)\/([\w-]+)$/;
const DRAFT = /^drafts\/([\w-]+)\/([\w-]+)$/;

export const GET: APIRoute = async ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  const entry = params.path?.match(ENTRY);
  if (entry) return getEntry(entry[1] ?? '', entry[2] ?? '');
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request }) => {
  const draft = params.path?.match(DRAFT);
  if (draft) return autosave(draft[1] ?? '', draft[2] ?? '', request);
  const entry = params.path?.match(ENTRY);
  if (entry) return saveEntry(entry[1] ?? '', entry[2] ?? '', request);
  return new Response('Not found', { status: 404 });
};

const publishBody = z.object({
  files: z.array(z.object({ path: z.string().min(1), contents: z.string() })).min(1),
  base_sha: z.string().min(1),
  message: z.string().min(1),
});

async function publish(request: Request): Promise<Response> {
  const parsed = publishBody.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return new Response('Bad request', { status: 400 });
  const { files, base_sha, message } = parsed.data;
  try {
    return Response.json(await gitClient().publish(files, { base_sha, message }));
  } catch (err) {
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  if (params.path === 'publish') return publish(request);
  return new Response('Not found', { status: 404 });
};
