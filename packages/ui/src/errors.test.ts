import { expect, test } from 'vitest';
import { messageText, responseMessage } from './errors.js';

test('a synthetic connection failure keeps a stable localizable identity', async () => {
  const descriptor = await responseMessage(
    new Response('Connection lost. Your changes were kept. Please try again.', {
      status: 503,
      headers: { 'x-handover-error-code': 'CONNECTION_LOST' },
    }),
    'ACCOUNT_SAVE_FAILED',
  );

  expect(descriptor).toEqual({ code: 'CONNECTION_LOST', status: 503 });
  expect(messageText(descriptor, 'en')).toBe(
    'Connection lost. Your changes may have been saved. Please try again.',
  );
  expect(messageText(descriptor, 'de')).toBe(
    'Verbindung unterbrochen. Ihre Änderungen wurden möglicherweise gespeichert. Bitte versuchen Sie es erneut.',
  );
});

test('a known authentication code wins over its English response text', async () => {
  const descriptor = await responseMessage(
    Response.json({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, { status: 400 }),
    'ACCOUNT_PASSWORD_FAILED',
  );

  expect(descriptor).toEqual({ code: 'INVALID_PASSWORD', status: 400 });
  expect(messageText(descriptor, 'de')).toBe('Das aktuelle Passwort ist nicht richtig.');
});

test('unknown technical detail stays separate from the localized summary', async () => {
  const descriptor = await responseMessage(
    Response.json({ error: 'upstream trace 7A' }, { status: 502 }),
    'ACCOUNT_PASSWORD_FAILED',
  );

  expect(descriptor).toEqual({
    code: 'ACCOUNT_PASSWORD_FAILED',
    status: 502,
    detail: 'upstream trace 7A',
  });
  expect(messageText(descriptor, 'de')).toBe('Das Passwort konnte nicht gespeichert werden.');
});
