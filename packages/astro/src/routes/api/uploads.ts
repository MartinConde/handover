import { env } from 'cloudflare:workers';
import type { Upload } from '@handover/core';
import {
  claimResource,
  claimUploadIntent,
  confirmUpload,
  findMedia,
  finishUploadIntent,
  issueUploadIntent,
  logActivity,
  MAX_UPLOAD_BYTES,
  MediaUnavailableError,
  markUploadStored,
  mediaKey,
  mimeForMediaKey,
  releaseResource,
  releaseUploadIntent,
  storedUploadIntent,
} from '@handover/core';
import type { RequestContext } from '../../environment.js';
import { mediaStore, NO_BUCKET } from '../../environment.js';
import { readJson } from './body.js';
import { mediaItem } from './media.js';
import { codedError, notFound } from './respond.js';

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

// Both halves of an upload declare against this; the url's hash wins over the body's.
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
  if (!store) return codedError(503, 'MEDIA_STORAGE_UNAVAILABLE', NO_BUCKET);
  const bucket = uploadBucket();
  if (!bucket) return codedError(503, 'MEDIA_UPLOAD_BUCKET_MISSING', NO_UPLOAD_BUCKET);
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
    await issueUploadIntent(
      'default',
      database,
      { key, userId: user, hash: upload.hash, bytes: upload.bytes, mime: upload.mime },
      { delete: (staged) => bucket.delete(staged) },
    );
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
  if (!bucket) return codedError(503, 'MEDIA_UPLOAD_BUCKET_MISSING', NO_UPLOAD_BUCKET);
  const keyMime = mimeForMediaKey(key);
  if (!keyMime || !UPLOAD_KEY.test(key)) return notFound();
  const user = session?.user.id ?? 'unknown';
  const intent = await claimUploadIntent('default', ctx.db(), key, user);
  if (!intent) return notFound();
  const mime = intent.mime;
  if (keyMime !== mime || request.headers.get('content-type') !== mime) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return codedError(
      415,
      'MEDIA_TYPE_MISMATCH',
      'The uploaded content type differs from its declaration',
    );
  }
  const lengthHeader = request.headers.get('content-length');
  const declared = lengthHeader === null ? undefined : Number(lengthHeader);
  if (declared !== undefined && Number.isFinite(declared) && declared !== intent.bytes) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    if (declared > MAX_UPLOAD_BYTES)
      return codedError(413, 'MEDIA_TOO_LARGE', 'Upload exceeds 10MB', { limit: MAX_UPLOAD_BYTES });
    return codedError(422, 'MEDIA_SIZE_MISMATCH', 'The uploaded size differs from its declaration');
  }
  if (intent.bytes > MAX_UPLOAD_BYTES) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return codedError(413, 'MEDIA_TOO_LARGE', 'Upload exceeds 10MB', { limit: MAX_UPLOAD_BYTES });
  }
  const reader = request.body?.getReader();
  if (!reader) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return codedError(400, 'MEDIA_EMPTY', 'The upload is empty');
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
          return codedError(
            422,
            'MEDIA_SIZE_MISMATCH',
            'The uploaded size differs from its declaration',
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
      return codedError(408, 'MEDIA_INGEST_TIMEOUT', 'Upload ingestion timed out');
    throw error;
  }
  if (size !== data.byteLength) {
    await releaseUploadIntent('default', ctx.db(), key, user);
    return codedError(422, 'MEDIA_SIZE_MISMATCH', 'The uploaded size differs from its declaration');
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
  if (!store) return codedError(503, 'MEDIA_STORAGE_UNAVAILABLE', NO_BUCKET);
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
  if (!bucket) return codedError(503, 'MEDIA_UPLOAD_BUCKET_MISSING', NO_UPLOAD_BUCKET);
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
