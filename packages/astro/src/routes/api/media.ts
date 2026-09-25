import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import { uses } from 'virtual:handover/index';
import type { MediaRow, Upload } from '@handover/core';
import {
  claimResource,
  claimUploadIntent,
  confirmUpload,
  deleteMedia,
  draftFiles,
  findMedia,
  finishUploadIntent,
  issueUploadIntent,
  logActivity,
  MAX_UPLOAD_BYTES,
  MediaUnavailableError,
  markUploadStored,
  mediaKey,
  mediaList,
  mediaUsage,
  mimeForMediaKey,
  namedBy,
  releaseResource,
  releaseUploadIntent,
  setMediaDetails,
  storedUploadIntent,
} from '@handover/core';
import type { RequestContext } from '../../environment.js';
import { mediaStore, NO_BUCKET } from '../../environment.js';
import { readJson } from './body.js';
import { entryHref, entryTitle } from './content.js';

interface UploadBucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string; contentDisposition?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string; contentDisposition?: string };
  } | null>;
  delete(key: string): Promise<void>;
}

function uploadBucket(): UploadBucket | undefined {
  return (env as { MEDIA_UPLOADS?: UploadBucket }).MEDIA_UPLOADS;
}

export const UPLOAD_KEY = /^uploads\/[0-9a-f-]{36}\/(?:media|files)\/[0-9a-f]{64}\.[a-z0-9]+$/;

const NO_UPLOAD_BUCKET =
  'No private upload bucket is configured: add an R2 binding named MEDIA_UPLOADS';

/** The key a content file stores, and where the asset is served from. */
function mediaItem(row: MediaRow) {
  const base = config.media?.publicBase?.replace(/\/$/, '');
  return {
    id: row.id,
    src: row.r2Key,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    // Centre is what an unframed picture looks like and what the column defaults to, on purpose.
    focal: [row.focalX ?? 0.5, row.focalY ?? 0.5],
    ...(base ? { url: `${base}/${row.r2Key}` } : {}),
  };
}

/** The asset as the library knows it; an upload's answer has none of this yet. */
function libraryItem(row: MediaRow, used: readonly string[] = []) {
  return {
    ...mediaItem(row),
    alt: row.alt,
    tags: row.tags ?? [],
    archived: row.archived === 1,
    createdAt: row.createdAt,
    // Addressed the way the sidebar addresses it, so the client can go from picture to page.
    uses: used.map((entry) => ({ entry, title: entryTitle(entry), href: entryHref(entry) })),
  };
}

/** Usage counts come from the build's map with today's drafts over it. */
export async function library(ctx: RequestContext, url: URL): Promise<Response> {
  const database = ctx.db();
  const kind = url.searchParams.get('kind') === 'files' ? 'files' : 'images';
  // Only the library shows what has been put away; a field is never offered it.
  const withArchived = url.searchParams.get('archived') === '1';
  const [rows, drafts] = await Promise.all([
    mediaList('default', database, {
      kind,
      q: url.searchParams.get('q') ?? undefined,
      withArchived,
    }),
    draftFiles('default', database),
  ]);
  const used = mediaUsage('default', uses, drafts);
  return Response.json({ media: rows.map((row) => libraryItem(row, used[row.r2Key])) });
}

/** None of this is content, so it goes on the row; archiving is never gated on usage. */
export async function describeMedia(
  ctx: RequestContext,
  id: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const body = (await readJson(request)) as
    | { tags?: unknown; alt?: unknown; archived?: unknown; focal?: unknown }
    | undefined;
  const tags = Array.isArray(body?.tags)
    ? [
        ...new Set(
          body.tags
            .filter((t): t is string => typeof t === 'string' && !!t.trim())
            .map((t) => t.trim()),
        ),
      ]
    : undefined;
  const alt = typeof body?.alt === 'string' ? body.alt.trim() : undefined;
  const archived = typeof body?.archived === 'boolean' ? body.archived : undefined;
  // A focal point outside 0..1 would crop off the photograph, so it is refused rather than clamped.
  const point = body?.focal;
  const focal =
    Array.isArray(point) &&
    point.length === 2 &&
    point.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
      ? ([point[0], point[1]] as [number, number])
      : undefined;
  if (point !== undefined && !focal)
    return Response.json(
      { code: 'MEDIA_METADATA_INVALID', error: 'a focal point is [x, y], each 0 to 1' },
      { status: 400 },
    );
  if (tags === undefined && alt === undefined && archived === undefined && focal === undefined)
    return Response.json(
      {
        code: 'MEDIA_METADATA_INVALID',
        error: 'send { tags }, { alt }, { archived } or { focal }',
      },
      { status: 400 },
    );
  const database = ctx.db();
  const row = await setMediaDetails('default', database, id, { tags, alt, archived, focal });
  if (!row) return Response.json({ code: 'MEDIA_NOT_FOUND', error: 'Not found' }, { status: 404 });
  // Putting an asset away is a decision about what the site offers, so only that is logged.
  if (archived !== undefined)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'media-archive',
      subject: id,
      detail: { archived, name: row.filename },
    });
  const drafts = await draftFiles('default', database);
  const used = mediaUsage('default', uses, drafts);
  return Response.json({ media: libraryItem(row, used[row.r2Key]) });
}

