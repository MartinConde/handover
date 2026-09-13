import { z } from 'astro/zod';
import { expect, test } from 'vitest';
import { entryProblems } from '../../astro/src/problems.js';
import { messageText, problemText, responseMessage } from './errors.js';

test('integer and ordinary number problems render distinct remedies', () => {
  const problems = entryProblems(z.object({ whole: z.number().int(), amount: z.number() }), {
    whole: 1.5,
    amount: '1.5',
  });
  expect(problems.map((problem) => problemText(problem, 'en'))).toEqual([
    'Enter a whole number',
    'Enter a number',
  ]);
  expect(problems.map((problem) => problemText(problem, 'de'))).toEqual([
    'Gib eine ganze Zahl ein',
    'Gib eine Zahl ein',
  ]);
});

test('scalar type validation formats from stable identities', () => {
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_TEXT' } }, 'en'),
  ).toBe('Enter text');
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_NUMBER' } }, 'de'),
  ).toBe('Gib eine Zahl ein');
  expect(
    problemText({ message: 'legacy', descriptor: { code: 'FIELD_EXPECTED_INTEGER' } }, 'de'),
  ).toBe('Gib eine ganze Zahl ein');
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

test.each([
  [
    'minimum with no exact flag',
    { code: 'FIELD_TEXT_TOO_SMALL', limit: 1 },
    'Enter at least 1 character',
  ],
  ['minimum plural', { code: 'FIELD_TEXT_TOO_SMALL', limit: 2 }, 'Enter at least 2 characters'],
  [
    'maximum with exact false',
    { code: 'FIELD_TEXT_TOO_BIG', limit: 1, exact: false },
    'Enter no more than 1 character',
  ],
  [
    'maximum plural',
    { code: 'FIELD_TEXT_TOO_BIG', limit: 2, exact: false },
    'Enter no more than 2 characters',
  ],
  [
    'exact with exact true',
    { code: 'FIELD_TEXT_TOO_SMALL', limit: 1, exact: true },
    'Enter exactly 1 character',
  ],
  [
    'exact plural',
    { code: 'FIELD_TEXT_TOO_SMALL', limit: 2, exact: true },
    'Enter exactly 2 characters',
  ],
  [
    'malformed exact flag',
    { code: 'FIELD_TEXT_TOO_SMALL', limit: 3, exact: 'yes' },
    'Keep text rule',
  ],
  [
    'numeric flag on a text rule',
    { code: 'FIELD_TEXT_TOO_SMALL', limit: 3, inclusive: true },
    'Keep text rule',
  ],
] as const)('%s preserves the text-bound rule', (_name, descriptor, expected) => {
  expect(problemText({ message: 'Keep text rule', descriptor: descriptor as never }, 'en')).toBe(
    expected,
  );
});

test.each([
  [
    'inclusive decimal',
    { code: 'FIELD_NUMBER_TOO_SMALL', limit: 1.5, inclusive: true },
    'de',
    'Gib 1,5 oder mehr ein',
  ],
  [
    'exclusive small decimal',
    { code: 'FIELD_NUMBER_TOO_SMALL', limit: 0.0001, inclusive: false },
    'de',
    'Gib eine Zahl größer als 0,0001 ein',
  ],
  [
    'inclusive high precision',
    { code: 'FIELD_NUMBER_TOO_BIG', limit: 123456789.12345679, inclusive: true },
    'de',
    'Gib 123456789,12345679 oder weniger ein',
  ],
  [
    'exclusive high precision',
    { code: 'FIELD_NUMBER_TOO_BIG', limit: 0.1234567890123456, inclusive: false },
    'de',
    'Gib eine Zahl kleiner als 0,1234567890123456 ein',
  ],
  ['missing inclusive flag', { code: 'FIELD_NUMBER_TOO_BIG', limit: 10 }, 'en', 'Keep number rule'],
  [
    'malformed inclusive flag',
    { code: 'FIELD_NUMBER_TOO_SMALL', limit: 10, inclusive: 'yes' },
    'en',
    'Keep number rule',
  ],
  [
    'text flag on a numeric rule',
    { code: 'FIELD_NUMBER_TOO_SMALL', limit: 10, inclusive: true, exact: true },
    'en',
    'Keep number rule',
  ],
] as const)('%s preserves the numeric-bound rule', (_name, descriptor, locale, expected) => {
  expect(
    problemText({ message: 'Keep number rule', descriptor: descriptor as never }, locale),
  ).toBe(expected);
});

test('formatting a numeric bound does not alter its raw parameter', () => {
  const descriptor = {
    code: 'FIELD_NUMBER_TOO_SMALL',
    limit: 0.0001,
    inclusive: false,
  } as const;
  expect(problemText({ message: 'legacy', descriptor }, 'de')).toBe(
    'Gib eine Zahl größer als 0,0001 ein',
  );
  expect(descriptor).toEqual({
    code: 'FIELD_NUMBER_TOO_SMALL',
    limit: 0.0001,
    inclusive: false,
  });
});

test.each([
  ['NaN limit', { code: 'FIELD_TEXT_TOO_SMALL', limit: Number.NaN }],
  [
    'infinite limit',
    { code: 'FIELD_NUMBER_TOO_BIG', limit: Number.POSITIVE_INFINITY, inclusive: true },
  ],
  ['non-numeric limit', { code: 'FIELD_NUMBER_TOO_BIG', limit: '10', inclusive: true }],
  ['unknown code', { code: 'OTHER_RULE' }],
] as const)('%s keeps the legacy message', (_name, descriptor) => {
  expect(problemText({ message: 'Authored fallback', descriptor: descriptor as never }, 'de')).toBe(
    'Authored fallback',
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
