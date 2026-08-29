import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import loaders from 'virtual:handover/loaders';
import {
  type AstroContent,
  type ContentSource,
  draftFiles,
  draftSource,
  openDb,
  previewTarget,
  staticSource,
} from '@handover/core';
import { createAuth } from '../auth.js';

/**
 * The gate every preview response carries, rendered or refused. An SSR route putting draft
 * content on the client's own domain is a phishing primitive, so: never in a shared cache,
 * never in an index, framed only by the admin that opened it — `'self'`, since the admin is a
 * route on this same site — and never named as the referrer of a link somebody follows off it.
 */
export const GATE = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "frame-ancestors 'self'",
  // A draft page's links would otherwise hand the preview's address to every site they point at.
  'referrer-policy': 'no-referrer',
};

const answer = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { ...GATE, 'content-type': 'text/plain; charset=utf-8' },
  });

/** One page type: what gathers its data, and what renders it. `src/loaders/<name>.ts`. */
export interface PageModule {
  load?: (
    source: ContentSource,
    ctx: { locale: string; slug: string },
  ) => Promise<Record<string, unknown> | undefined>;
  Page?: unknown;
  loadIndex?: (
    source: ContentSource,
    ctx: { locale: string },
  ) => Promise<Record<string, unknown> | undefined>;
  Index?: unknown;
}

/** A component and the props its own `load()` built — what the route renders. */
export interface Rendered {
  Component: unknown;
  props: Record<string, unknown>;
}

interface Ctx {
  params: { path?: string };
  request: Request;
  url: URL;
  response: { headers: Headers };
}

// A draft is the editor's bytes, so the schema is the only thing standing between them and a
// half-rendered page. Globals are held to the one per file in `cms.config.ts`; a collection
// nothing declares a schema for is read as it stands, which is what the build does too.
class DraftInvalid extends Error {}

function schemaFor(
  collection: string,
  path: string,
): { safeParse: (d: unknown) => unknown } | undefined {
  const own = config.collections[collection]?.schema;
  if (own) return own;
  if (collection !== 'globals') return undefined;
  return config.globals?.[path.slice(path.lastIndexOf('/') + 1, -'.yaml'.length)];
}

function validate(collection: string, data: unknown, path: string): unknown {
  const schema = schemaFor(collection, path);
  if (!schema) return data;
  const parsed = schema.safeParse(data) as {
    success: boolean;
    data?: unknown;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error?.issues ?? [];
  throw new DraftInvalid(
    `${path} › ${issue?.path.join('.') || collection}: ${issue?.message ?? 'does not match the schema'}`,
  );
}

/**
 * Who may look, at what, and what it renders. The session is asked for here rather than in the
 * middleware because an admin session will not be the only answer this route takes — a share
 * link is a token scoped to one entry, which "signed in or 401" cannot express.
 *
 * The page is built by the site's own `load()` from a source whose reads are the drafts laid
 * over the build, and rendered by the component that loader names, so what comes back is the
 * page as it would be published rather than a second drawing of it. `astro:content` is passed
 * in: the package does not import it, the route file does.
 */
export async function preview(ctx: Ctx, astro: AstroContent<string>): Promise<Response | Rendered> {
  const session = await createAuth(ctx.url).api.getSession({ headers: ctx.request.headers });
  if (!session) return answer(401, 'Sign in to the admin to see a preview.');
  const path = `/${ctx.params.path ?? ''}`;
  const target = previewTarget('default', config.i18n, config.collections, path);
  if (!target) return answer(404, 'This site serves no page at that address.');

  const name = config.collections[target.collection]?.load;
  const page: PageModule | undefined = name ? loaders[name] : undefined;
  if (!page)
    return answer(
      500,
      `Collection "${target.collection}" has no loader: cms.config.ts needs load: "<name>" on it, for src/loaders/<name>.ts.`,
    );

  // An index page is the collection rather than one entry, so it is the loader's other pair.
  const index = target.address === undefined;
  const Component = index ? page.Index : page.Page;
  if (!Component || !(index ? page.loadIndex : page.load))
    return answer(
      500,
      `src/loaders/${name}.ts is asked for ${index ? "a collection's index" : 'an entry'} page and exports no ${index ? 'loadIndex and Index' : 'load and Page'}.`,
    );

  const db = openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
  const source = draftSource(
    'default',
    staticSource('default', astro),
    await draftFiles('default', db),
    validate,
  );

  try {
    const props = index
      ? await page.loadIndex?.(source, { locale: target.locale })
      : await page.load?.(source, { locale: target.locale, slug: target.address as string });
    if (!props) return answer(404, 'This site serves no page at that address.');
    for (const [key, value] of Object.entries(GATE)) ctx.response.headers.set(key, value);
    return { Component, props };
  } catch (error) {
    if (!(error instanceof DraftInvalid)) throw error;
    return answer(422, `This draft cannot be rendered:\n${error.message}`);
  }
}
