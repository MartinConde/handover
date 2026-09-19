import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import SourceRecoveryLocaleFixture from './SourceRecoveryLocaleFixture.svelte';

// Not testing: the shell around it, which App.svelte.test.ts opens it in.

const CONFLICT = {
  code: 'ENTRY_SOURCE_CONFLICT',
  marks: { de: 'de', en: 'en', fr: 'de' },
  files: ['de', 'en', 'fr', 'it'],
  offered: ['de', 'en', 'fr', 'it'],
} as const;
const UNDECLARED = {
  code: 'ENTRY_SOURCE_UNDECLARED',
  marks: { de: 'pt', en: 'pt' },
  files: ['de', 'en'],
  offered: ['de', 'en'],
} as const;
const MISSING = {
  code: 'ENTRY_SOURCE_MISSING',
  marks: { de: 'es', en: 'es' },
  files: ['de', 'en'],
  offered: ['de', 'en', 'es'],
} as const;

let app: ReturnType<typeof mount>;
type Problem = {
  code: (typeof CONFLICT | typeof UNDECLARED | typeof MISSING)['code'];
  marks: Readonly<Record<string, string>>;
  files: readonly string[];
  offered: readonly string[];
};
const show = (
  problem: Problem,
  initialUiLocale: 'en' | 'de',
  over: Record<string, unknown> = {},
) => {
  app = mount(SourceRecoveryLocaleFixture, {
    target: document.body,
    props: {
      ...over,
      problem: {
        ...problem,
        marks: { ...problem.marks },
        files: [...problem.files],
        offered: [...problem.offered],
      },
      initialUiLocale,
    },
  });
  flushSync();
  const panel = document.body.querySelector('.source-recovery');
  return {
    banner: document.body.querySelector('.lock-banner')?.textContent?.trim(),
    title: panel?.querySelector('h2')?.textContent?.trim(),
    intro: panel?.querySelector('header p')?.textContent?.trim(),
    files: Array.from(document.body.querySelectorAll('.source-files li'), (li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  };
};
afterEach(() => unmount(app));

test.each([
  [
    'files that disagree',
    'en',
    CONFLICT,
    {
      banner:
        'This entry’s files disagree about its source language — it can’t be edited or published until that is settled.',
      title: 'Which language is the source?',
      intro:
        'Every language file names the entry’s source language, and these don’t agree. That usually means a file was edited or merged outside the CMS. Nothing is chosen for you.',
      files: [
        'DE The German file says German',
        'EN The English file says English',
        'FR The French file says German',
        'IT The Italian file says nothing',
      ],
    },
  ],
  [
    'files that disagree',
    'de',
    CONFLICT,
    {
      banner:
        'Die Dateien dieses Eintrags nennen verschiedene Ausgangssprachen — bearbeiten oder veröffentlichen geht erst, wenn das geklärt ist.',
      title: 'Welche Sprache ist die Ausgangssprache?',
      intro:
        'Jede Sprachdatei nennt die Ausgangssprache des Eintrags, und diese stimmen nicht überein. Meist wurde eine Datei außerhalb des CMS bearbeitet oder zusammengeführt. Nichts wird für dich entschieden.',
      files: [
        'DE Die Datei für Deutsch nennt Deutsch',
        'EN Die Datei für Englisch nennt Englisch',
        'FR Die Datei für Französisch nennt Deutsch',
        'IT Die Datei für Italienisch nennt nichts',
      ],
    },
  ],
  [
    'a language the site does not declare',
    'en',
    UNDECLARED,
    {
      banner:
        'This entry’s source language isn’t one this site declares — it can’t be edited or published until that is settled.',
      title: 'The source language isn’t declared',
      intro:
        'The files say Portuguese is the source, which this site doesn’t declare. That usually means a file was edited outside the CMS, or the language was taken out of the site’s configuration.',
      files: ['DE The German file says Portuguese', 'EN The English file says Portuguese'],
    },
  ],
  [
    'a language the site does not declare',
    'de',
    UNDECLARED,
    {
      banner:
        'Die Ausgangssprache dieses Eintrags ist keine Sprache dieser Website — bearbeiten oder veröffentlichen geht erst, wenn das geklärt ist.',
      title: 'Die Ausgangssprache ist nicht eingerichtet',
      intro:
        'Die Dateien nennen Portugiesisch als Ausgangssprache, und diese Website hat Portugiesisch nicht eingerichtet. Meist wurde eine Datei außerhalb des CMS bearbeitet, oder die Sprache wurde aus der Konfiguration der Website genommen.',
      files: [
        'DE Die Datei für Deutsch nennt Portugiesisch',
        'EN Die Datei für Englisch nennt Portugiesisch',
      ],
    },
  ],
  [
    'a source with no file',
    'en',
    MISSING,
    {
      banner:
        'This entry’s source language has no file — it can’t be edited or published until that is settled.',
      title: 'The source language has no file',
      intro:
        'Every file says Spanish is the source, and there is no Spanish file. If it was deleted by mistake, put it back in the repository. Otherwise choose a new source.',
      files: ['DE The German file says Spanish', 'EN The English file says Spanish'],
    },
  ],
  [
    'a source with no file',
    'de',
    MISSING,
    {
      banner:
        'Die Ausgangssprache dieses Eintrags hat keine Datei — bearbeiten oder veröffentlichen geht erst, wenn das geklärt ist.',
      title: 'Die Ausgangssprache hat keine Datei',
      intro:
        'Jede Datei nennt Spanisch als Ausgangssprache, und es gibt keine Datei für Spanisch. Wurde sie versehentlich gelöscht, stell sie im Repository wieder her. Andernfalls wähle eine neue Ausgangssprache.',
      files: [
        'DE Die Datei für Deutsch nennt Spanisch',
        'EN Die Datei für Englisch nennt Spanisch',
      ],
    },
  ],
] as const)('%s reads in %s', (_, locale, problem, expected) => {
  expect(show(problem, locale)).toEqual(expected);
});

test('the repository guidance names the key every file has to agree on', () => {
  show(CONFLICT, 'en');
  expect(document.body.querySelector('.source-recovery .hint')?.textContent).toBe(
    'Or fix it in the repository: every file’s _source has to name the same language, and that language needs a file.',
  );
});

test('switching the interface language keeps the panel and the chosen language', () => {
  show(CONFLICT, 'en');
  document.body.querySelector<HTMLInputElement>('#source-recovery-fr')?.click();
  flushSync();
  document.body.querySelector<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();
  expect(document.body.querySelector('.source-recovery h2')?.textContent).toBe(
    'Welche Sprache ist die Ausgangssprache?',
  );
  expect(document.body.querySelectorAll('.source-files li')).toHaveLength(4);
  expect(document.body.querySelector<HTMLInputElement>('#source-recovery-fr')?.checked).toBe(true);
});

test('a source is chosen among the offered languages with a file, and the choice is sent', async () => {
  sessionStorage.setItem('handover-tab', 'tab-1');
  const fetchMock = vi.fn(async () => Response.json({ source: 'en' }));
  vi.stubGlobal('fetch', fetchMock);
  const chosen = vi.fn();
  show({ ...CONFLICT, offered: ['de', 'en', 'fr'] }, 'en', { onchosen: chosen });
  expect(
    Array.from(document.body.querySelectorAll('.source-recovery .choice'), (c) =>
      c.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  ).toEqual(['DE German', 'EN English', 'FR French']);
  document.body.querySelector<HTMLInputElement>('#source-recovery-en')?.click();
  flushSync();
  const make = document.body.querySelector<HTMLButtonElement>('.source-recovery .btn-primary');
  expect(make?.textContent?.trim()).toBe('Make English the source');
  make?.click();
  await vi.waitFor(() => expect(chosen).toHaveBeenCalledExactlyOnceWith('en'));

  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    '/admin/api/entries/listings/muehlenhaus/source',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en', tab: 'tab-1' }),
    },
  );
  vi.unstubAllGlobals();
});

test('a lost answer to the choice offers only Reload', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('Connection lost', {
          status: 503,
          headers: {
            'x-handover-request-uncertain': 'true',
            'x-handover-error-code': 'CONNECTION_LOST',
          },
        }),
    ),
  );
  const chosen = vi.fn();
  const reloaded = vi.fn();
  show(CONFLICT, 'en', { onchosen: chosen, onreload: reloaded });
  document.body.querySelector<HTMLButtonElement>('.source-recovery .btn-primary')?.click();
  await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')).not.toBeNull());

  expect(
    document.body.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, ' ').trim(),
  ).toBe(
    'It could not be confirmed whether the source changed. Reload the entry before trying again. Reload',
  );
  expect(
    document.body.querySelector<HTMLButtonElement>('.source-recovery .btn-primary')?.disabled,
  ).toBe(true);
  expect(chosen).not.toHaveBeenCalled();
  document.body.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  expect(reloaded).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
