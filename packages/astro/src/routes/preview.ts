import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import loaders from 'virtual:handover/loaders';
import {
  type AstroContent,
  ContentError,
  type ContentFile,
  type ContentSource,
  draftFiles,
  draftSource,
  entryAt,
  openDb,
  previewTarget,
  roleOf,
  staticSource,
} from '@handover/core';
import { createAuth } from '../auth.js';
import {
  CANVAS_PROTOCOL,
  canvasErrorDocument,
  errorManifest,
  type HandoverCanvas,
  serializeCanvasManifest,
  successManifest,
} from '../canvas.js';

/** Draft content on the client's own domain is a phishing primitive. */
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

const canvasAnswer = (
  status: number,
  message: string,
  request?: Pick<CanvasSnapshot, 'requestId' | 'epoch' | 'contentVersion'>,
) =>
  new Response(canvasErrorDocument(errorManifest(status, message, request)), {
    status,
    headers: { ...GATE, 'content-type': 'text/html; charset=utf-8' },
  });

const CANVAS_BODY_LIMIT = 5 * 1024 * 1024;
const NAME = /^[a-z0-9-]+$/;

interface CanvasSnapshot {
  mode: 'canvas';
  protocol: typeof CANVAS_PROTOCOL;
  requestId: string;
  epoch: string;
  entry: { collection: string; id: string };
  locale: string;
  contentVersion: number;
  snapshots: Record<string, Record<string, unknown>>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

function canvasSnapshot(value: unknown): CanvasSnapshot | undefined {
  if (!record(value)) return undefined;
  const keys = [
    'mode',
    'protocol',
    'requestId',
    'epoch',
    'entry',
    'locale',
    'contentVersion',
    'snapshots',
  ];
  if (!exactKeys(value, keys) || !record(value.entry) || !record(value.snapshots)) return undefined;
  if (!exactKeys(value.entry, ['collection', 'id'])) return undefined;
  const { collection, id } = value.entry;
  const configured =
    typeof collection === 'string' && Object.hasOwn(config.collections, collection);
  const identifiers =
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 200 &&
    typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    value.epoch.length <= 200;
  const locales = Object.entries(value.snapshots);
  if (
    value.mode !== 'canvas' ||
    value.protocol !== CANVAS_PROTOCOL ||
    !identifiers ||
    !configured ||
    typeof collection !== 'string' ||
    !NAME.test(collection) ||
    typeof id !== 'string' ||
    !NAME.test(id) ||
    id.length > 80 ||
    typeof value.locale !== 'string' ||
    !config.i18n.locales.includes(value.locale) ||
    !Number.isSafeInteger(value.contentVersion) ||
    (value.contentVersion as number) < 0 ||
    locales.length === 0 ||
    !Object.hasOwn(value.snapshots, value.locale) ||
    locales.some(([locale, data]) => !config.i18n.locales.includes(locale) || !record(data))
  )
    return undefined;
  return value as unknown as CanvasSnapshot;
}

async function limitedBody(request: Request): Promise<string | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CANVAS_BODY_LIMIT) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

async function canvasRequest(request: Request): Promise<CanvasSnapshot | Response> {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return canvasAnswer(403, 'Canvas requests must come from this site.');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
    return canvasAnswer(403, 'Canvas requests must come from this site.');
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  )
    return canvasAnswer(400, 'Canvas expected one form snapshot.');
  try {
    const body = await limitedBody(request);
    if (body === undefined) return canvasAnswer(413, 'The Canvas snapshot is larger than 5 MiB.');
    const form = new URLSearchParams(body);
    if ([...form.keys()].length !== 1 || !form.has('snapshot'))
      return canvasAnswer(400, 'Canvas expected one form snapshot.');
    const parsed = canvasSnapshot(JSON.parse(form.get('snapshot') ?? ''));
    return parsed ?? canvasAnswer(400, 'The Canvas snapshot envelope is invalid.');
  } catch {
    return canvasAnswer(400, 'The Canvas snapshot envelope is invalid.');
  }
}

function snapshotFiles(snapshot: CanvasSnapshot): ContentFile[] {
  return Object.entries(snapshot.snapshots).map(([locale, data]) => ({
    path: `src/content/${snapshot.entry.collection}/${locale}/${snapshot.entry.id}.yaml`,
    // JSON is valid YAML. Keep conversion schema-free so an unread locale cannot block this page.
    contents: JSON.stringify(data),
  }));
}

/** `src/loaders/<name>.ts`. */
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

