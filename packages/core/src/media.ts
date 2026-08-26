import { AwsClient } from 'aws4fetch';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { media } from './tables.js';

/**
 * The S3 credentials the Worker signs uploads with. The bytes never pass through it — a
 * browser PUTs them straight to the bucket — so this is only ever used to sign, to look at
 * what arrived and to delete what should not have.
 */
export interface R2Store {
  /** The Cloudflare account the bucket is in; the S3 endpoint is named after it. */
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the browser says it is about to upload, and what the object is then held to. */
export interface Upload {
  /** sha-256 of the bytes, hex. The object is named by it, so it is also the row's id. */
  hash: string;
  bytes: number;
  mime: string;
  /** The name it was chosen under, kept for search rather than for addressing anything. */
  filename?: string;
  width?: number;
  height?: number;
}

export type MediaRow = typeof media.$inferSelect;

/** One cap for every field until field presets arrive; the client downscales long before it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The extension is the server's, from the type it will verify. A client's filename decides
// nothing: the bucket has its own domain, and what that domain serves is not a browser's to name.
const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const SHA256 = /^[0-9a-f]{64}$/;
/** Long enough for a slow phone on a train, short enough that a leaked url is worth nothing. */
const TTL = 300;

/** An upload the site will not take. The person who chose the file is told which rule it broke. */
export class UploadRefusedError extends Error {}

/**
 * `media/<sha256>.<ext>` — content-addressed, so the same bytes are one object however many
 * times they are uploaded, and immutable, so it can be cached forever.
 *
 * Everything that can be checked before a signature is checked here: an unsigned PUT is a
 * write to the bucket, and R2 cannot bind a size to one.
 */
export function mediaKey(upload: Upload): string {
  const ext = EXTENSIONS[upload.mime];
  if (!ext)
    throw new UploadRefusedError(
      `${upload.mime} cannot be uploaded: this field takes ${Object.keys(EXTENSIONS).join(', ')}`,
    );
  if (!SHA256.test(upload.hash))
    throw new UploadRefusedError('an upload is named by the sha-256 of its own bytes');
  if (!(upload.bytes > 0 && upload.bytes <= MAX_UPLOAD_BYTES))
    throw new UploadRefusedError(
      `an upload may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024}MB, and this one is ${Math.round(upload.bytes / 1024 / 1024)}MB`,
    );
  return `media/${upload.hash}.${ext}`;
}

/** The asset with these bytes, if the site already has it: the whole of the dedupe. */
export function findMedia(siteId: string, db: Db, id: string): Promise<MediaRow | undefined> {
  return db
    .select()
    .from(media)
    .where(and(eq(media.siteId, siteId), eq(media.id, id)))
    .limit(1)
    .then(([row]) => row);
}

const objectUrl = (store: R2Store, key: string) =>
  `https://${store.accountId}.r2.cloudflarestorage.com/${store.bucket}/${key}`;

const signer = (store: R2Store) =>
  new AwsClient({
    accessKeyId: store.accessKeyId,
    secretAccessKey: store.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

/**
 * A five-minute PUT straight to the bucket. Neither the size nor the type is in the signature —
 * R2 has no `content-length-range` and `aws4fetch` will not sign either header — so what the
 * url actually promises is one object, at one key, for five minutes. `confirmUpload` is the
 * enforcement.
 */
export async function presignUpload(store: R2Store, key: string): Promise<string> {
  const url = new URL(objectUrl(store, key));
  url.searchParams.set('X-Amz-Expires', String(TTL));
  const signed = await signer(store).sign(url.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
  });
  return signed.url;
}

const object = async (
  store: R2Store,
  key: string,
  method: string,
  fetch: typeof globalThis.fetch,
) => fetch(await signer(store).sign(objectUrl(store, key), { method }));

/**
 * Step 6: what arrived, against what was declared. A browser holds an unsigned PUT for five
 * minutes, so this is the only thing standing between the bucket and 12MB of anything — an
 * object that is not what was asked for is deleted rather than left for the reconciliation job,
 * and no row is written for it.
 *
 * **Bytes the site already has are answered from the table without touching the bucket.** That
 * is the dedupe, and it is also what stops a made-up declaration for a hash somebody else
 * uploaded deleting a good object.
 */
export async function confirmUpload(
  siteId: string,
  db: Db,
  store: R2Store,
  upload: Upload,
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<{ media: MediaRow; created: boolean }> {
  const { fetch = globalThis.fetch, now = Date.now() } = deps;
  const key = mediaKey(upload);
  const known = await findMedia(siteId, db, upload.hash);
  if (known) return { media: known, created: false };

  const head = await object(store, key, 'HEAD', fetch);
  if (head.status === 404)
    throw new UploadRefusedError('the upload never reached the bucket; nothing was stored');
  if (!head.ok) throw new Error(`R2 HEAD ${key} failed: ${head.status}`);
  const size = head.headers.get('content-length');
  // No size is not a verdict: there is nothing to hold the object to, and deleting on "could
  // not read it" would throw away a good upload.
  if (size === null) throw new Error(`R2 HEAD ${key} answered without a content-length`);
  const bytes = Number(size);
  const mime = head.headers.get('content-type') ?? '';
  if (bytes !== upload.bytes || mime !== upload.mime) {
    await object(store, key, 'DELETE', fetch);
    throw new UploadRefusedError(
      `what was uploaded is not what was declared — ${bytes} bytes of ${mime}, not ${upload.bytes} of ${upload.mime}. It has been deleted`,
    );
  }

  const [written] = await db
    .insert(media)
    .values({
      id: upload.hash,
      siteId,
      r2Key: key,
      filename: upload.filename ?? null,
      mime: upload.mime,
      bytes: upload.bytes,
      width: upload.width ?? null,
      height: upload.height ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  // Two tabs confirming the same bytes at the same moment: the one that lost reads the row.
  const stored = written ?? (await findMedia(siteId, db, upload.hash));
  if (!stored) throw new Error(`the media row for ${upload.hash} was not written`);
  return { media: stored, created: Boolean(written) };
}
