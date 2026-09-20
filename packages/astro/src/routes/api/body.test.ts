import { expect, test } from 'vitest';
import {
  BodyStructureError,
  BodyTooLargeError,
  bodyErrorResponse,
  MAX_JSON_BYTES,
  readJson,
} from './body.js';

test('bounded JSON refuses a declared oversized body before reading it', async () => {
  const request = new Request('https://x/admin/api/drafts/x/y', {
    method: 'PUT',
    headers: { 'content-length': '9' },
    body: '{}',
  });
  await expect(readJson(request, 8)).rejects.toThrow(BodyTooLargeError);
});

test('bounded JSON refuses structures deeper than downstream schema walkers accept', async () => {
  const nested = `${'{"x":'.repeat(65)}null${'}'.repeat(65)}`;
  await expect(
    readJson(new Request('https://x/admin/api/drafts/x/y', { method: 'PUT', body: nested })),
  ).rejects.toThrow(BodyStructureError);
});

test('bounded JSON cancels a chunked body as soon as it crosses the cap', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('https://x/admin/api/drafts/x/y', {
    method: 'PUT',
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await expect(readJson(request, 8)).rejects.toThrow(BodyTooLargeError);
  expect(cancelled).toBe(true);
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
        controller.enqueue(new Uint8Array(MAX_JSON_BYTES + 1));
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

test('valid bounded bodies remain available to downstream JSON handlers', async () => {
  const request = new Request('https://x/admin/api/members', {
    method: 'POST',
    body: '{"name":"Lea"}',
  });
  expect(await bodyErrorResponse(request)).toBeUndefined();
  expect(await request.json()).toEqual({ name: 'Lea' });
});
