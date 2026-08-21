import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import type { GitClient } from '@handover/core';
import { createGitClient, fieldsFrom, type JsonSchema, parseEntry } from '@handover/core';
import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { login } from '../auth.js';

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

async function getEntry(collection: string, slug: string): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  // Every entry lives in en/ until Phase 1 adds locales.
  const file = await gitClient().getFile(`src/content/${collection}/en/${slug}.yaml`);
  if (!file) return new Response('Not found', { status: 404 });
  return Response.json({
    fields: fieldsFrom('default', z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema),
    data: parseEntry('default', file.contents),
    blob_sha: file.blob_sha,
  });
}

export const GET: APIRoute = async ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  const entry = params.path?.match(/^entries\/([\w-]+)\/([\w-]+)$/);
  if (entry) return getEntry(entry[1] ?? '', entry[2] ?? '');
  return new Response('Not found', { status: 404 });
};

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  return new Response('Not found', { status: 404 });
};
