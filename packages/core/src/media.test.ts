import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from './db.js';
import {
  confirmUpload,
  findMedia,
  MAX_UPLOAD_BYTES,
  mediaKey,
  presignUpload,
  type R2Store,
  type Upload,
  UploadRefusedError,
} from './media.js';
import * as tables from './tables.js';

const store: R2Store = {
  accountId: '2e4dff78a4af5223c7940d6b41d7c9a7',
  bucket: 'site-media',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
};

const HASH = 'a'.repeat(64);
const declared: Upload = {
  hash: HASH,
  bytes: 12_345,
  mime: 'image/webp',
  filename: 'seaview.jpg',
  width: 2400,
  height: 1350,
};

/** The bucket as the S3 API answers for it, and every request that was made of it. */
function bucket(objects: Record<string, { bytes: number; mime: string }>) {
  const calls: { method: string; key: string }[] = [];
  const fetch = (async (input: Request) => {
    const url = new URL(input.url);
    const key = url.pathname.slice(`/${store.bucket}/`.length);
    calls.push({ method: input.method, key });
    if (input.method === 'DELETE') {
      delete objects[key];
      return new Response(null, { status: 204 });
    }
    const found = objects[key];
    if (!found) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: { 'content-length': String(found.bytes), 'content-type': found.mime },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, objects };
}

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

test('an object is named by the hash of its bytes and the type it was declared as', () => {
  expect(mediaKey(declared)).toBe(`media/${HASH}.webp`);
  expect(mediaKey({ ...declared, mime: 'image/jpeg' })).toBe(`media/${HASH}.jpg`);
});

test('a type the bucket does not serve is refused before anything is signed', () => {
  expect(() => mediaKey({ ...declared, mime: 'image/svg+xml' })).toThrow(UploadRefusedError);
  expect(() => mediaKey({ ...declared, mime: 'text/html' })).toThrow(/cannot be uploaded/);
});

test('a name that is not a sha-256 of the bytes is refused', () => {
  expect(() => mediaKey({ ...declared, hash: '../../etc/passwd' })).toThrow(UploadRefusedError);
});

test('an upload bigger than the cap is refused before anything is signed', () => {
  expect(() => mediaKey({ ...declared, bytes: MAX_UPLOAD_BYTES + 1 })).toThrow(/10MB/);
  expect(() => mediaKey({ ...declared, bytes: 0 })).toThrow(UploadRefusedError);
});

test('the presigned PUT is a query-signed url that expires in five minutes', async () => {
  const url = new URL(await presignUpload(store, `media/${HASH}.webp`));
  expect(url.origin).toBe(`https://${store.accountId}.r2.cloudflarestorage.com`);
  expect(url.pathname).toBe(`/${store.bucket}/media/${HASH}.webp`);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  // Neither the size nor the type can be signed into it, which is why step 6 exists.
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
});

test('an object whose size is not what was declared is deleted and refused', async () => {
  const db = openDb('default', binding);
  const r2 = bucket({ [`media/${HASH}.webp`]: { bytes: 9_000_000, mime: 'image/webp' } });
  await expect(confirmUpload('default', db, store, declared, { fetch: r2.fetch })).rejects.toThrow(
    UploadRefusedError,
  );
  expect(r2.calls.map((c) => c.method)).toEqual(['HEAD', 'DELETE']);
  expect(r2.objects).toEqual({});
  expect(await findMedia('default', db, HASH)).toBeUndefined();
});

test('an object whose type is not what was declared is deleted and refused', async () => {
  const db = openDb('default', binding);
  const hash = 'b'.repeat(64);
  const r2 = bucket({ [`media/${hash}.webp`]: { bytes: 12_345, mime: 'text/html' } });
  await expect(
    confirmUpload('default', db, store, { ...declared, hash }, { fetch: r2.fetch }),
  ).rejects.toThrow(/text\/html/);
  expect(r2.objects).toEqual({});
});

test('an upload that never arrived is refused with nothing to delete', async () => {
  const db = openDb('default', binding);
  const r2 = bucket({});
  await expect(
    confirmUpload('default', db, store, { ...declared, hash: 'c'.repeat(64) }, { fetch: r2.fetch }),
  ).rejects.toThrow(UploadRefusedError);
  expect(r2.calls.map((c) => c.method)).toEqual(['HEAD']);
});

// The one answer that is not a verdict: without a size there is nothing to hold the object to,
// and deleting on "we could not read it" would throw away a good upload.
test('an object whose size the bucket did not report is left where it is', async () => {
  const db = openDb('default', binding);
  const hash = 'f'.repeat(64);
  const calls: string[] = [];
  const fetch = (async (input: Request) => {
    calls.push(input.method);
    return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
  }) as unknown as typeof globalThis.fetch;
  await expect(
    confirmUpload('default', db, store, { ...declared, hash }, { fetch }),
  ).rejects.toThrow(/content-length/);
  expect(calls).toEqual(['HEAD']);
  expect(await findMedia('default', db, hash)).toBeUndefined();
});

test('a verified upload writes the row the library reads', async () => {
  const db = openDb('default', binding);
  const hash = 'd'.repeat(64);
  const r2 = bucket({ [`media/${hash}.webp`]: { bytes: 12_345, mime: 'image/webp' } });
  const { media, created } = await confirmUpload(
    'default',
    db,
    store,
    { ...declared, hash },
    { fetch: r2.fetch, now: 1755864000000 },
  );
  expect(created).toBe(true);
  expect(media).toMatchObject({
    id: hash,
    r2Key: `media/${hash}.webp`,
    filename: 'seaview.jpg',
    mime: 'image/webp',
    bytes: 12_345,
    width: 2400,
    height: 1350,
    createdAt: 1755864000000,
  });
  expect(await findMedia('default', db, hash)).toMatchObject({ id: hash });
});

test('a hash the table already knows is answered from the row, and its object is left alone', async () => {
  const db = openDb('default', binding);
  const hash = 'e'.repeat(64);
  const r2 = bucket({ [`media/${hash}.webp`]: { bytes: 12_345, mime: 'image/webp' } });
  await confirmUpload('default', db, store, { ...declared, hash }, { fetch: r2.fetch });
  // A second confirm of bytes that are already stored: no head, no delete, no second row.
  const again = bucket({ [`media/${hash}.webp`]: { bytes: 1, mime: 'text/html' } });
  const { media, created } = await confirmUpload(
    'default',
    db,
    store,
    { ...declared, hash },
    { fetch: again.fetch },
  );
  expect(created).toBe(false);
  expect(media).toMatchObject({ id: hash, bytes: 12_345, mime: 'image/webp' });
  expect(again.calls).toEqual([]);
  expect(again.objects).toHaveProperty(`media/${hash}.webp`);
});
