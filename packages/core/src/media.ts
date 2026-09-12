import { AwsClient } from 'aws4fetch';
import { type AnyColumn, and, desc, eq, like, ne, not, or, sql } from 'drizzle-orm';
import { parseEntry } from './content.js';
import type { Db } from './db.js';
import type { ContentFile } from './entries.js';
import { entryKey } from './entries.js';
import { drafts, media } from './tables.js';
import { imageDimensions } from './upload-bytes.js';

export interface R2Store {
  /** The S3 endpoint is named after it. */
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the browser declares, and what the object is then held to. */
export interface Upload {
  /** sha-256 hex of the bytes; names the object, so it is also the row's id. */
  hash: string;
  /** The temporary key from the upload request; never a public key. */
  key?: string;
  bytes: number;
  mime: string;
  /** Kept for search, never for addressing. */
  filename?: string;
  width?: number;
  height?: number;
  /** The picture this one was cropped out of. */
  derivedFrom?: string;
}

export type MediaRow = typeof media.$inferSelect;

/** The client downscales a picture long before this cap. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface Preset {
  /** `'16:9'`: what the field shows, whatever shape the picture is. */
  ratio?: string;
  /** Longest side an upload is downscaled to in the browser. */
  max?: number;
  /** Narrowest crop width the picker will take. */
  min?: number;
}

export const DEFAULT_MAX = 2400;

/** 1.91:1 at 1200 is the 1200 × 630 every social card asks for, so cap and floor coincide. */
export const SOCIAL_CARD: Preset = { ratio: '1.91:1', max: 1200, min: 1200 };

export const ratioOf = (ratio: string | undefined) => {
  const [w, h] = (ratio ?? '').split(':').map(Number);
  return w && h ? w / h : undefined;
};

/** The floor is measured against this: a 900 × 1600 phone photo still only makes a 900 px hero. */
export function cropWidth(width: number, height: number, ratio?: string): number {
  const r = ratioOf(ratio);
  return Math.floor(r ? Math.min(width, height * r) : width);
}

export function tooSmall(preset: Preset, width: number, height: number): string | undefined {
  if (!preset.min) return undefined;
  const crop = cropWidth(width, height, preset.ratio);
  if (crop >= preset.min) return undefined;
  const what = preset.ratio
    ? `its widest ${preset.ratio} crop is ${crop} px`
    : `it is ${crop} px wide`;
  return `Too small for this field — ${what}, this field needs ${preset.min}`;
}

// The extension comes from the verified type, never from the client's filename.
const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

const SHA256 = /^[0-9a-f]{64}$/;
/** Long enough for a slow phone, short enough that a leaked url is worth nothing. */
const TTL = 300;

/** The message is shown to the person who chose the file. */
export class UploadRefusedError extends Error {}

/** A stale picker must not bring back bytes whose deletion already owns the key. */
export class MediaUnavailableError extends Error {
  override name = 'MediaUnavailableError';
  constructor() {
    super('That media item is being deleted. Choose another file before saving.');
  }
}

/** The usage snapshot lost its race, so the draft is authoritative and deletion stops. */
export class MediaInUseError extends Error {
  override name = 'MediaInUseError';
  constructor() {
    super('This media item became used while it was being deleted. Archive it instead.');
  }
}

/** Content-addressed and checked before signing: R2 cannot bind a size to a presigned PUT. */
export function mediaKey(upload: Upload): string {
  const ext = EXTENSIONS[upload.mime];
  if (!ext)
    throw new UploadRefusedError(
      `${upload.mime} cannot be uploaded: this site takes ${Object.keys(EXTENSIONS).join(', ')}`,
    );
  if (!SHA256.test(upload.hash))
    throw new UploadRefusedError('an upload is named by the sha-256 of its own bytes');
  if (!(Number.isInteger(upload.bytes) && upload.bytes > 0 && upload.bytes <= MAX_UPLOAD_BYTES))
    throw new UploadRefusedError(
      `an upload may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024}MB, and this one is ${Math.round(upload.bytes / 1024 / 1024)}MB`,
    );
  // The server picks the prefix: a browser naming its own key is an overwrite waiting to happen.
  return `${upload.mime.startsWith('image/') ? 'media' : 'files'}/${upload.hash}.${ext}`;
}

