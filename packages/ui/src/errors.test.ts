import { expect, test } from 'vitest';
import { messageText, problemText, responseMessage } from './errors.js';

test('scalar type validation formats from stable identities', () => {
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_TEXT' } }, 'en'),
  ).toBe('Enter text');
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_NUMBER' } }, 'de'),
  ).toBe('Gib eine Zahl ein');
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_BOOLEAN' } }, 'de'),
  ).toBe('Wähle ein oder aus');
  expect(problemText({ message: 'legacy', descriptor: { code: 'FIELD_INVALID_DATE' } }, 'de')).toBe(
    'Gib ein gültiges Datum ein',
  );
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_INVALID_SELECTION' } }, 'de'),
  ).toBe('Wähle eine der verfügbaren Optionen');
});

test('scalar bounds format safe parameters in either language', () => {
  expect(
    problemText(
      { message: 'legacy', descriptor: { code: 'FIELD_TEXT_TOO_SMALL', limit: 3 } },
      'en',
    ),
  ).toBe('Enter at least 3 characters');
  expect(
    problemText(
      {
        message: 'legacy',
        descriptor: { code: 'FIELD_NUMBER_TOO_SMALL', inclusive: false, limit: 0 },
      },
      'de',
    ),
  ).toBe('Gib eine Zahl größer als 0 ein');
  expect(
    problemText(
      {
        message: 'legacy',
        descriptor: { code: 'FIELD_NUMBER_TOO_BIG', inclusive: true, limit: 10 },
      },
      'en',
    ),
  ).toBe('Enter 10 or less');
});

test('malformed and unknown validation descriptors keep the legacy message', () => {
  expect(
    problemText(
      { message: 'Keep this', descriptor: { code: 'FIELD_TEXT_TOO_SMALL', limit: Number.NaN } },
      'de',
    ),
  ).toBe('Keep this');
  expect(
    problemText(
      {
        message: 'Keep this too',
        descriptor: { code: 'FIELD_NUMBER_TOO_BIG', limit: '10' as never },
      },
      'de',
    ),
  ).toBe('Keep this too');
  expect(problemText({ message: 'Authored', descriptor: { code: 'OTHER_RULE' } }, 'de')).toBe(
    'Authored',
  );
});

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

test('password length, token expiry, and general reset failures give different recovery', () => {
  expect(messageText({ code: 'PASSWORD_TOO_LONG' }, 'de')).toBe(
    'Darf höchstens 128 Zeichen lang sein',
  );
  expect(messageText({ code: 'TOKEN_EXPIRED' }, 'de')).toBe(
    'Der Link zum Zurücksetzen ist abgelaufen oder wurde bereits verwendet. Fordern Sie einen neuen Link an und versuchen Sie es erneut.',
  );
  expect(messageText({ code: 'AUTH_RESET_FAILED' }, 'de')).toBe(
    'Das Passwort konnte nicht zurückgesetzt werden. Bitte versuchen Sie es erneut.',
  );
});
