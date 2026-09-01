import { AwsClient } from 'aws4fetch';
import { type AnyColumn, and, desc, eq, like, not, or, sql } from 'drizzle-orm';
import { parseEntry } from './content.js';
import type { Db } from './db.js';
import type { ContentFile } from './entries.js';
import { entryKey } from './entries.js';
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
  /** The picture this one was cropped out of; an ordinary upload came from nothing. */
  derivedFrom?: string;
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

/**
 * The one preset a platform fixes rather than a designer: 1.91:1 at 1200 is the 1200 × 630
 * every social card asks for, so the cap and the floor are the same number.
 */
export const SOCIAL_CARD: Preset = { ratio: '1.91:1', max: 1200, min: 1200 };

/** `'16:9'` as the number a crop is measured with; nothing for a field that shows a picture whole. */
export const ratioOf = (ratio: string | undefined) => {
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

/** Which slice of the library to read: the picker's is narrower than the library's own. */
export interface MediaQuery {
  /** Pictures or downloads. A `file` field has no business seeing the photographs. */
  kind: 'images' | 'files';
  /** Matched anywhere in the file name or in one of the tags. */
  q?: string;
  /** The library shows what it has put away, with the flag on it; the picker never offers it. */
  withArchived?: boolean;
}

// `%` and `_` are LIKE's own, and a client typing `IMG_2041` means the underscore.
const contains = (column: AnyColumn, q: string) =>
  sql`${column} like ${`%${q.replace(/[\\%_]/g, '\\$&')}%`} escape '\\'`;

/**
 * What the library and the picker browse, newest first. The search is in the query rather than
 * in the browser: a name past the hundredth row would otherwise be a match nobody could find.
 * No index: a site's library is hundreds of rows, and the limit is what keeps the read small.
 */
export function mediaList(siteId: string, db: Db, query: MediaQuery): Promise<MediaRow[]> {
  const pictures = like(media.mime, 'image/%');
  const q = query.q?.trim();
  return db
    .select()
    .from(media)
    .where(
      and(
        eq(media.siteId, siteId),
        query.withArchived ? undefined : eq(media.archived, 0),
        query.kind === 'images' ? pictures : not(pictures),
        // Tags are stored as their own json, so the text of the array is what is searched:
        // the alternative is a join table for a column holding three words.
        q ? or(contains(media.filename, q), contains(media.tags, q)) : undefined,
      ),
    )
    .orderBy(desc(media.createdAt))
    .limit(100);
}

/**
 * The library's own words about an asset: the tags it is found by and the alt text a page falls
 * back to. Neither is content — they are the client's account of the picture rather than of a
 * page, so they live on the row and are never committed.
 */
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
      // An alt somebody has emptied is no default at all, and null is what the column says that in.
      ...(details.alt === undefined ? {} : { alt: details.alt || null }),
      // Archiving is never gated on usage: a picture that is still used stays used, and putting
      // it away only takes it out of the picker.
      ...(details.archived === undefined ? {} : { archived: details.archived ? 1 : 0 }),
      // Where every crop of this picture holds, as a fraction of its width and of its height.
      // It is a default: a page that set its own dot keeps it.
      ...(details.focal ? { focalX: details.focal[0], focalY: details.focal[1] } : {}),
    })
    .where(and(eq(media.siteId, siteId), eq(media.id, id)))
    .returning();
  return row;
}

/** The key `mediaKey` writes, wherever a content file names one. */
const STORED = /^(?:media|files)\/[0-9a-f]{64}\.[a-z0-9]+$/;

/** Which assets each content file names, by the file's path. */
export type MediaUses = Record<string, string[]>;

function keysIn(node: unknown, found: Set<string>) {
  if (typeof node === 'string') {
    if (STORED.test(node)) found.add(node);
  } else if (Array.isArray(node)) for (const row of node) keysIn(row, found);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) keysIn(v, found);
}

/**
 * Every stored key each content file names. Built with the entry index rather than read per
 * request, because a usage count is a repo-wide scan and git is slow to list — the same reason
 * the titles are read at build time.
 */
export function mediaUsesFrom(siteId: string, files: Iterable<ContentFile>): MediaUses {
  const uses: MediaUses = {};
  for (const file of files) {
    // Entries only, the way the index is built: a starter under `_templates/` and
    // `redirects.yaml` name no entry, so whatever they hold could never be counted anyway.
    if (!entryKey(file.path)) continue;
    const found = new Set<string>();
    keysIn(parseEntry(siteId, file.contents), found);
    if (found.size) uses[file.path] = [...found].sort();
  }
  return uses;
}

/**
 * Which entries each asset is used in, drafts laid over the built map: a picture pulled out of
 * an entry this morning is not still used there, and one dropped in is, before either is
 * published. An entry counts once however many of its languages carry the picture — an asset is
 * locale-agnostic, and *used in 2 places* for one listing in two languages is a lie.
 */