/** The whole of the dedupe. */
export function findMedia(siteId: string, db: Db, id: string): Promise<MediaRow | undefined> {
  return db
    .select()
    .from(media)
    .where(and(eq(media.siteId, siteId), eq(media.id, id)))
    .limit(1)
    .then(([row]) => row);
}

export interface MediaQuery {
  kind: 'images' | 'files';
  q?: string;
  /** The library shows archived rows flagged; the picker never offers them. */
  withArchived?: boolean;
}

// `_` is LIKE's own, and a client typing `IMG_2041` means the underscore.
const contains = (column: AnyColumn, q: string) =>
  sql`${column} like ${`%${q.replace(/[\\%_]/g, '\\$&')}%`} escape '\\'`;

/** Searched in SQL, not the browser: a name past the hundredth row would otherwise never match. */
export function mediaList(siteId: string, db: Db, query: MediaQuery): Promise<MediaRow[]> {
  const pictures = like(media.mime, 'image/%');
  const q = query.q?.trim();
  return db
    .select()
    .from(media)
    .where(
      and(
        eq(media.siteId, siteId),
        ne(media.state, 'deleted'),
        query.withArchived ? undefined : eq(media.archived, 0),
        query.withArchived ? undefined : eq(media.state, 'active'),
        query.kind === 'images' ? pictures : not(pictures),
        // The tags' json text is searched rather than a join table for three words.
        q ? or(contains(media.filename, q), contains(media.tags, q)) : undefined,
      ),
    )
    .orderBy(desc(media.createdAt))
    .limit(100);
}

/** None of this is content, so it lives on the row and is never committed. */
export async function setMediaDetails(
  siteId: string,
  db: Db,
  id: string,
  details: { tags?: string[]; alt?: string; archived?: boolean; focal?: [number, number] },
): Promise<MediaRow | undefined> {
  const [row] = await db
    .update(media)
    .set({
      ...(details.tags ? { tags: details.tags } : {}),
      // An emptied alt is no default at all, which the column says as null.
      ...(details.alt === undefined ? {} : { alt: details.alt || null }),
      // Never gated on usage: archiving only takes the picture out of the picker.
      ...(details.archived === undefined ? {} : { archived: details.archived ? 1 : 0 }),
      // A default: a page that set its own focal dot keeps it.
      ...(details.focal ? { focalX: details.focal[0], focalY: details.focal[1] } : {}),
    })
    .where(and(eq(media.siteId, siteId), eq(media.id, id), eq(media.state, 'active')))
    .returning();
  return row;
}

/** The key format `mediaKey` writes. */
const STORED = /^(?:media|files)\/[0-9a-f]{64}\.[a-z0-9]+$/;

export type MediaUses = Record<string, string[]>;

function keysIn(node: unknown, found: Set<string>) {
  if (typeof node === 'string') {
    if (STORED.test(node)) found.add(node);
  } else if (Array.isArray(node)) for (const row of node) keysIn(row, found);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) keysIn(v, found);
}

/** Built with the entry index: a usage count is a repo-wide scan and git is slow to list. */
export function mediaUsesFrom(siteId: string, files: Iterable<ContentFile>): MediaUses {
  const uses: MediaUses = {};
  for (const file of files) {
    // Entries only, like the index: `_templates/` and `redirects.yaml` name no entry.
    if (!entryKey(file.path)) continue;
    const found = new Set<string>();
    keysIn(parseEntry(siteId, file.contents), found);
    if (found.size) uses[file.path] = [...found].sort();
  }
  return uses;
}

/** Drafts overlay the built map; an entry counts once however many languages carry the picture. */
export function mediaUsage(
  siteId: string,
  uses: MediaUses,
  drafts: readonly ContentFile[],
): Record<string, string[]> {
  const files: MediaUses = { ...uses };
  // A deleted file's empty contents parse to nothing, which is the right answer.
  for (const draft of drafts) {
    const found = new Set<string>();
    keysIn(parseEntry(siteId, draft.contents), found);
    files[draft.path] = [...found];
  }
  const used: Record<string, Set<string>> = {};
  for (const [path, keys] of Object.entries(files)) {
    const entry = entryKey(path);
    if (!entry) continue;
    for (const key of keys) {
      used[key] ??= new Set();
      used[key].add(entry);
    }
  }
  return Object.fromEntries(Object.entries(used).map(([key, set]) => [key, [...set].sort()]));
}