const places = (uses: readonly string[]) =>
  uses.length === 1 ? '1 place' : `${uses.length} places`;

/** Protect drafts, fresh repository content, and the snapshot this running bundle serves. */
export async function deleteAsset(
  ctx: RequestContext,
  id: string,
  session: App.Locals['handover'],
): Promise<Response> {
  const store = mediaStore();
  if (!store)
    return Response.json({ code: 'MEDIA_STORAGE_UNAVAILABLE', error: NO_BUCKET }, { status: 503 });
  const database = ctx.db();
  const row = await findMedia('default', database, id);
  if (!row || row.state === 'deleted')
    return Response.json({ code: 'MEDIA_NOT_FOUND', error: 'Not found' }, { status: 404 });
  const [tree, drafts] = await Promise.all([
    ctx.git().contentFiles(),
    draftFiles('default', database),
  ]);
  // Keep the current-content refusal distinct from usage only the repository/deployment has.
  const drafted = new Set(drafts.map((d) => d.path));
  const now = namedBy(row.r2Key, [...tree.filter((f) => !drafted.has(f.path)), ...drafts]);
  const live = [
    ...new Set([
      ...namedBy(row.r2Key, tree),
      ...(mediaUsage('default', uses, [])[row.r2Key] ?? []),
    ]),
  ].sort();
  if (now.length)
    return Response.json(
      {
        code: 'MEDIA_IN_USE',
        error: `This is used in ${places(now)} and cannot be deleted. Archive it instead — that hides it from the picker and keeps every page working.`,
        uses: now,
      },
      { status: 409 },
    );
  if (live.length)
    return Response.json(
      {
        code: 'MEDIA_PUBLISHED_IN_USE',
        error: `The published site still uses this in ${places(live)}. Publish the change that takes it out and wait for that deployment to be live, then it can be deleted.`,
        uses: live,
      },
      { status: 409 },
    );
  await deleteMedia('default', database, store, row);
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'media-delete',
    subject: id,
    detail: { name: row.filename, bytes: row.bytes },
  });
  return Response.json({ deleted: id });
}

/** Both halves of an upload declare against this; the url's hash wins over the body's. */
function declaredUpload(body: unknown, hash?: string): Upload | undefined {
  const sent = body as Record<string, unknown> | undefined;
  const id = hash ?? sent?.hash;
  if (typeof id !== 'string' || typeof sent?.bytes !== 'number' || typeof sent.mime !== 'string')
    return undefined;
  const size = (value: unknown) => (typeof value === 'number' ? value : undefined);
  return {
    hash: id,
    key: typeof sent.key === 'string' ? sent.key : undefined,
    bytes: sent.bytes,
    mime: sent.mime,
    filename: typeof sent.filename === 'string' ? sent.filename : undefined,
    width: size(sent.width),
    height: size(sent.height),
    // `derivedFrom` names an asset, so it is held to the same 64 hex characters every id is.
    derivedFrom:
      typeof sent.derivedFrom === 'string' && /^[0-9a-f]{64}$/.test(sent.derivedFrom)
        ? sent.derivedFrom
        : undefined,
  };
}

const UPLOAD_INGEST_MS = 60_000;
class UploadIngestTimeout extends Error {}

/** One question, not two: bytes the site already holds cost the client's uplink nothing. */
export async function askUpload(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const store = mediaStore();
  if (!store) return Response.json({ error: NO_BUCKET }, { status: 503 });
  if (!uploadBucket()) return Response.json({ error: NO_UPLOAD_BUCKET }, { status: 503 });
  const upload = declaredUpload(await readJson(request));
  if (!upload)
    return Response.json({ error: 'an upload declares { hash, bytes, mime }' }, { status: 400 });
  const known = await findMedia('default', ctx.db(), upload.hash);
  if (known && known.state !== 'deleting' && known.state !== 'deleted')
    return Response.json({ media: mediaItem(known) });
  if (known?.state === 'deleting') throw new MediaUnavailableError();
  const key = `uploads/${crypto.randomUUID()}/${mediaKey(upload)}`;
  const database = ctx.db();
  const user = session?.user.id ?? 'unknown';
  const claims: Awaited<ReturnType<typeof claimResource>>[] = [];
  try {
    claims.push(
      await claimResource('default', database, {
        subject: user,
        kind: 'upload-intents',
        cost: 1,
        limit: 30,
      }),
    );
    claims.push(
      await claimResource('default', database, {
        subject: 'site',
        kind: 'upload-intents',
        cost: 1,
        limit: 500,
      }),
    );
    claims.push(
      await claimResource('default', database, {
        subject: user,
        kind: 'upload-bytes',
        cost: upload.bytes,
        limit: 30 * 1024 * 1024,
      }),
    );
    claims.push(
      await claimResource('default', database, {
        subject: 'site',
        kind: 'upload-bytes',
        cost: upload.bytes,
        limit: 250 * 1024 * 1024,
      }),
    );
    await issueUploadIntent('default', database, {
      key,
      userId: user,
      hash: upload.hash,
      bytes: upload.bytes,
      mime: upload.mime,
    });
  } catch (error) {
    for (const claim of claims) await releaseResource('default', database, claim);
    throw error;
  }
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\/media$/, `/${key}`);
  url.search = '';
  return Response.json({ upload: { key, url: `${url.pathname}` } });
}