export function mediaUsage(
  siteId: string,
  uses: MediaUses,
  drafts: readonly ContentFile[],
): Record<string, string[]> {
  const files: MediaUses = { ...uses };
  // The empty contents of a deleted file parse to nothing, which is the right answer for it:
  // that path names no asset until the build catches up.
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

/**
 * Which entries name this key, read from the files themselves. **This is the delete gate**, and
 * it is deliberately not `mediaUsage`: that one is the badge, built from a scan the last build
 * made, and a commit somebody pushed since is not in it. Here the caller hands over the tree as
 * git has it now, plus every draft — added to the tree rather than laid over it, because a
 * picture an editor took out of a listing this morning is still on the published site until that
 * listing is published, and the bytes are what the live page is asking for.
 *
 * The text is searched rather than the parsed file: a stored key is 64 hex characters and a file
 * naming one anywhere — in a comment, in a field no schema knows — is a file that names it. Four
 * hundred entries is also four hundred YAML parses, which is not what ten milliseconds of CPU is
 * for.
 */
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

/**
 * That the bucket is really there and these credentials may write to it: one small object put,
 * read back and deleted again, which is an upload's whole path through R2. Whichever step
 * refused is what it throws, in R2's own status, because that is what the person holding the
 * keys can act on.
 *
 * The key is deliberately not `mediaKey`'s shape: the reconciliation job adopts stray objects
 * that look like uploads, and this one is litter rather than somebody's work.
 */
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
  // Deleted whatever the read said: a check that leaves its own object behind is worse than
  // no check, and the bucket that failed the read is the one still holding it.
  const gone = await fetch(await aws.sign(url, { method: 'DELETE' }));
  if (!read.ok) throw new Error(`The bucket would not read the object back (${read.status})`);
  if (back !== CHECK_BODY)
    throw new Error('The bucket read back something other than what was written');
  if (!gone.ok) throw new Error(`The bucket would not delete the object again (${gone.status})`);
}

/**
 * Which of the four values to look at. R2's two refusals say different things — 403 is the
 * credential and 404 is the bucket this site was pointed at — and a status on its own leaves
 * whoever holds the keys guessing between them.
 */
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

/**
 * Whether the bucket still has these bytes. Asked only for a key the table has no row for —
 * an object with no row is what the reconciliation job recovers within the hour, and a key
 * with neither is a picture the page would draw as a broken image.
 */
export async function objectExists(
  store: R2Store,
  key: string,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<boolean> {
  const { fetch = globalThis.fetch } = deps;
  return (await object(store, key, 'HEAD', fetch)).ok;
}

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
      derivedFrom: upload.derivedFrom ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  // Two tabs confirming the same bytes at the same moment: the one that lost reads the row.
  const stored = written ?? (await findMedia(siteId, db, upload.hash));
  if (!stored) throw new Error(`the media row for ${upload.hash} was not written`);
  return { media: stored, created: Boolean(written) };
}

/**
 * The one deletion that is somebody's decision rather than a rejected upload. Whether it is
 * allowed is `namedBy`'s answer and the caller's to ask; this is what carrying it out is.
 *
 * **The row goes first.** An object left in the bucket with no row is exactly what the hourly
 * reconciliation job is for, so a failed second half comes back as *Recovered* within the hour;
 * a row left pointing at bytes that are gone is a broken picture nothing ever repairs.
 */
export async function deleteMedia(
  siteId: string,
  db: Db,
  store: R2Store,
  row: { id: string; r2Key: string },
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
  const { fetch = globalThis.fetch } = deps;
  await db.delete(media).where(and(eq(media.siteId, siteId), eq(media.id, row.id)));
  const gone = await object(store, row.r2Key, 'DELETE', fetch);
  // R2 answers 204 for a key it never had, so anything else is the bucket refusing.
  if (!gone.ok && gone.status !== 404)
    throw new Error(`R2 DELETE ${row.r2Key} failed: ${gone.status}`);
}

// The bucket's own list of itself, as XML. There is no parser in workerd and the keys this
// reads are hex and a file extension, so the shapes below are read out rather than parsed.
const CONTENTS = /<Contents>([\s\S]*?)<\/Contents>/g;
const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

/** The key format `mediaKey` writes, and nothing else: an id, and the type its extension names. */
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

/**
 * Objects the table has never heard of — an upload whose confirm never arrived, a session that
 * went away between the PUT and it. They are given rows rather than deleted: the bytes are
 * somebody's work, and a row is the whole of what makes them visible again.
 *
 * `width` and `height` stay null. A listing carries a size and a key carries a type, so neither
 * costs a request; the dimensions are in the pixels and reading those is not this job's.
 */
export async function reconcileMedia(
  siteId: string,
  db: Db,
  store: R2Store | undefined,
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<number> {
  // A site with no bucket has nothing to reconcile; it is not a failure and writes no row.
  if (!store) return 0;
  const { fetch = globalThis.fetch, now = Date.now() } = deps;
  // One read of the table against one listing of the bucket. `onConflictDoNothing` below is
  // what makes a second pass harmless; this set is what stops it costing a write per object
  // per tick, on a table whose size is the bucket's.
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
      const key = tag(item, 'Key') ?? '';
      const [, id = '', ext = ''] = key.match(OURS) ?? [];
      // An object nothing here ever wrote is not this table's to claim.
      if (!id || known.has(id)) continue;
      known.add(id);
      const bytes = Number(tag(item, 'Size'));
      const written = await db
        .insert(media)
        .values({
          id,
          siteId,
          r2Key: key,
          mime: MIMES[ext] ?? null,
          bytes: Number.isFinite(bytes) ? bytes : null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: media.id });
      // The count is rows written, not objects seen: a confirm arriving mid-listing wins.
      recovered += written.length;
    }
    token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
  } while (token);
  return recovered;
}