export function namedBy(key: string, files: Iterable<ContentFile>): string[] {
  const found = new Set<string>();
  for (const file of files)
    if (file.contents.includes(key)) found.add(entryKey(file.path) ?? file.path);
  return [...found].sort();
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

/** Neither size nor type can be signed on R2, so `confirmUpload` is the enforcement. */
export async function presignUpload(store: R2Store, key: string): Promise<string> {
  if (!/^uploads\/[0-9a-f-]{36}\/(?:media|files)\/[0-9a-f]{64}\.[a-z]+$/.test(key))
    throw new UploadRefusedError('Only temporary upload keys may be signed');
  const url = new URL(objectUrl(store, key));
  url.searchParams.set('X-Amz-Expires', String(TTL));
  const signed = await signer(store).sign(url.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
  });
  return signed.url;
}

/** The key is deliberately not `mediaKey`'s shape, or the reconciliation job would adopt it. */
export async function checkStore(
  store: R2Store,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
  const { fetch = globalThis.fetch } = deps;
  const url = objectUrl(store, CHECK_KEY);
  const aws = signer(store);
  const put = await fetch(await aws.sign(url, { method: 'PUT', body: CHECK_BODY }));
  if (!put.ok)
    throw new Error(`The bucket refused the upload (${put.status})${advice(store, put.status)}`);
  const read = await fetch(await aws.sign(url, { method: 'GET' }));
  const back = read.ok ? await read.text() : '';
  // Deleted whatever the read said: a check must not leave its own object behind.
  const gone = await fetch(await aws.sign(url, { method: 'DELETE' }));
  if (!read.ok) throw new Error(`The bucket would not read the object back (${read.status})`);
  if (back !== CHECK_BODY)
    throw new Error('The bucket read back something other than what was written');
  if (!gone.ok) throw new Error(`The bucket would not delete the object again (${gone.status})`);
}

/** 403 is the credential and 404 is the bucket; a bare status leaves the key holder guessing. */
const advice = (store: R2Store, status: number) =>
  status === 403
    ? `: check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token has Object Read & Write on ${store.bucket}`
    : status === 404
      ? `: check R2_ACCOUNT_ID and R2_BUCKET — nothing answers for ${store.bucket} on this account`
      : '';

const CHECK_KEY = 'checks/connection.txt';
const CHECK_BODY = 'handover';

const object = async (
  store: R2Store,
  key: string,
  method: string,
  fetch: typeof globalThis.fetch,
  headers?: Record<string, string>,
) => fetch(await signer(store).sign(objectUrl(store, key), { method, headers }));

