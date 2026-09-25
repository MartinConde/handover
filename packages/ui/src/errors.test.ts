import { z } from 'astro/zod';
import { expect, test } from 'vitest';
import { entryProblems } from '../../astro/src/problems.js';
import { messageLine, messageText, problemText, responseMessage } from './errors.js';

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
    'Verbindung unterbrochen. Deine Änderungen wurden möglicherweise gespeichert. Versuche es erneut.',
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

test('offsite and address descriptors preserve parameters and translate in German', async () => {
  const locale = await responseMessage(
    Response.json(
      {
        code: 'ENTRY_LOCALE_LAST_PUBLISHED',
        error: 'legacy prose',
        locales: ['de'],
        remaining: ['en'],
      },
      { status: 409 },
    ),
    'ENTRY_ACTION_FAILED',
  );
  expect(locale).toEqual({
    code: 'ENTRY_LOCALE_LAST_PUBLISHED',
    status: 409,
    locales: ['de'],
    remaining: ['en'],
  });
  expect(messageText(locale, 'de')).toContain('Deutsch');
  expect(messageText(locale, 'de')).toContain('Englisch');

  const address = await responseMessage(
    Response.json(
      {
        code: 'ENTRY_ADDRESS_TAKEN',
        error: 'legacy prose',
        address: 'belegt',
        collection: 'posts',
        locale: 'de',
      },
      { status: 409 },
    ),
    'ENTRY_ACTION_FAILED',
  );
  expect(messageText(address, 'de')).toBe(
    'belegt ist bereits die Webadresse eines anderen Eintrags in posts auf Deutsch.',
  );
});

test('publish descriptors preserve recovery identity and plural parameters', async () => {
  const moved = await responseMessage(
    Response.json({ code: 'PUBLISH_REF_MOVED', error: 'main moved past abc123' }, { status: 409 }),
    'PUBLISH_FAILED',
  );
  expect(moved).toEqual({ code: 'PUBLISH_REF_MOVED', status: 409 });
  expect(messageText(moved, 'de')).toContain('Repository');

  expect(messageText({ code: 'PUBLISH_CONFLICT', count: 1 }, 'en')).toContain('One entry changed');
  expect(messageText({ code: 'PUBLISH_CONFLICT', count: 2 }, 'de')).toContain('2 Einträge wurden');
  expect(messageText({ code: 'PUBLISH_FINALIZATION_PENDING' }, 'de')).toContain(
    'konnte nicht bestätigt werden',
  );
});

test('a refused publish selection is explained from its code in either language', async () => {
  const refused = await responseMessage(
    Response.json(
      { code: 'PUBLISH_EXCLUDE_SOURCE', error: 'src/content/x/en/y.yaml is the language…' },
      { status: 422, headers: { 'x-handover-error-code': 'PUBLISH_EXCLUDE_SOURCE' } },
    ),
    'PUBLISH_FAILED',
  );
  expect(refused).toEqual({ code: 'PUBLISH_EXCLUDE_SOURCE', status: 422 });
  expect(messageText(refused, 'en')).toBe(
    'Nothing was published. The language this entry is written in cannot be published later; it goes out with the entry.',
  );
  expect(messageText({ code: 'PUBLISH_EXCLUDE_PUBLISHED' }, 'en')).toBe(
    'Nothing was published. A language you chose to publish later is already published, so it goes out with the entry.',
  );
  expect(messageText({ code: 'PUBLISH_EXCLUDE_NOT_PENDING' }, 'en')).toBe(
    'Nothing was published. A language you chose to publish later has no unpublished changes any more. Check again and publish.',
  );
  expect(messageText({ code: 'PUBLISH_EXCLUDE_ALL' }, 'en')).toBe(
    'Nothing was published. With those languages left for later there is nothing left to publish.',
  );
  expect(messageText({ code: 'PUBLISH_SELECTION_INVALID' }, 'en')).toBe(
    'Nothing was published. The request did not say clearly what to publish. Reload and try again.',
  );
  expect(messageText({ code: 'PUBLISH_EXCLUDE_SOURCE' }, 'de')).toBe(
    'Nichts wurde veröffentlicht. Die Sprache, in der dieser Eintrag geschrieben ist, kann nicht später veröffentlicht werden; sie wird mit dem Eintrag veröffentlicht.',
  );
});

