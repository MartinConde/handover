import { type AnyColumn, and, desc, eq, like, ne, not, or, sql } from 'drizzle-orm';
import type { ContentFile } from '../content/entries.js';
import { entryKey } from '../content/entries.js';
import { parseEntry } from '../content/entry-format.js';
import type { Preset } from '../content/schema.js';
import type { Db } from '../db.js';
import { drafts, media } from '../tables.js';
import {
  CONTENTS,
  listPage,
  MAX_UPLOAD_BYTES,
  MEDIA_KEY,
  MIMES,
  mediaKey,
  object,
  objectUrl,
  type R2Store,
  signer,
  tag,
  type Upload,
  verifyObject,
  verifyStaged,
} from './store.js';
import { UploadRefusedError } from './upload-bytes.js';

export interface UploadStaging {
  read(key: string): Promise<{ data: Uint8Array; mime: string; disposition?: string } | undefined>;
  delete(key: string): Promise<void>;
}

export type MediaRow = typeof media.$inferSelect;

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

// Long enough for a slow phone, short enough that a leaked url is worth nothing.
const TTL = 300;

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

export type MediaUses = Record<string, string[]>;

function keysIn(node: unknown, found: Set<string>) {
  if (typeof node === 'string') {
    if (MEDIA_KEY.test(node)) found.add(node);
  } else if (Array.isArray(node)) for (const row of node) keysIn(row, found);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) keysIn(v, found);
}

/** Built with the entry index: a usage count is a repo-wide scan and git is slow to list. */
export function mediaUsesFrom(files: Iterable<ContentFile>): MediaUses {
  const uses: MediaUses = {};
  for (const file of files) {
    // Entries only, like the index: `_templates/` and `redirects.yaml` name no entry.
    if (!entryKey(file.path)) continue;
    const found = new Set<string>();
    keysIn(parseEntry(file.contents), found);
    if (found.size) uses[file.path] = [...found].sort();
  }
  return uses;
}

/** Drafts overlay the built map; an entry counts once however many languages carry the picture. */
export function mediaUsage(
  uses: MediaUses,
  drafts: readonly ContentFile[],
): Record<string, string[]> {
  const files: MediaUses = { ...uses };
  // A deleted file's empty contents parse to nothing, which is the right answer.
  for (const draft of drafts) {
    const found = new Set<string>();
    keysIn(parseEntry(draft.contents), found);
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

/** An existing row is the dedupe path and never deletes another upload's final object. */
export async function confirmUpload(
  siteId: string,
  db: Db,
  store: R2Store,
  upload: Upload,
  deps: { fetch?: typeof globalThis.fetch; now?: number; staging?: UploadStaging } = {},
): Promise<{ media: MediaRow; created: boolean }> {
  const { fetch = globalThis.fetch, now = Date.now(), staging } = deps;
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
    verified = staging
      ? await verifyStaged(await staging.read(upload.key), upload)
      : await verifyObject(store, upload.key, upload, fetch);
  } catch (error) {
    if (error instanceof UploadRefusedError)
      await (staging ? staging.delete(upload.key) : object(store, upload.key, 'DELETE', fetch));
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
  await (staging ? staging.delete(upload.key) : object(store, upload.key, 'DELETE', fetch)).catch(
    () => undefined,
  );
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
        /^uploads\/[0-9a-f-]{36}\/((?:media|files)\/[0-9a-f]{64}\.[a-z0-9]+)$/,
      )?.[1];
      const key = staging ?? storedKey;
      const [, id = '', ext = ''] = key.match(MEDIA_KEY) ?? [];
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