/** Asked only for a key with no row; a key with neither is a broken image on the page. */
export async function objectExists(
  store: R2Store,
  key: string,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<boolean> {
  const { fetch = globalThis.fetch } = deps;
  return (await object(store, key, 'HEAD', fetch)).ok;
}

/** An existing row is the dedupe path and never deletes another upload's final object. */
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
  if (known?.state === 'active') return { media: known, created: false };
  if (known?.state === 'deleting') throw new MediaUnavailableError();

  if (
    !upload.key ||
    !new RegExp(`^uploads/[0-9a-f-]{36}/${key.replace('.', '\\.')}$`).test(upload.key)
  )
    throw new UploadRefusedError('Confirm the temporary key returned by the upload request');
  let verified: Awaited<ReturnType<typeof verifyObject>>;
  try {
    verified = await verifyObject(store, upload.key, upload, fetch);
  } catch (error) {
    if (error instanceof UploadRefusedError) await object(store, upload.key, 'DELETE', fetch);
    throw error;
  }
  // The verified buffer is written: copying the temporary key would race another PUT.
  const finalized = await fetch(
    await signer(store).sign(objectUrl(store, key), {
      method: 'PUT',
      headers: {
        'content-type': upload.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        ...(upload.mime === 'application/pdf' ? { 'content-disposition': 'attachment' } : {}),
      },
      body: verified.data,
    }),
  );
  if (!finalized.ok) throw new Error(`R2 finalization failed: ${finalized.status}`);
  const values = {
    id: upload.hash,
    siteId,
    r2Key: key,
    filename: upload.filename ?? null,
    mime: upload.mime,
    bytes: upload.bytes,
    width: verified.width ?? null,
    height: verified.height ?? null,
    derivedFrom: upload.derivedFrom ?? null,
    state: 'active' as const,
    deletingAt: null,
    createdAt: now,
  };
  const [written] = await db.insert(media).values(values).onConflictDoNothing().returning();
  const [restored] = written
    ? []
    : await db
        .update(media)
        .set(values)
        .where(and(eq(media.siteId, siteId), eq(media.id, upload.hash), eq(media.state, 'deleted')))
        .returning();
  // Two tabs confirming the same bytes at once: the one that lost reads the row.
  const stored = written ?? restored ?? (await findMedia(siteId, db, upload.hash));
  if (!stored) throw new Error(`the media row for ${upload.hash} was not written`);
  if (stored.state !== 'active') throw new MediaUnavailableError();
  // Staging outlives registration so a failed database write can retry.
  await object(store, upload.key, 'DELETE', fetch).catch(() => undefined);
  return { media: stored, created: Boolean(written ?? restored) };
}

