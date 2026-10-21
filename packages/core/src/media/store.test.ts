import { expect, test } from 'vitest';
import { checkStore, MAX_UPLOAD_BYTES, mediaKey, type R2Store, type Upload } from './store.js';
import { UploadRefusedError } from './upload-bytes.js';

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

// R2's two refusals say different things: 403 is the credential, 404 is the bucket.
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
