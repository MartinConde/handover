import { expect, test, vi } from 'vitest';
import { uploadBlob, uploadFile } from './upload.js';

const bytes = new Uint8Array([1, 2, 3, 4]);
// sha-256 of those four bytes, hand-computed with `printf '\x01\x02\x03\x04' | shasum -a 256`.
const HASH = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
const blob = () => new Blob([bytes], { type: 'image/webp' });

/** The admin's own endpoints and the bucket, as one fake: every call, in the order it was made. */
function server(answers: Record<string, unknown>) {
  const calls: { url: string; method: string; type?: string; disposition?: string }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(init?.headers
        ? {
            type: (init.headers as Record<string, string>)['content-type'],
            disposition: (init.headers as Record<string, string>)['content-disposition'],
          }
        : {}),
    });
    const answer = answers[`${method} ${url}`];
    if (answer === undefined) return new Response(null, { status: 200 });
    if (answer instanceof Response) return answer;
    return Response.json(answer);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

test('bytes the site already holds are never uploaded', async () => {
  const { fetch, calls } = server({
    'POST /admin/api/media': { media: { id: HASH, src: `media/${HASH}.webp` } },
  });
  const media = await uploadBlob(blob(), { filename: 'mill.webp' }, { fetch });
  expect(media).toMatchObject({ id: HASH, src: `media/${HASH}.webp` });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /admin/api/media']);
});

test('a new file goes straight to the bucket and is confirmed afterwards', async () => {
  const { fetch, calls } = server({
    'POST /admin/api/media': { upload: { key: `media/${HASH}.webp`, url: 'https://bucket/put' } },
    [`PUT /admin/api/media/${HASH}`]: { media: { id: HASH, src: `media/${HASH}.webp` } },
  });
  const media = await uploadBlob(
    blob(),
    { filename: 'mill.webp', width: 2400, height: 1350 },
    { fetch },
  );
  expect(media).toMatchObject({ id: HASH });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'POST /admin/api/media',
    'PUT https://bucket/put',
    `PUT /admin/api/media/${HASH}`,
  ]);
  // The declaration the Worker verifies the object against is the one it signed for.
  expect(calls[1]?.type).toBe('image/webp');
});

test('a refusal reaches the caller in the words the Worker used', async () => {
  const { fetch } = server({
    'POST /admin/api/media': Response.json(
      { error: 'an upload may be at most 10MB' },
      { status: 422 },
    ),
  });
  await expect(uploadBlob(blob(), { filename: 'huge.webp' }, { fetch })).rejects.toThrow(
    'an upload may be at most 10MB',
  );
});

test('a file goes to the bucket as it is, and is stored as a download', async () => {
  // sha-256 of those four bytes, hand-computed with `printf '%%PDF' | shasum -a 256`.
  const hash = '315d429b7714cedb6ad04ac31240145257692630457f3c88253c5beceac76027';
  const { fetch, calls } = server({
    'POST /admin/api/media': { upload: { key: `files/${hash}.pdf`, url: 'https://bucket/put' } },
    [`PUT /admin/api/media/${hash}`]: { media: { id: hash, src: `files/${hash}.pdf` } },
  });
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'brochure.pdf', {
    type: 'application/pdf',
  });
  const media = await uploadFile(pdf, { fetch });
  expect(media).toMatchObject({ src: `files/${hash}.pdf` });
  // No canvas step: the bytes that were chosen are the bytes that are stored.
  expect(calls[1]).toMatchObject({
    method: 'PUT',
    url: 'https://bucket/put',
    type: 'application/pdf',
    disposition: 'attachment',
  });
});