/** D1 orders the claim against draft saves; the tombstone keeps stale pickers from reviving it. */
export async function deleteMedia(
  siteId: string,
  db: Db,
  store: R2Store,
  row: { id: string; r2Key: string },
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<void> {
  const { fetch = globalThis.fetch, now = Date.now() } = deps;
  const [claimed] = await db
    .update(media)
    .set({
      state: 'deleting',
      deletingAt: sql`coalesce(${media.deletingAt}, ${now})`,
    })
    .where(
      and(
        eq(media.siteId, siteId),
        eq(media.id, row.id),
        or(
          eq(media.state, 'deleting'),
          and(
            eq(media.state, 'active'),
            sql`not exists (select 1 from ${drafts} where ${drafts.siteId} = ${siteId} and instr(${drafts.contents}, ${row.r2Key}) > 0)`,
          ),
        ),
      ),
    )
    .returning({ id: media.id });
  if (!claimed) {
    const current = await findMedia(siteId, db, row.id);
    if (!current || current.state === 'deleted') return;
    throw new MediaInUseError();
  }
  const gone = await object(store, row.r2Key, 'DELETE', fetch);
  // R2 answers 204 for a key it never had, so anything else is a refusal.
  if (!gone.ok && gone.status !== 404)
    throw new Error(`R2 DELETE ${row.r2Key} failed: ${gone.status}`);
  await db
    .update(media)
    .set({ state: 'deleted' })
    .where(and(eq(media.siteId, siteId), eq(media.id, row.id), eq(media.state, 'deleting')));
}

// workerd has no XML parser, and the keys read are hex and an extension, so regexes suffice.
const CONTENTS = /<Contents>([\s\S]*?)<\/Contents>/g;
const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

/** The key format `mediaKey` writes, and nothing else. */
const OURS = /^(?:media|files)\/([0-9a-f]{64})\.([a-z0-9]+)$/;
const MIMES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

const listPage = async (store: R2Store, fetch: typeof globalThis.fetch, token?: string) => {
  const url = new URL(`https://${store.accountId}.r2.cloudflarestorage.com/${store.bucket}`);
  url.searchParams.set('list-type', '2');
  if (token) url.searchParams.set('continuation-token', token);
  const res = await fetch(await signer(store).sign(url.toString(), { method: 'GET' }));
  if (!res.ok) throw new Error(`R2 LIST ${store.bucket} failed: ${res.status}`);
  return res.text();
};

/** Adopts stray final objects and temporary uploads whose PUT lease has expired. */
export async function reconcileMedia(
  siteId: string,
  db: Db,
  store: R2Store | undefined,
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<number> {
  // No bucket is not a failure and writes no row.
  if (!store) return 0;
  const { fetch = globalThis.fetch, now = Date.now() } = deps;
  // This set stops a second pass costing a write per object per tick.
  const known = new Set(
    (await db.select({ id: media.id }).from(media).where(eq(media.siteId, siteId))).map(
      (r) => r.id,
    ),
  );
  let token: string | undefined;
  let recovered = 0;
  do {
    const xml = await listPage(store, fetch, token);
    for (const match of xml.matchAll(CONTENTS)) {
      const item = match[1] ?? '';
      const storedKey = tag(item, 'Key') ?? '';
      const staging = storedKey.match(
        /^uploads\/[0-9a-f-]{36}\/((?:media|files)\/[0-9a-f]{64}\.[a-z]+)$/,
      )?.[1];
      const key = staging ?? storedKey;
      const [, id = '', ext = ''] = key.match(OURS) ?? [];
      if (!id) continue;
      if (staging) {
        const uploaded = Date.parse(tag(item, 'LastModified') ?? '');
        // A live client may still be writing; missing metadata is no permission to delete.
        if (!Number.isFinite(uploaded) || now - uploaded < TTL * 1000) continue;
        if (known.has(id)) {
          await object(store, storedKey, 'DELETE', fetch);
          continue;
        }
      } else if (known.has(id)) continue;
      const mime = MIMES[ext];
      const bytes = Number(tag(item, 'Size'));
      if (
        !mime ||
        !Number.isInteger(bytes) ||
        bytes <= 0 ||
        bytes > MAX_UPLOAD_BYTES ||
        key !== mediaKey({ hash: id, bytes, mime })
      ) {
        if (staging) await object(store, storedKey, 'DELETE', fetch);
        continue;
      }
      if (staging) {
        try {
          const result = await confirmUpload(
            siteId,
            db,
            store,
            { hash: id, bytes, mime, key: storedKey },
            { fetch, now },
          );
          recovered += Number(result.created);
          known.add(id);
        } catch (error) {
          if (!(error instanceof UploadRefusedError)) throw error;
        }
        continue;
      }
      let verified: Awaited<ReturnType<typeof verifyObject>>;
      try {
        verified = await verifyObject(store, key, { hash: id, bytes, mime }, fetch);
      } catch (error) {
        if (error instanceof UploadRefusedError) continue;
        throw error;
      }
      const written = await db
        .insert(media)
        .values({
          id,
          siteId,
          r2Key: key,
          mime,
          bytes,
          width: verified.width ?? null,
          height: verified.height ?? null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: media.id });
      // Rows written, not objects seen: a confirm arriving mid-listing wins.
      recovered += written.length;
      known.add(id);
    }
    token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
  } while (token);
  return recovered;
}

async function verifyObject(
  store: R2Store,
  key: string,
  upload: Upload,
  fetch: typeof globalThis.fetch,
) {
  mediaKey(upload);
  const response = await object(store, key, 'GET', fetch);
  if (response.status === 404) throw new UploadRefusedError('The upload never reached the bucket');
  if (!response.ok) throw new Error(`R2 GET ${key} failed: ${response.status}`);
  if (response.headers.get('content-type') !== upload.mime)
    throw new UploadRefusedError('The uploaded content type differs from its declaration');
  const reader = response.body?.getReader();
  if (!reader) throw new UploadRefusedError('The upload is empty');
  const data = new Uint8Array(upload.bytes);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > data.length)
        throw new UploadRefusedError('The uploaded size differs from its declaration');
      data.set(value, size - value.byteLength);
    }
  } finally {
    await reader.cancel();
  }
  if (size !== data.length)
    throw new UploadRefusedError('The uploaded size differs from its declaration');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== upload.hash)
    throw new UploadRefusedError('The uploaded SHA-256 does not match its key');
  if (upload.mime === 'application/pdf') {
    if (
      key.startsWith('files/') &&
      !response.headers.get('content-disposition')?.startsWith('attachment')
    )
      throw new UploadRefusedError('A public PDF must be stored as a download');
    if (!new TextDecoder().decode(data.slice(0, 5)).startsWith('%PDF-'))
      throw new UploadRefusedError('The uploaded bytes are not a PDF');
    return { data, width: undefined, height: undefined };
  }
  return { data, ...imageDimensions(data, upload.mime) };
}
