import { AwsClient } from 'aws4fetch';
import { and, desc, eq, like, not } from 'drizzle-orm';
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

/** One cap for every field and every type; the client downscales a picture long before it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What a field does to a picture: the ratio it crops to, the cap on the way in, the floor on the way out. */
export interface Preset {
  /** `'16:9'`, `'1:1'`, `'1.91:1'` — what the field shows, whatever shape the picture is. */
  ratio?: string;
  /** Longest side an upload is downscaled to in the browser, before a byte leaves it. */
  max?: number;
  /** Narrowest crop the picker will take, in width. A field without one refuses nothing. */
  min?: number;
}

/** Longest side an upload is stored at where its field asks for nothing narrower. */
export const DEFAULT_MAX = 2400;

const ratioOf = (ratio: string | undefined) => {
  const [w, h] = (ratio ?? '').split(':').map(Number);
  return w && h ? w / h : undefined;
};

/**
 * The width of the widest crop at this ratio the picture can yield, which is what a field's floor
 * is measured against: a 900 × 1600 phone photo passes any longest-side test at 1600 and still
 * only makes a 900 px hero.
 */
export function cropWidth(width: number, height: number, ratio?: string): number {
  const r = ratioOf(ratio);
  return Math.floor(r ? Math.min(width, height * r) : width);
}

/** Why this picture cannot go in this field, in both numbers; nothing where it can. */
export function tooSmall(preset: Preset, width: number, height: number): string | undefined {
  if (!preset.min) return undefined;
  const crop = cropWidth(width, height, preset.ratio);
  if (crop >= preset.min) return undefined;
  const what = preset.ratio
    ? `its widest ${preset.ratio} crop is ${crop} px`
    : `it is ${crop} px wide`;
  return `Too small for this field — ${what}, this field needs ${preset.min}`;
}

// The extension is the server's, from the type it will verify. A client's filename decides
// nothing: the bucket has its own domain, and what that domain serves is not a browser's to name.
const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

// A type whose bytes are worth reading back, because the name proves nothing and the CDN's own
// domain is what would serve a renamed file. Ascii signatures, compared as text.
const MAGIC: Record<string, string> = { 'application/pdf': '%PDF-' };

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
      `${upload.mime} cannot be uploaded: this site takes ${Object.keys(EXTENSIONS).join(', ')}`,
    );
  if (!SHA256.test(upload.hash))
    throw new UploadRefusedError('an upload is named by the sha-256 of its own bytes');
  if (!(upload.bytes > 0 && upload.bytes <= MAX_UPLOAD_BYTES))
    throw new UploadRefusedError(
      `an upload may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024}MB, and this one is ${Math.round(upload.bytes / 1024 / 1024)}MB`,
    );
  // Pictures and files are two prefixes, and the server picks between them from the type it
  // will verify — a browser naming its own key is an overwrite waiting to happen.
  return `${upload.mime.startsWith('image/') ? 'media' : 'files'}/${upload.hash}.${ext}`;
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

/**
 * What the picker browses, newest first. Two lists rather than one filtered in the browser,
 * because a `file` field has no business seeing the photographs. No index: a site's library is
 * hundreds of rows, and the limit is what keeps the read small.
 */
export function mediaList(siteId: string, db: Db, kind: 'images' | 'files'): Promise<MediaRow[]> {
  const pictures = like(media.mime, 'image/%');
  return db
    .select()
    .from(media)
    .where(
      and(
        eq(media.siteId, siteId),
        eq(media.archived, 0),
        kind === 'images' ? pictures : not(pictures),
      ),
    )
    .orderBy(desc(media.createdAt))
    .limit(100);
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
  headers?: Record<string, string>,
) => fetch(await signer(store).sign(objectUrl(store, key), { method, headers }));

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

  // A file the bucket's domain would render is an XSS vector against that domain, so it is stored
  // as a download and held to it here — and its first bytes have to be the type it was uploaded
  // as, which is the one claim a rename cannot fake.
  const magic = MAGIC[upload.mime];
  if (magic) {
    if (!(head.headers.get('content-disposition') ?? '').startsWith('attachment')) {
      await object(store, key, 'DELETE', fetch);
      throw new UploadRefusedError(
        'a file is stored as a download, and this one was not. It has been deleted',
      );
    }
    const first = await object(store, key, 'GET', fetch, {
      range: `bytes=0-${magic.length - 1}`,
    });
    if (!(await first.text()).startsWith(magic)) {
      await object(store, key, 'DELETE', fetch);
      throw new UploadRefusedError(
        `these bytes are not a ${EXTENSIONS[upload.mime]?.toUpperCase()}, whatever the upload called them. It has been deleted`,
      );
    }
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
