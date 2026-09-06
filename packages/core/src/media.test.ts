import { createHash } from 'node:crypto';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from './db.js';
import {
  checkStore,
  confirmUpload,
  cropWidth,
  deleteMedia,
  findMedia,
  MAX_UPLOAD_BYTES,
  mediaKey,
  mediaList,
  mediaUsage,
  mediaUsesFrom,
  namedBy,
  presignUpload,
  type R2Store,
  reconcileMedia,
  setMediaDetails,
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

const png = (tag: string) =>
  Buffer.concat([
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7zsAAAAASUVORK5CYII=',
      'base64',
    ),
    Buffer.from(tag),
  ]);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const temporary = (key: string) => `uploads/12345678-1234-1234-1234-123456789abc/${key}`;
function fixture(tag: string, mime = 'image/png') {
  const data = mime === 'application/pdf' ? Buffer.from(`%PDF-1.7 ${tag}`) : png(tag);
  const upload: Upload = {
    hash: digest(data),
    bytes: data.length,
    mime,
    filename: `${tag}.png`,
    width: 999,
    height: 999,
  };
  const key = mediaKey(upload);
  upload.key = temporary(key);
  const objects = new Map<string, { data: Uint8Array; mime: string; disposition?: string }>([
    [upload.key, { data, mime }],
  ]);
  const calls: Request[] = [];
  const fetch = (async (input: Request) => {
    calls.push(input);
    const key = new URL(input.url).pathname.slice(`/${store.bucket}/`.length);
    if (input.method === 'PUT') {
      objects.set(key, {
        data: new Uint8Array(await input.arrayBuffer()),
        mime: input.headers.get('content-type') ?? '',
        disposition: input.headers.get('content-disposition') ?? undefined,
      });
      return new Response(null, { status: 200 });
    }
    if (input.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    return object
      ? new Response(new Uint8Array(object.data), { headers: { 'content-type': object.mime } })
      : new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { data, upload, key, objects, fetch, calls };
}

test('only a temporary key can receive a five-minute client PUT', async () => {
  const key = temporary(`media/${HASH}.webp`);
  const url = new URL(await presignUpload(store, key));
  expect(url.pathname).toBe(`/${store.bucket}/${key}`);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  await expect(presignUpload(store, `media/${HASH}.webp`)).rejects.toThrow(UploadRefusedError);
});

test.each(['size', 'mime', 'hash', 'image'])(
  'a wrong %s is refused before finalization',
  async (wrong) => {
    const f = fixture(`bad-${wrong}`);
    if (wrong === 'size') f.upload.bytes++;
    if (wrong === 'mime') f.objects.set(f.upload.key ?? '', { data: f.data, mime: 'text/html' });
    if (wrong === 'hash') {
      const data = new Uint8Array(f.data);
      data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
      f.objects.set(f.upload.key ?? '', { data, mime: f.upload.mime });
    }
    if (wrong === 'image') {
      const data = Buffer.from('<script>not an image</script>');
      f.upload.hash = digest(data);
      f.upload.bytes = data.length;
      f.upload.key = temporary(mediaKey(f.upload));
      f.objects.set(f.upload.key, { data, mime: f.upload.mime });
    }
    await expect(
      confirmUpload('default', openDb('default', binding), store, f.upload, { fetch: f.fetch }),
    ).rejects.toThrow(UploadRefusedError);
    expect(f.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(await findMedia('default', openDb('default', binding), f.upload.hash)).toBeUndefined();
    expect(f.objects.has(f.upload.key ?? '')).toBe(false);
  },
);

test('a missing upload and a foreign temporary key are refused', async () => {
  const f = fixture('missing');
  f.objects.clear();
  await expect(
    confirmUpload('default', openDb('default', binding), store, f.upload, { fetch: f.fetch }),
  ).rejects.toThrow(/never reached/);
  await expect(
    confirmUpload(
      'default',
      openDb('default', binding),
      store,
      { ...f.upload, key: f.key },
      { fetch: f.fetch },
    ),
  ).rejects.toThrow(/temporary key/);
});

test('a disconnected object read retains the temporary bytes for retry', async () => {
  const f = fixture('disconnected');
  const failed = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  await expect(
    confirmUpload('default', openDb('default', binding), store, f.upload, { fetch: failed }),
  ).rejects.toThrow('offline');
  expect(f.objects.has(f.upload.key ?? '')).toBe(true);
  expect(
    (
      await confirmUpload('default', openDb('default', binding), store, f.upload, {
        fetch: f.fetch,
      })
    ).created,
  ).toBe(true);
});

test('finalization derives dimensions and replaying the upload URL cannot change the final object', async () => {
  const f = fixture('immutable');
  const db = openDb('default', binding);
  const result = await confirmUpload('default', db, store, f.upload, { fetch: f.fetch, now: 1700 });
  expect(result.media).toMatchObject({
    id: f.upload.hash,
    r2Key: f.key,
    width: 1,
    height: 1,
    bytes: f.data.length,
    createdAt: 1700,
  });
  expect(f.objects.has(f.upload.key ?? '')).toBe(false);
  const url = await presignUpload(store, f.upload.key ?? '');
  await f.fetch(
    new Request(url, { method: 'PUT', body: 'replaced', headers: { 'content-type': 'text/html' } }),
  );
  expect(f.objects.get(f.key)?.data).toEqual(new Uint8Array(f.data));
  const before = f.calls.length;
  expect((await confirmUpload('default', db, store, f.upload, { fetch: f.fetch })).created).toBe(
    false,
  );
  expect(f.calls).toHaveLength(before);
});

test('a temporary object changed after GET cannot race the verified final bytes', async () => {
  const f = fixture('race');
  const fetch = (async (input: Request) => {
    const response = await f.fetch(input);
    if (input.method === 'GET')
      f.objects.set(f.upload.key ?? '', { data: Buffer.from('evil'), mime: 'text/html' });
    return response;
  }) as unknown as typeof globalThis.fetch;
  await confirmUpload('default', openDb('default', binding), store, f.upload, { fetch });
  expect(f.objects.get(f.key)?.data).toEqual(new Uint8Array(f.data));
});

test('PDF bytes are verified and the final object is forced to download', async () => {
  const f = fixture('brochure', 'application/pdf');
  const { media } = await confirmUpload('default', openDb('default', binding), store, f.upload, {
    fetch: f.fetch,
  });
  expect(media).toMatchObject({ r2Key: f.key, width: null, height: null });
  expect(f.objects.get(f.key)?.disposition).toBe('attachment');
  const bad = fixture('wrong-pdf', 'application/pdf');
  const data = Buffer.from('<script>');
  bad.upload.hash = digest(data);
  bad.upload.bytes = data.length;
  bad.upload.key = temporary(mediaKey(bad.upload));
  bad.objects.set(bad.upload.key, { data, mime: bad.upload.mime });
  await expect(
    confirmUpload('default', openDb('default', binding), store, bad.upload, { fetch: bad.fetch }),
  ).rejects.toThrow(/not a PDF/);
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
    await db.insert(tables.media).values({
      id: hash,
      siteId: 'default',
      r2Key: mediaKey({ hash, bytes: 8, mime }),
      mime,
      bytes: 8,
      filename: hash.slice(0, 3),
      createdAt: now,
    });
  };
  await put('4'.repeat(64), 'image/webp', 1_000);
  await put('5'.repeat(64), 'application/pdf', 2_000);
  await put('6'.repeat(64), 'image/png', 3_000);
  // Other tests in this file share the table, so this is about these three rows.
  const mine = ['4', '5', '6'].map((c) => c.repeat(64));
  const listed = async (kind: 'images' | 'files') =>
    (await mediaList('default', db, { kind })).map((r) => r.id).filter((id) => mine.includes(id));
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

test('the library searches the file name and the tags, and only it sees the archived', async () => {
  const db = openDb('search', binding);
  const rows = [
    {
      id: 'a1'.repeat(32),
      filename: 'IMG_2041.jpg',
      tags: ['exterior', 'seaview'],
      archived: 0,
      createdAt: 3,
    },
    { id: 'b2'.repeat(32), filename: 'kitchen.jpg', tags: ['interior'], archived: 0, createdAt: 2 },
    {
      id: 'c3'.repeat(32),
      filename: 'old-banner.jpg',
      tags: ['seaview'],
      archived: 1,
      createdAt: 1,
    },
    { id: 'd4'.repeat(32), filename: 'IMGx2041.jpg', tags: [], archived: 0, createdAt: 0 },
  ];
  for (const row of rows)
    await db
      .insert(tables.media)
      .values({ ...row, siteId: 'search', r2Key: `media/${row.id}.webp`, mime: 'image/webp' });
  const found = async (query: Parameters<typeof mediaList>[2]) =>
    (await mediaList('search', db, query)).map((r) => r.filename);
  expect(await found({ kind: 'images', q: 'seaview' })).toEqual(['IMG_2041.jpg']);
  expect(await found({ kind: 'images', q: 'seaview', withArchived: true })).toEqual([
    'IMG_2041.jpg',
    'old-banner.jpg',
  ]);
  expect(await found({ kind: 'images', q: 'kitchen' })).toEqual(['kitchen.jpg']);
  // The underscore is the client's, not LIKE's: it matches itself and not the file beside it.
  expect(await found({ kind: 'images', q: 'IMG_2041' })).toEqual(['IMG_2041.jpg']);
});

const PHOTO = `media/${'1'.repeat(64)}.webp`;
const BROCHURE = `files/${'2'.repeat(64)}.pdf`;
const yaml = (...keys: string[]) =>
  `title: "Mill House"\nphoto:\n  src: "${keys[0] ?? PHOTO}"\nblocks:\n  - _type: "hero"\n    _id: "k3nf9a2p"\n    image:\n      src: "${keys[1] ?? PHOTO}"\n`;

test('a scan finds a stored key wherever it sits, and nothing that is not one', () => {
  const uses = mediaUsesFrom('default', [
    { path: 'src/content/listings/en/mill-house.yaml', contents: yaml(PHOTO, BROCHURE) },
    {
      path: 'src/content/pages/en/home.yaml',
      contents: 'title: "Home"\nsummary: "media/not-a-hash.webp"\n',
    },
    // Neither names an entry, so a key in one could never be counted against anything.
    { path: 'src/content/_templates/listings/holiday-let.yaml', contents: yaml() },
    { path: 'src/content/redirects.yaml', contents: yaml() },
  ]);
  expect(uses).toEqual({ 'src/content/listings/en/mill-house.yaml': [BROCHURE, PHOTO] });
});

test('an entry is one place however many of its languages carry the picture', () => {
  const uses = mediaUsesFrom('default', [
    { path: 'src/content/listings/en/mill-house.yaml', contents: yaml() },
    { path: 'src/content/listings/de/mill-house.yaml', contents: yaml() },
    { path: 'src/content/pages/en/home.yaml', contents: yaml() },
  ]);
  expect(mediaUsage('default', uses, [])).toEqual({
    [PHOTO]: ['listings/mill-house', 'pages/home'],
  });
});

test('a draft is what the entry uses now — the picture it dropped and the one it took', () => {
  const uses = mediaUsesFrom('default', [
    { path: 'src/content/listings/en/mill-house.yaml', contents: yaml() },
  ]);
  const swapped = mediaUsage('default', uses, [
    { path: 'src/content/listings/en/mill-house.yaml', contents: yaml(BROCHURE, BROCHURE) },
  ]);
  expect(swapped).toEqual({ [BROCHURE]: ['listings/mill-house'] });
  // An empty draft is a file the client has deleted: it names nothing at all.
  expect(
    mediaUsage('default', uses, [
      { path: 'src/content/listings/en/mill-house.yaml', contents: '' },
    ]),
  ).toEqual({});
});

test('reconciliation verifies orphans and skips bad hashes, types, sizes and temporary objects', async () => {
  const f = fixture('recover');
  const bad = fixture('bad-recover');
  f.objects.set(f.key, { data: f.data, mime: f.upload.mime });
  f.objects.set(bad.key, { data: Buffer.from('bad'), mime: bad.upload.mime });
  const keys = [f.key, bad.key, f.upload.key ?? '', 'backups/other.zip'];
  const list = lister([{ keys }]);
  const fetch = (async (input: Request) =>
    new URL(input.url).searchParams.has('list-type')
      ? new Response(
          `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key><Size>${key === f.key ? f.data.length : 3}</Size></Contents>`).join('')}</ListBucketResult>`,
        )
      : f.fetch(input)) as unknown as typeof globalThis.fetch;
  const db = openDb('recover', binding);
  expect(await reconcileMedia('recover', db, store, { fetch, now: 1700 })).toBe(1);
  expect(await findMedia('recover', db, f.upload.hash)).toMatchObject({
    width: 1,
    height: 1,
    createdAt: 1700,
  });
  expect(await findMedia('recover', db, bad.upload.hash)).toBeUndefined();
  expect(await reconcileMedia('recover', db, store, { fetch: list.fetch })).toBe(0);
});

test('a truncated listing is followed to the end', async () => {
  const { fetch, seen } = lister([
    { keys: ['foreign'], next: 'page-2' },
    { keys: ['also-foreign'] },
  ]);
  expect(await reconcileMedia('paged', openDb('paged', binding), store, { fetch })).toBe(0);
  expect(seen).toEqual([null, 'page-2']);
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

test('the gate counts a file that names the key, whichever file it is', () => {
  const files = [
    { path: 'src/content/listings/en/mill-house.yaml', contents: yaml() },
    { path: 'src/content/listings/de/mill-house.yaml', contents: yaml() },
    { path: 'src/content/pages/en/home.yaml', contents: yaml(BROCHURE, BROCHURE) },
    // Neither names an entry, and a starter that names a picture still names it.
    { path: 'src/content/_templates/listings/holiday-let.yaml', contents: yaml() },
  ];
  expect(namedBy(PHOTO, files)).toEqual([
    'listings/mill-house',
    'src/content/_templates/listings/holiday-let.yaml',
  ]);
  expect(namedBy(BROCHURE, files)).toEqual(['pages/home']);
  expect(namedBy(`media/${'9'.repeat(64)}.webp`, files)).toEqual([]);
});

// The badge lays drafts *over* the files, because it is about what the entry says now. The gate
// adds them instead: a picture pulled out of a listing this morning is on the published site
// until that listing is published, and deleting it would break the page that is live.
test('the gate adds the drafts to the tree rather than laying them over it', () => {
  const tree = [{ path: 'src/content/listings/en/mill-house.yaml', contents: yaml() }];
  const dropped = { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: "Mill"\n' };
  const took = { path: 'src/content/pages/en/home.yaml', contents: yaml(BROCHURE, BROCHURE) };
  expect(namedBy(PHOTO, [...tree, dropped])).toEqual(['listings/mill-house']);
  expect(namedBy(BROCHURE, [...tree, took])).toEqual(['pages/home']);
});

test('archiving is a flag on the row, and unarchiving takes it off again', async () => {
  const db = openDb('archive', binding);
  const id = 'e5'.repeat(32);
  await db.insert(tables.media).values({
    id,
    siteId: 'archive',
    r2Key: `media/${id}.webp`,
    mime: 'image/webp',
    createdAt: 1,
  });

  expect((await setMediaDetails('archive', db, id, { archived: true }))?.archived).toBe(1);
  expect((await setMediaDetails('archive', db, id, { archived: false }))?.archived).toBe(0);
  // A change to the words is not a change to the flag.
  await setMediaDetails('archive', db, id, { archived: true });
  expect((await setMediaDetails('archive', db, id, { alt: 'A mill' }))?.archived).toBe(1);
});

// The row goes first. An object left in the bucket with no row is what the hourly job exists
// for and comes back as *Recovered* within the hour; a row pointing at bytes that are gone is
// a broken picture nothing ever repairs.
test('a delete takes the row before the object, and both are gone', async () => {
  const db = openDb('delete', binding);
  const id = 'f6'.repeat(32);
  const key = `media/${id}.webp`;
  const order: string[] = [];
  await db
    .insert(tables.media)
    .values({ id, siteId: 'delete', r2Key: key, mime: 'image/webp', createdAt: 1 });
  const objects = { [key]: { bytes: 8, mime: 'image/webp' } };
  const r2 = bucket(objects);
  const fetch = (async (input: Request) => {
    order.push(`r2 ${input.method}`);
    return r2.fetch(input);
  }) as unknown as typeof globalThis.fetch;

  await deleteMedia('delete', db, store, { id, r2Key: key }, { fetch });

  expect(await findMedia('delete', db, id)).toBeUndefined();
  expect(objects[key]).toBeUndefined();
  expect(order).toEqual(['r2 DELETE']);
});

// The dot is what every crop holds on to, and it is the row's default rather than a page's:
// a page that set its own keeps it. Centre is what "nobody has set one" looks like.
test('the focal point is two numbers on the row, and centring it is saying nothing', async () => {
  const db = openDb('focal', binding);
  const id = 'a7'.repeat(32);
  await db.insert(tables.media).values({
    id,
    siteId: 'focal',
    r2Key: `media/${id}.webp`,
    mime: 'image/webp',
    createdAt: 1,
  });

  const moved = await setMediaDetails('focal', db, id, { focal: [0.42, 0.3] });
  expect([moved?.focalX, moved?.focalY]).toEqual([0.42, 0.3]);
  // The words are not the dot: writing one leaves the other where it was.
  const named = await setMediaDetails('focal', db, id, { alt: 'A mill' });
  expect([named?.focalX, named?.focalY]).toEqual([0.42, 0.3]);
  const back = await setMediaDetails('focal', db, id, { focal: [0.5, 0.5] });
  expect([back?.focalX, back?.focalY]).toEqual([0.5, 0.5]);
});

// A crop is a new picture made from an old one: its own bytes, its own row, and a line back to
// the parent. The original is not touched, which is the whole of why cropping is allowed at all.
test('a crop is confirmed as its own row, pointing at the picture it came from', async () => {
  const f = fixture('crop');
  const parent = 'b8'.repeat(32);
  const { media } = await confirmUpload(
    'default',
    openDb('default', binding),
    store,
    { ...f.upload, derivedFrom: parent },
    { fetch: f.fetch },
  );
  expect(media).toMatchObject({ id: f.upload.hash, derivedFrom: parent });
});

test('abandoned temporary uploads are verified and finalized only after their lease', async () => {
  const f = fixture('abandoned');
  const db = openDb('abandoned', binding);
  const fetch = (async (input: Request) =>
    new URL(input.url).searchParams.has('list-type')
      ? new Response(
          `<ListBucketResult><Contents><Key>${f.upload.key}</Key><Size>${f.data.length}</Size><LastModified>2026-09-06T00:00:00Z</LastModified></Contents></ListBucketResult>`,
        )
      : f.fetch(input)) as unknown as typeof globalThis.fetch;
  const at = Date.parse('2026-09-06T00:00:00Z');
  expect(await reconcileMedia('abandoned', db, store, { fetch, now: at + 299000 })).toBe(0);
  expect(f.objects.has(f.key)).toBe(false);
  expect(await reconcileMedia('abandoned', db, store, { fetch, now: at + 301000 })).toBe(1);
  expect(f.objects.has(f.key)).toBe(true);
  expect(f.objects.has(f.upload.key ?? '')).toBe(false);
  expect(await findMedia('abandoned', db, f.upload.hash)).toMatchObject({ width: 1, height: 1 });
});

test('failed finalization leaves no row and retry can finish the same upload', async () => {
  const f = fixture('failed-finalization');
  const db = openDb('default', binding);
  const fetch = (async (input: Request) =>
    input.method === 'PUT'
      ? new Response(null, { status: 503 })
      : f.fetch(input)) as unknown as typeof globalThis.fetch;
  await expect(confirmUpload('default', db, store, f.upload, { fetch })).rejects.toThrow(
    /finalization/,
  );
  expect(await findMedia('default', db, f.upload.hash)).toBeUndefined();
  expect(f.objects.has(f.upload.key ?? '')).toBe(true);
  expect((await confirmUpload('default', db, store, f.upload, { fetch: f.fetch })).created).toBe(
    true,
  );
});

test('a failed media row write retains staging for an immediate confirmation retry', async () => {
  const f = fixture('registration-retry');
  const real = openDb('default', binding);
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'insert')
        return () => {
          throw new Error('database offline');
        };
      return Reflect.get(target, property);
    },
  });
  await expect(confirmUpload('default', db, store, f.upload, { fetch: f.fetch })).rejects.toThrow(
    'database offline',
  );
  expect(f.objects.has(f.upload.key ?? '')).toBe(true);
  expect((await confirmUpload('default', real, store, f.upload, { fetch: f.fetch })).created).toBe(
    true,
  );
});