/** Authenticated ingestion is the only route into the private staging bucket. */
export async function ingestUpload(
  ctx: RequestContext,
  key: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const bucket = uploadBucket();
  if (!bucket) return Response.json({ error: NO_UPLOAD_BUCKET }, { status: 503 });
  const keyMime = mimeForMediaKey(key);
  if (!keyMime || !UPLOAD_KEY.test(key)) return new Response('Not found', { status: 404 });
  const user = session?.user.id ?? 'unknown';
  const intent = await claimUploadIntent('default', ctx.db(), key, user);
  if (!intent) return new Response('Not found', { status: 404 });
  const mime = intent.mime;
  if (keyMime !== mime || request.headers.get('content-type') !== mime) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return Response.json(
      { error: 'The uploaded content type differs from its declaration' },
      { status: 415 },
    );
  }
  const lengthHeader = request.headers.get('content-length');
  const declared = lengthHeader === null ? undefined : Number(lengthHeader);
  if (declared !== undefined && Number.isFinite(declared) && declared !== intent.bytes) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    if (declared > MAX_UPLOAD_BYTES)
      return Response.json({ error: 'Upload exceeds 10MB' }, { status: 413 });
    return Response.json(
      { error: 'The uploaded size differs from its declaration' },
      { status: 422 },
    );
  }
  if (intent.bytes > MAX_UPLOAD_BYTES) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return Response.json({ error: 'Upload exceeds 10MB' }, { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return Response.json({ error: 'The upload is empty' }, { status: 400 });
  }
  const data = new Uint8Array(intent.bytes);
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new UploadIngestTimeout()), UPLOAD_INGEST_MS);
  });
  try {
    try {
      while (true) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > data.byteLength) {
          await releaseUploadIntent('default', ctx.db(), key, user);
          return Response.json(
            { error: 'The uploaded size differs from its declaration' },
            { status: 422 },
          );
        }
        data.set(value, size - value.byteLength);
      }
    } finally {
      clearTimeout(timeout);
      void reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    if (error instanceof UploadIngestTimeout)
      return Response.json({ error: 'Upload ingestion timed out' }, { status: 408 });
    throw error;
  }
  if (size !== data.byteLength) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return Response.json(
      { error: 'The uploaded size differs from its declaration' },
      { status: 422 },
    );
  }
  try {
    await bucket.put(key, data, {
      httpMetadata: {
        contentType: mime,
        ...(mime === 'application/pdf' ? { contentDisposition: 'attachment' } : {}),
      },
    });
  } catch (error) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    throw error;
  }
  await markUploadStored('default', ctx.db(), key, user);
  return new Response(null, { status: 204 });
}

/** The object is read from the bucket, so the browser is not asked to be honest about it. */
export async function finishUpload(
  ctx: RequestContext,
  hash: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const store = mediaStore();
  if (!store) return Response.json({ error: NO_BUCKET }, { status: 503 });
  const upload = declaredUpload(await readJson(request), hash);
  if (!upload)
    return Response.json({ error: 'an upload declares { hash, bytes, mime }' }, { status: 400 });
  const database = ctx.db();
  if (!upload.key)
    return Response.json({ error: 'an upload declares its staging key' }, { status: 400 });
  const intent = await storedUploadIntent(
    'default',
    database,
    upload.key,
    session?.user.id ?? 'unknown',
  );
  if (
    !intent ||
    intent.hash !== upload.hash ||
    intent.bytes !== upload.bytes ||
    intent.mime !== upload.mime
  )
    return Response.json(
      { error: 'The upload declaration does not match its private staging intent' },
      { status: 422 },
    );
  const bucket = uploadBucket();
  if (!bucket) return Response.json({ error: NO_UPLOAD_BUCKET }, { status: 503 });
  const { media, created } = await confirmUpload('default', database, store, upload, {
    staging: {
      read: async (key) => {
        const object = await bucket.get(key);
        return object
          ? {
              data: new Uint8Array(await object.arrayBuffer()),
              mime: object.httpMetadata?.contentType ?? '',
              disposition: object.httpMetadata?.contentDisposition,
            }
          : undefined;
      },
      delete: (key) => bucket.delete(key),
    },
  });
  // Bytes the site already had are a reuse, not an upload, or every re-pick would fill the log.
  if (created)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'upload',
      subject: media.id,
      detail: { name: media.filename, bytes: media.bytes },
    });
  await finishUploadIntent('default', database, upload.key);
  return Response.json({ media: mediaItem(media) });
}
