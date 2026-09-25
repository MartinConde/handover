import { expect, test } from 'vitest';
import {
  BodyStructureError,
  bodyErrorResponse,
  MAX_JSON_BYTES,
  readBodyText,
  readJson,
} from './body.js';

test('bounded JSON refuses structures deeper than downstream schema walkers accept', async () => {
  const nested = `${'{"x":'.repeat(65)}null${'}'.repeat(65)}`;
  await expect(
    readJson(new Request('https://x/admin/api/drafts/x/y', { method: 'PUT', body: nested })),
  ).rejects.toThrow(BodyStructureError);
});

test.each([undefined, 'text/plain', 'application/octet-stream'])(
  'the API body limit cannot be bypassed with content-type %s',
  async (contentType) => {
    const response = await bodyErrorResponse(
      new Request('https://x/admin/api/members', {
        method: 'POST',
        headers: {
          'content-length': String(MAX_JSON_BYTES + 1),
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        body: '{}',
      }),
    );
    expect(response?.status).toBe(413);
  },
);

test('oversized chunked API bodies are rejected without waiting for the unread request branch', async () => {
  let cancelled = false;
  const request = new Request('https://x/admin/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_JSON_BYTES / 2 + 1));
        controller.enqueue(new Uint8Array(MAX_JSON_BYTES / 2 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    bodyErrorResponse(request),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 200);
    }),
  ]);
  if (timer) clearTimeout(timer);
  expect(response?.status).toBe(413);
  expect(cancelled).toBe(true);
});

test('valid bounded bodies are parsed once for downstream JSON and text handlers', async () => {
  let reads = 0;
  const request = new Request('https://x/admin/api/members', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new TextEncoder().encode('{"name":"Lea"}'));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  expect(await bodyErrorResponse(request)).toBeUndefined();
  const parsed = await readJson(request);
  expect(parsed).toEqual({ name: 'Lea' });
  expect(await readJson(request)).toBe(parsed);
  expect(await readBodyText(request)).toBe('{"name":"Lea"}');
  expect(reads).toBe(1);
});