test('password length, token expiry, and general reset failures give different recovery', () => {
  expect(messageText({ code: 'PASSWORD_TOO_LONG' }, 'de')).toBe(
    'Darf höchstens 128 Zeichen lang sein',
  );
  expect(messageText({ code: 'TOKEN_EXPIRED' }, 'de')).toBe(
    'Der Link zum Zurücksetzen ist abgelaufen oder wurde bereits verwendet. Fordere einen neuen Link an und versuche es erneut.',
  );
  expect(messageText({ code: 'AUTH_RESET_FAILED' }, 'de')).toBe(
    'Das Passwort konnte nicht zurückgesetzt werden. Versuche es erneut.',
  );
});

test.each([
  [
    'ENTRY_SOURCE_TARGET_UNDECLARED',
    'That language isn’t one this site declares, so it can’t be the source.',
    'Diese Sprache ist auf dieser Website nicht eingerichtet und kann daher nicht die Ausgangssprache sein.',
  ],
  [
    'ENTRY_SOURCE_UNCHANGED',
    'This entry is already written in that language. Nothing was changed.',
    'Dieser Eintrag ist bereits in dieser Sprache geschrieben. Nichts wurde geändert.',
  ],
  [
    'ENTRY_SOURCE_TARGET_MISSING',
    'That language has no file for this entry yet. Create it before making it the source.',
    'Für diese Sprache hat der Eintrag noch keine Datei. Leg sie an, bevor du sie zur Ausgangssprache machst.',
  ],
  [
    'ENTRY_SOURCE_TARGET_OFF',
    'That language is turned off for this entry. Turn it on and create its file first.',
    'Diese Sprache ist für diesen Eintrag ausgeschaltet. Schalte sie ein und leg zuerst ihre Datei an.',
  ],
  [
    'ENTRY_SOURCE_REVISION',
    'Somebody changed this entry while you were choosing. Nothing was changed — reload the entry and try again.',
    'Jemand hat diesen Eintrag geändert, während du gewählt hast. Nichts wurde geändert — lade den Eintrag neu und versuch es noch einmal.',
  ],
  [
    'ENTRY_SOURCE_DRIFT',
    'The languages of this entry disagree about its blocks — settle that first. Nothing was changed.',
    'Die Sprachen dieses Eintrags stimmen bei den Blöcken nicht überein — kläre das zuerst. Nichts wurde geändert.',
  ],
  [
    'ENTRY_SOURCE_ONLY_CONFLICT',
    'That language has its own values in fields only the source keeps. Clear them first — nothing was changed.',
    'Diese Sprache hat eigene Werte in Feldern, die nur die Ausgangssprache führt. Leere sie zuerst — nichts wurde geändert.',
  ],
  [
    'ENTRY_SOURCE_TARGET_INVALID',
    'As the source, that language would not pass the site’s checks. Fix its problems first — nothing was changed.',
    'Als Ausgangssprache würde diese Sprache die Prüfungen der Website nicht bestehen. Behebe zuerst ihre Probleme — nichts wurde geändert.',
  ],
])('a source change refused with %s reads in either language', async (code, en, de) => {
  const message = await responseMessage(
    Response.json({ code, error: 'the API’s own sentence' }, { status: 409 }),
    'ENTRY_ACTION_FAILED',
  );
  expect(message).toEqual({ code, status: 409 });
  expect(messageText(message, 'en')).toBe(en);
  expect(messageText(message, 'de')).toBe(de);
});

test('an unresolved source refusal reads the same for all three codes, in either language', async () => {
  for (const code of ['ENTRY_SOURCE_CONFLICT', 'ENTRY_SOURCE_UNDECLARED', 'ENTRY_SOURCE_MISSING']) {
    const message = await responseMessage(
      Response.json({ code, error: 'legacy prose', marks: { en: 'en' } }, { status: 409 }),
      'EDITOR_SAVE_REFUSED',
    );
    expect(message).toEqual({ code, status: 409 });
    expect(messageText(message, 'en')).toBe(
      'This entry’s files no longer agree about the language it is written in. Reload it to see what each file says.',
    );
    expect(messageText(message, 'de')).toBe(
      'Die Dateien dieses Eintrags nennen keine gemeinsame Ausgangssprache mehr. Lade ihn neu, um zu sehen, was jede Datei nennt.',
    );
  }
});

test('a message line carries the technical detail only when there is one', () => {
  expect(
    messageLine({ code: 'MEMBER_LIST_FAILED', status: 503, detail: 'database diagnostic' }, 'en'),
  ).toBe('Could not load the members (503). Technical detail: database diagnostic');
  expect(messageLine({ code: 'MEMBER_LIST_FAILED', status: 0 }, 'en')).toBe(
    'Could not load the members.',
  );
});