export interface Rendered {
  Component: unknown;
  props: Record<string, unknown>;
  /** Escaped JSON consumed by the separately bundled Canvas runtime. */
  canvasManifest?: string;
}

interface Ctx {
  params: { path?: string };
  request: Request;
  url: URL;
  response: { headers: Headers };
  locals?: { handoverCanvas?: HandoverCanvas };
}

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
  throw new ContentError(
    `${path} › ${issue?.path.join('.') || collection}: ${issue?.message ?? 'does not match the schema'}`,
  );
}

/** The session is checked here, not in middleware. */
export async function preview(ctx: Ctx, astro: AstroContent<string>): Promise<Response | Rendered> {
  if (ctx.locals) delete ctx.locals.handoverCanvas;
  const session = await createAuth(ctx.url).api.getSession({ headers: ctx.request.headers });
  if (!session)
    return ctx.request.method === 'POST'
      ? canvasAnswer(401, 'Sign in to the admin to see a preview.')
      : answer(401, 'Sign in to the admin to see a preview.');
  let snapshot: CanvasSnapshot | undefined;
  if (ctx.request.method === 'POST') {
    if (!new Set(['editor', 'owner']).has(roleOf('default', session.user)))
      return canvasAnswer(403, 'This account cannot edit content.');
    const parsed = await canvasRequest(ctx.request);
    if (parsed instanceof Response) return parsed;
    snapshot = parsed;
  } else if (ctx.request.method !== 'GET') {
    return answer(405, 'Preview supports GET and Canvas POST requests.');
  }
  const fail = (status: number, message: string) =>
    snapshot ? canvasAnswer(status, message, snapshot) : answer(status, message);
  const path = `${(config.i18n.base ?? '').replace(/\/+$/, '')}/${ctx.params.path ?? ''}`;
  const target = previewTarget('default', config.i18n, config.collections, path);
  if (!target) return fail(404, 'This site serves no page at that address.');

  const name = config.collections[target.collection]?.load;
  const page: PageModule | undefined = name ? loaders[name] : undefined;
  if (!page)
    return fail(
      500,
      `Collection "${target.collection}" has no loader: cms.config.ts needs load: "<name>" on it, for src/loaders/<name>.ts.`,
    );

  const index = target.address === undefined;
  const Component = index ? page.Index : page.Page;
  if (!Component || !(index ? page.loadIndex : page.load))
    return fail(
      500,
      `src/loaders/${name}.ts is asked for ${index ? "a collection's index" : 'an entry'} page and exports no ${index ? 'loadIndex and Index' : 'load and Page'}.`,
    );

  const db = openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
  const transient = snapshot ? snapshotFiles(snapshot) : [];
  const source = draftSource(
    'default',
    staticSource('default', astro),
    [...transient, ...(await draftFiles('default', db))],
    validate,
  );

  try {
    let canvas: HandoverCanvas | undefined;
    if (snapshot) {
      const matchesRoute =
        !index &&
        target.collection === snapshot.entry.collection &&
        target.locale === snapshot.locale;
      const resolved = matchesRoute
        ? await entryAt(
            'default',
            source,
            config,
            target.collection,
            target.locale,
            target.address as string,
          )
        : undefined;
      const prefix = `${target.locale}/`;
      const resolvedId = resolved?.id.startsWith(prefix)
        ? resolved.id.slice(prefix.length)
        : undefined;
      if (resolvedId !== snapshot.entry.id)
        return canvasAnswer(
          409,
          'The Canvas snapshot does not match the entry served at this address.',
          snapshot,
        );
      canvas = {
        protocol: snapshot.protocol,
        requestId: snapshot.requestId,
        epoch: snapshot.epoch,
        entry: { ...snapshot.entry },
        locale: snapshot.locale,
        contentVersion: snapshot.contentVersion,
      };
      if (ctx.locals) ctx.locals.handoverCanvas = canvas;
    }
    const props = index
      ? await page.loadIndex?.(source, { locale: target.locale })
      : await page.load?.(source, { locale: target.locale, slug: target.address as string });
    if (!props) return fail(404, 'This site serves no page at that address.');
    for (const [key, value] of Object.entries(GATE)) ctx.response.headers.set(key, value);
    return {
      Component,
      props,
      ...(canvas ? { canvasManifest: serializeCanvasManifest(successManifest(canvas)) } : {}),
    };
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    return fail(422, `This draft cannot be rendered:\n${error.message}`);
  }
}
