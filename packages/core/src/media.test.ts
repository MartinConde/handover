import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from './db.js';
import {
  checkStore,
  confirmUpload,
  cropWidth,
  findMedia,
  MAX_UPLOAD_BYTES,
  mediaKey,
  mediaList,
  presignUpload,
  type R2Store,
  reconcileMedia,
  tooSmall,
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
function bucket(
  objects: Record<string, { bytes: number; mime: string; disposition?: string; body?: string }>,
) {
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
    const headers: Record<string, string> = {
      'content-length': String(found.bytes),
      'content-type': found.mime,
      ...(found.disposition ? { 'content-disposition': found.disposition } : {}),
    };
    // A range is answered as one: 206, the bytes asked for, and the whole size in content-range.
    if (input.method === 'GET')
      return new Response((found.body ?? '').slice(0, 8), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 0-7/${found.bytes}` },
      });
    return new Response(null, { status: 200, headers });
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

test('a pdf is stored under files/, an image under media/', () => {
  const pdf: Upload = { hash: HASH, bytes: 2_481_033, mime: 'application/pdf', filename: 'b.pdf' };
  expect(mediaKey(pdf)).toBe(`files/${HASH}.pdf`);
  expect(mediaKey(declared)).toBe(`media/${HASH}.webp`);
});

test('a file the bucket would render inline is deleted and refused', async () => {
  const db = openDb('default', binding);
  const hash = '1'.repeat(64);
  const r2 = bucket({
    [`files/${hash}.pdf`]: { bytes: 5, mime: 'application/pdf', body: '%PDF-1.7' },
  });
  await expect(
    confirmUpload(
      'default',
      db,
      store,
      { hash, bytes: 5, mime: 'application/pdf' },
      { fetch: r2.fetch },
    ),
  ).rejects.toThrow(/download/);
  expect(r2.objects).toEqual({});
});

test('bytes that are not the type they were uploaded as are deleted and refused', async () => {
  const db = openDb('default', binding);
  const hash = '2'.repeat(64);
  const r2 = bucket({
    [`files/${hash}.pdf`]: {
      bytes: 5,
      mime: 'application/pdf',
      disposition: 'attachment',
      body: '<script>',
    },
  });
  await expect(
    confirmUpload(
      'default',
      db,
      store,
      { hash, bytes: 5, mime: 'application/pdf' },
      { fetch: r2.fetch },
    ),
  ).rejects.toThrow(/not a pdf/i);
  expect(r2.calls.map((c) => c.method)).toEqual(['HEAD', 'GET', 'DELETE']);
  expect(r2.objects).toEqual({});
  expect(await findMedia('default', db, hash)).toBeUndefined();
});

test('a verified pdf writes its row', async () => {
  const db = openDb('default', binding);
  const hash = '3'.repeat(64);
  const r2 = bucket({
    [`files/${hash}.pdf`]: {
      bytes: 8,
      mime: 'application/pdf',
      disposition: 'attachment',
      body: '%PDF-1.7',
    },
  });
  const { media } = await confirmUpload(
    'default',
    db,
    store,
    { hash, bytes: 8, mime: 'application/pdf', filename: 'brochure.pdf' },
    { fetch: r2.fetch, now: 1755864000000 },
  );
  expect(media).toMatchObject({ id: hash, r2Key: `files/${hash}.pdf`, filename: 'brochure.pdf' });
});

test('the widest crop at a ratio is what a picture is measured by, not its longest side', () => {
  // A landscape source: the 16:9 crop is limited by the height it has to fill.
  expect(cropWidth(2400, 1600, '16:9')).toBe(2400);
  expect(cropWidth(800, 450, '16:9')).toBe(800);
  // The phone photo the rule exists for: 1600 px tall, and still only a 900 px hero.
  expect(cropWidth(900, 1600, '16:9')).toBe(900);
  expect(cropWidth(2000, 1500, '16:9')).toBe(2000);
  expect(cropWidth(1000, 2000, '1:1')).toBe(1000);
  // No ratio to crop to: the picture is as wide as it is.
  expect(cropWidth(900, 1600, undefined)).toBe(900);
});

test('a source under the field floor is refused in both numbers, naming the crop', () => {
  const hero = { ratio: '16:9', max: 2400, min: 1600 };
  expect(tooSmall(hero, 800, 450)).toBe(
    'Too small for this field — its widest 16:9 crop is 800 px, this field needs 1600',
  );
  expect(tooSmall(hero, 900, 1600)).toBe(
    'Too small for this field — its widest 16:9 crop is 900 px, this field needs 1600',
  );
  expect(tooSmall(hero, 2400, 1600)).toBeUndefined();
  // Exactly the floor is not under it.
  expect(tooSmall(hero, 1600, 900)).toBeUndefined();
});

test('a field with no floor refuses nothing, and one with no ratio measures the file', () => {
  expect(tooSmall({ max: 2400 }, 40, 30)).toBeUndefined();
  expect(tooSmall({ max: 1600, min: 1600 }, 800, 600)).toBe(
    'Too small for this field — it is 800 px wide, this field needs 1600',
  );
});

test('the library is newest first, and pictures and files are two lists', async () => {
  const db = openDb('default', binding);
  const put = async (hash: string, mime: string, now: number) => {
    const key = mediaKey({ hash, bytes: 8, mime });
    const r2 = bucket({
      [key]: { bytes: 8, mime, disposition: 'attachment', body: '%PDF-1.7' },
    });
    await confirmUpload(
      'default',
      db,
      store,
      { hash, bytes: 8, mime, filename: `${hash.slice(0, 3)}` },
      { fetch: r2.fetch, now },
    );
  };
  await put('4'.repeat(64), 'image/webp', 1_000);
  await put('5'.repeat(64), 'application/pdf', 2_000);
  await put('6'.repeat(64), 'image/png', 3_000);
  // Other tests in this file share the table, so this is about these three rows.
  const mine = ['4', '5', '6'].map((c) => c.repeat(64));
  const listed = async (kind: 'images' | 'files') =>
    (await mediaList('default', db, kind)).map((r) => r.id).filter((id) => mine.includes(id));
  expect(await listed('images')).toEqual(['6'.repeat(64), '4'.repeat(64)]);
  expect(await listed('files')).toEqual(['5'.repeat(64)]);
});

/** The bucket's own listing, in one page or several. */
const lister = (pages: { keys: string[]; next?: string }[]) => {
  const seen: (string | null)[] = [];
  const fetch = (async (input: Request) => {
    const url = new URL(input.url);
    seen.push(url.searchParams.get('continuation-token'));
    const page = pages[seen.length - 1] ?? { keys: [], next: undefined };
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${store.bucket}</Name>${page.keys
        .map((key) => `<Contents><Key>${key}</Key><Size>2048</Size></Contents>`)
        .join('')}<IsTruncated>${Boolean(page.next)}</IsTruncated>${
        page.next ? `<NextContinuationToken>${page.next}</NextContinuationToken>` : ''
      }</ListBucketResult>`,
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
};

const ORPHAN = '7'.repeat(64);

test('an object with no row is recovered from the listing alone, with no HEAD', async () => {
  const db = openDb('recover', binding);
  const { fetch, seen } = lister([{ keys: [`media/${ORPHAN}.webp`] }]);

  expect(await reconcileMedia('recover', db, store, { fetch, now: 1700 })).toBe(1);

  const row = await findMedia('recover', db, ORPHAN);
  expect(row).toMatchObject({
    r2Key: `media/${ORPHAN}.webp`,
    mime: 'image/webp',
    bytes: 2048,
    createdAt: 1700,
    width: null,
    height: null,
  });
  expect(seen).toEqual([null]);
});

test('an object the table already knows is left alone', async () => {
  const db = openDb('recover', binding);
  const again = lister([{ keys: [`media/${ORPHAN}.webp`] }]);

  expect(await reconcileMedia('recover', db, store, { fetch: again.fetch, now: 9900 })).toBe(0);
  expect(await findMedia('recover', db, ORPHAN)).toMatchObject({ createdAt: 1700 });
});

test('an object nothing here ever wrote is not claimed', async () => {
  const db = openDb('foreign', binding);
  const { fetch } = lister([{ keys: ['backups/2026-08-01.zip', 'media/not-a-hash.webp'] }]);

  expect(await reconcileMedia('foreign', db, store, { fetch, now: 1700 })).toBe(0);
});

test('a truncated listing is followed to the end', async () => {
  const db = openDb('paged', binding);
  const one = `media/${'8'.repeat(64)}.webp`;
  const two = `files/${'9'.repeat(64)}.pdf`;
  const { fetch, seen } = lister([{ keys: [one], next: 'page-2' }, { keys: [two] }]);

  expect(await reconcileMedia('paged', db, store, { fetch, now: 1700 })).toBe(2);
  expect(seen).toEqual([null, 'page-2']);
  expect(await findMedia('paged', db, '9'.repeat(64))).toMatchObject({ mime: 'application/pdf' });
});

test('a site with no bucket has nothing to reconcile and does not fail', async () => {
  expect(await reconcileMedia('nobucket', openDb('nobucket', binding), undefined)).toBe(0);
});

/** The bucket for the connection check: what each request was, and what it answers. */
function checkable(refuse?: { method: string; status: number }, body = 'handover') {
  const calls: { method: string; key: string; body: string }[] = [];
  const fetch = (async (input: Request) => {
    const key = new URL(input.url).pathname.slice(`/${store.bucket}/`.length);
    calls.push({ method: input.method, key, body: await input.text() });
    if (refuse?.method === input.method) return new Response('no', { status: refuse.status });
    if (input.method === 'GET') return new Response(body);
    return new Response(null, { status: input.method === 'DELETE' ? 204 : 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test('the connection check writes one object, reads it back and deletes it again', async () => {
  const r2 = checkable();
  await checkStore(store, { fetch: r2.fetch });
  expect(r2.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
  // Not `mediaKey`'s shape, so the reconciliation job never adopts it as somebody's upload.
  expect(new Set(r2.calls.map((c) => c.key))).toEqual(new Set(['checks/connection.txt']));
  expect(r2.calls[0]?.body).toBe('handover');
});

test('a bucket that will not take the object names the step that refused', async () => {
  const r2 = checkable({ method: 'PUT', status: 403 });
  await expect(checkStore(store, { fetch: r2.fetch })).rejects.toThrow(
    'The bucket refused the upload (403)',
  );
  // Nothing is read back or deleted once the write is refused.
  expect(r2.calls.map((c) => c.method)).toEqual(['PUT']);
});

// A refusal is only useful if it names the fix, and R2's two say different things: 403 is the
// credential, 404 is the bucket this site was pointed at.
test('a refused write says which of the four values to look at', async () => {
  await expect(
    checkStore(store, { fetch: checkable({ method: 'PUT', status: 403 }).fetch }),
  ).rejects.toThrow(/R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.*Object Read & Write/s);
  await expect(
    checkStore(store, { fetch: checkable({ method: 'PUT', status: 404 }).fetch }),
  ).rejects.toThrow(/R2_ACCOUNT_ID and R2_BUCKET.*site-media/s);
});

test('a bucket that stores something other than what was written says so', async () => {
  const r2 = checkable(undefined, 'something else');
  await expect(checkStore(store, { fetch: r2.fetch })).rejects.toThrow(
    'The bucket read back something other than what was written',
  );
  // The object still goes: a check that leaves its own litter behind is worse than no check.
  expect(r2.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
});
