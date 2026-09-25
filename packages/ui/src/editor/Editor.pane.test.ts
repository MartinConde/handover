import { flushSync, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';
import { deferred } from '../test-helpers.fixture.js';
import {
  $,
  $$,
  at,
  autosaved,
  bilingual,
  HELD,
  isLock,
  languagePick,
  settle,
  show,
  state,
  tick,
  type,
  useEditorSetup,
  wrote,
} from './editor.fixture.js';
import { SIX, sixLanguageRows, sixLanguages } from './six-languages.fixture';

useEditorSetup();

const paneLanguagePick = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.pane-head .language-pick > h2 > button');
const paneChoices = (root: ParentNode) => $$<HTMLButtonElement>(root, '#pane-languages button');
const sideBySide = (root: ParentNode) => {
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
};
const choosePaneLanguage = async (root: ParentNode, index: number) => {
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)[index]?.click();
  await tick();
  flushSync();
};

test('side by side lists the languages other than the source in the pane head, with their state', () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(paneLanguagePick(root)?.textContent?.trim()).toBe('Language beside English: German');
  expect(paneChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'German',
    'French— English changed since this was translated',
    'Italian— partly written, 0 of 2 texts',
    'Spanish— not translated yet',
    'Dutch— turned off for this entry',
  ]);
  expect(paneChoices(root).map((b) => b.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
    'false',
    'false',
  ]);
});

test('choosing French in the pane swaps only the second column', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);

  await choosePaneLanguage(root, 1);

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Harbour House');
  expect($(root, '.editor-form-heading h2')?.textContent).toBe('English');
  expect($(root, '#pane-languages')).toBeNull();
  expect(document.activeElement).toBe(paneLanguagePick(root));
  // The pane's language is the entry's chosen language, so the header follows it.
  expect(languagePick(root)?.textContent).toContain('French');
});

const answered = (root: ParentNode) => $(root, '.pane-head .answered')?.textContent;

// The base source owes two texts: its title and the hero heading. Price and notes are not the pane's.
test('the pane head says how much of the source text the language beside it answers', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  expect(answered(root)).toBe('2 of 2 texts written');

  await choosePaneLanguage(root, 2);

  expect(answered(root)).toBe('0 of 2 texts written');
});

test('typing in either column recounts at once, without a save or a fresh pane', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('base'));
  sideBySide(root);
  await choosePaneLanguage(root, 2);
  const input = $<HTMLInputElement>(root, 'input#t-title');
  const reads = fetchMock.mock.calls.length;

  type(root, 'input#t-title', 'Casa sul porto');
  expect(answered(root)).toBe('1 of 2 texts written');
  type(root, 'input#f-subtitle', 'Sleeps six, dogs welcome');

  expect(answered(root)).toBe('1 of 3 texts written');
  expect(languagePick(root)?.textContent?.trim()).toBe(
    'Language: Italian— partly written, 1 of 3 texts',
  );
  expect($(root, 'input#t-title')).toBe(input);
  expect(fetchMock.mock.calls.length).toBe(reads);
  vi.unstubAllGlobals();
});

test('a stale translation that is also partly written is marked stale, and still counted', async () => {
  const root = show(sixLanguages('staleAndPartial'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(paneChoices(root)[1]?.textContent?.trim()).toBe(
    'French— English changed since this was translated',
  );
  paneChoices(root)[1]?.click();
  await tick();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');
  expect(answered(root)).toBe('1 of 2 texts written');
});

test('a file with no source text to answer says so, and a language with no file stays missing', async () => {
  const opened = sixLanguages('base');
  opened.entry.data = {
    ...opened.entry.data,
    title: ' ',
    body: [{ _type: 'hero', _id: 'hero0001' }],
  };
  const root = show(opened);
  sideBySide(root);
  await choosePaneLanguage(root, 2);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(answered(root)).toBe('No source text to translate');
  expect(paneChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'German',
    'French— English changed since this was translated',
    'Italian',
    'Spanish— not translated yet',
    'Dutch— turned off for this entry',
  ]);
});

test("Canvas's language select names a partly written file as well", () => {
  const opened = sixLanguages('base');
  const root = show({ entry: { ...opened.entry, route: '/listings/[slug]' }, preview: true });
  $<HTMLButtonElement>(root, '.canvas-open')?.click();
  flushSync();

  expect(
    $$<HTMLOptionElement>(root, 'select.canvas-locale option').map((o) => o.textContent),
  ).toEqual(['EN', 'DE', 'FR · Changed', 'IT · Partly written', 'ES · New', 'NL · Off']);
});

test('with four languages the buttons carry the partial mark too', () => {
  const opened = sixLanguages('base');
  opened.entry.locales = ['en', 'de', 'fr', 'it'];
  opened.entry.offered = ['en', 'de', 'fr', 'it'];
  const root = show(opened);

  expect($$(root, '.seg[aria-label="Language"] button').map((b) => b.textContent?.trim())).toEqual([
    'EN',
    'DE',
    'FR— English changed since this was translated',
    'IT— partly written, 0 of 2 texts',
  ]);
});

test('with one other language the pane head stays a plain heading', () => {
  const root = show({ entry: bilingual });
  sideBySide(root);

  expect($(root, '.pane-head .language-pick')).toBeNull();
  expect($(root, '.pane-head h2')?.textContent).toBe('German');
});

test('German typed in the pane is saved before French replaces it, and is there on return', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('base'));
  sideBySide(root);
  type(root, 'input#t-title', 'Hafenhaus');

  await choosePaneLanguage(root, 1);
  // French is stale, so its pane also reads what changed in English; only the saves matter here.
  const saves = wrote(fetchMock).filter((call) => (call[1] as RequestInit)?.method === 'PUT');
  expect(saves.map((call) => call[0])).toEqual(['/admin/api/drafts/listings/seaview-cottage/de']);
  expect(JSON.parse(String((saves[0]?.[1] as RequestInit | undefined)?.body)).data.title).toBe(
    'Hafenhaus',
  );
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');

  await choosePaneLanguage(root, 0);
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Hafenhaus');
  expect($(root, '.pane-head .autosave')?.textContent?.trim()).toBe('Saved');
  vi.unstubAllGlobals();
});

test('a pane language chosen while German cannot be saved is not switched to', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      throw new TypeError('offline');
    }),
  );
  const root = show(sixLanguages('base'));
  sideBySide(root);
  type(root, 'input#t-title', 'Hafenhaus');

  await choosePaneLanguage(root, 1);

  expect(paneLanguagePick(root)?.textContent).toContain('German');
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Hafenhaus');
  vi.unstubAllGlobals();
});

test('the pane goes to a missing or turned-off language and back from its empty pane', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);

  await choosePaneLanguage(root, 3);
  expect(paneLanguagePick(root)?.textContent).toContain('Spanish');
  expect($(root, '.pane-head')?.parentElement?.querySelector('.btn-create')).not.toBeNull();

  await choosePaneLanguage(root, 4);
  expect(paneLanguagePick(root)?.textContent).toContain('Dutch');
  expect($(root, '.empty')?.textContent).toContain('This entry is not offered in Dutch.');

  await choosePaneLanguage(root, 0);
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Haus am Hafen');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Harbour House');
});

test('Escape closes the pane list and gives focus back to the pane button', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)[2]?.focus();

  paneChoices(root)[2]?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await tick();

  expect($(root, '#pane-languages')).toBeNull();
  expect(document.activeElement).toBe(paneLanguagePick(root));
});

test('a click outside the pane list closes it without choosing', () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  $<HTMLElement>(root, 'input#f-title')?.click();
  flushSync();

  expect($(root, '#pane-languages')).toBeNull();
  expect(paneLanguagePick(root)?.textContent).toContain('German');
});

// The list the queue reads is the collection's own, in its order, with the last build's marks.
const queueList = (rows: unknown[] | (() => Promise<Response>) = sixLanguageRows()) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/entries/listings')
      return typeof rows === 'function' ? rows() : Response.json({ entries: rows, locales: SIX });
    if (String(url).startsWith('/admin/api/source/')) return Response.json({ changed: {} });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const listReads = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => call[0] === '/admin/api/entries/listings').length;

const queueNext = (root: ParentNode) => $(root, '.pane-head .queue-next');
const nextLink = (root: ParentNode) => $<HTMLAnchorElement>(root, '.pane-head .queue-next a');

test('a queue opens its language beside the source and Next skips to the next row owing it', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect($(root, '.editor-form-heading h2')?.textContent).toBe('English');
  expect($(root, '#pane-fr')?.textContent).toContain('French');
  expect(nextLink(root)?.textContent?.trim()).toBe('Next in French');
  // germanFirst and legacy have no French file and partlyMarked's is current.
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

// A link opens a language for this visit; the view the person chose stays theirs.
test('opening a queue or a language link leaves the saved view as it was', async () => {
  const key = 'handover:editor-view:v3:/:u1';
  localStorage.setItem(key, 'none');
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', userId: 'u1', ...sixLanguages('twoMissing') });
  await settle();
  expect($(root, '#pane-fr')).not.toBeNull();
  expect(localStorage.getItem(key)).toBe('none');
  unmount(state.app);

  at('/admin/c/listings/twoMissing?locale=de');
  const again = show({ slug: 'twoMissing', userId: 'u1', ...sixLanguages('twoMissing') });
  await settle();
  expect($(again, '#pane-de')).not.toBeNull();
  expect(localStorage.getItem(key)).toBe('none');
  vi.unstubAllGlobals();
});

test('a queue for a language with no file opens its create pane, with Next in the pane head', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=es&owed=missing');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect($(root, '#pane-es')?.textContent).toContain('Spanish');
  expect($(root, '.btn-create')).not.toBeNull();
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/germanFirst?queue=es&owed=missing',
  );
  vi.unstubAllGlobals();
});

// After the Spanish file is created the editor remounts; this entry no longer owes it.
test('the queue keeps its place from an entry that is no longer owed the language', async () => {
  const rows = sixLanguageRows();
  const base = rows[0] as (typeof rows)[number];
  base.locales.es = { title: 'Casa del puerto', path: 'src/content/listings/es/base.yaml' };
  queueList(rows);
  at('/admin/c/listings/base?queue=es&owed=missing');
  const opened = sixLanguages('base');
  opened.entry.translations.es = { title: 'Casa del puerto' };
  const root = show({ slug: 'base', ...opened });
  await settle();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Casa del puerto');
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/twoMissing?queue=es&owed=missing',
  );
  vi.unstubAllGlobals();
});

test('a queue for everything owed stops at a partly written file, stale or not, once', async () => {
  queueList();
  at('/admin/c/listings/untouchedInvalid?queue=it&owed=owed');
  const root = show({ slug: 'untouchedInvalid', ...sixLanguages('untouchedInvalid') });
  await settle();

  // Its Italian file answers none of the two texts English has.
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/staleAndPartial?queue=it&owed=owed',
  );
  unmount(state.app);
  document.body.innerHTML = '';
  at('/admin/c/listings/staleAndPartial?queue=fr&owed=owed');
  const again = show({ slug: 'staleAndPartial', ...sixLanguages('staleAndPartial') });
  await settle();

  // French there is both stale and partly written; the queue moves past it all the same.
  expect(nextLink(again)?.getAttribute('href')).toBe(
    '/admin/c/listings/sourceDraft?queue=fr&owed=owed',
  );
  vi.unstubAllGlobals();
});

test('the last row owing the language says the queue ends, not that nothing is owed', async () => {
  // Without the conflict row, which never opens in the editor, `structured` is the last one.
  queueList(sixLanguageRows().filter((row) => row.id !== 'sourceConflict'));
  at('/admin/c/listings/structured?queue=es&owed=owed');
  const root = show({ slug: 'structured', ...sixLanguages('structured') });
  await settle();

  expect(nextLink(root)).toBeNull();
  expect(queueNext(root)?.textContent).toContain('End of this queue');
  vi.unstubAllGlobals();
});

test('an entry the list does not have cannot continue the queue', async () => {
  queueList();
  at('/admin/c/listings/gone?queue=es&owed=owed');
  const root = show({ slug: 'gone', ...sixLanguages('base') });
  await settle();

  expect(nextLink(root)).toBeNull();
  expect(queueNext(root)?.textContent).toContain('This entry is not in the list');
  expect(queueNext(root)?.textContent).not.toContain('End of this queue');
  vi.unstubAllGlobals();
});

test('a queue in a language the site does not declare is no queue at all', async () => {
  const fetchMock = queueList();
  at('/admin/c/listings/base?queue=xx&owed=missing');
  const root = show({ slug: 'base', ...sixLanguages('base') });
  await settle();

  expect($(root, '.pane-head')).toBeNull();
  expect(queueNext(root)).toBeNull();
  expect(listReads(fetchMock)).toBe(0);
  vi.unstubAllGlobals();
});

test('an entry opened directly has no queue and does not read the list', async () => {
  const fetchMock = queueList();
  const root = show({ slug: 'base', ...sixLanguages('base') });
  sideBySide(root);
  await settle();

  expect($(root, '#pane-de')).not.toBeNull();
  expect(queueNext(root)).toBeNull();
  expect(listReads(fetchMock)).toBe(0);
  vi.unstubAllGlobals();
});

test('a failed queue read offers a retry instead of saying the queue ended', async () => {
  let offline = true;
  const fetchMock = queueList(async () => {
    if (offline) throw new TypeError('offline');
    return Response.json({ entries: sixLanguageRows(), locales: SIX });
  });
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect(queueNext(root)?.textContent).toContain('Could not find the next entry.');
  expect(queueNext(root)?.textContent).not.toContain('End of this queue');
  offline = false;
  $<HTMLButtonElement>(root, '.queue-next button')?.click();
  await settle();

  expect(listReads(fetchMock)).toBe(2);
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

test('the Content, SEO and History links keep the queue', async () => {
  queueList();
  at('/admin/c/listings/structured?queue=fr&owed=stale');
  const root = show({ slug: 'structured', ...sixLanguages('structured') });
  await settle();

  expect(
    $$<HTMLAnchorElement>(root, '.editor-sections a').map((a) => a.getAttribute('href')),
  ).toEqual([
    '/admin/c/listings/structured?queue=fr&owed=stale',
    '/admin/c/listings/structured/seo?queue=fr&owed=stale',
    '/admin/c/listings/structured/history?queue=fr&owed=stale',
  ]);
  vi.unstubAllGlobals();
});

test('choosing another pane language leaves the queue on its own language', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  await choosePaneLanguage(root, 0);

  expect(paneLanguagePick(root)?.textContent).toContain('German');
  expect(nextLink(root)?.textContent?.trim()).toBe('Next in French');
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

// Reference language: a third language read under each field of the pane.
const referencePick = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.pane-head .reference-pick > button');
const referenceChoices = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '#reference-languages button');
const chooseReference = (root: ParentNode, name: string) => {
  referencePick(root)?.click();
  flushSync();
  referenceChoices(root)
    .find((b) => b.textContent?.startsWith(name))
    ?.click();
  flushSync();
};
const peek = (root: ParentNode, field: string) =>
  $(root, `#t-${field}-field .reference-peek`)?.textContent?.trim();
// `structured` with a French file whose rooms run in the other order from the German one.
const structuredWithFrench = () => {
  const six = sixLanguages('structured');
  const german = six.entry.translations.de as Record<string, unknown>;
  six.entry.translations.fr = {
    ...structuredClone(german),
    title: 'Maison du port',
    rooms: [
      { _id: 'room0001', name: 'Chambre du port' },
      { _id: 'room0002', name: 'Chambre jardin' },
    ],
  };
  return six;
};
const frenchBesideEnglish = async (root: ParentNode) => {
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)
    .find((b) => b.textContent?.startsWith('French'))
    ?.click();
  await tick();
  flushSync();
};

test('German reads under the French title, rich text and a field inside a block', async () => {
  const root = show(structuredWithFrench());
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect($(root, '#t-title-field .reference-peek [lang="de"]')?.textContent).toBe('Haus am Hafen');
  expect($(root, '#t-summary-field .reference-peek [lang="de"]')?.innerHTML).toBe(
    '<p><strong>Ruhige</strong> Zimmer über dem Hafen.</p>',
  );
  expect(peek(root, 'body\\.0\\.heading')).toBe('German Jetzt buchen');
  expect(peek(root, 'body\\.0\\.button')).toBe('German Buchen');
});

test('a French row in another order still peeks at the German row with its id', async () => {
  const root = show(structuredWithFrench());
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect($<HTMLInputElement>(root, '#t-rooms\\.0\\.name')?.value).toBe('Chambre du port');
  expect(peek(root, 'rooms\\.0\\.name')).toBe('German Hafenzimmer');
  expect(peek(root, 'rooms\\.1\\.name')).toBe('German Gartenzimmer');
});

test('an empty German value and a row German lacks say so instead of drawing nothing', async () => {
  const six = structuredWithFrench();
  const german = six.entry.translations.de as Record<string, unknown>;
  german.title = '';
  german.rooms = [{ _id: 'room0002', name: 'Gartenzimmer' }];
  const root = show(six);
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Not written in German yet');
  expect(peek(root, 'rooms\\.0\\.name')).toBe('German This row is not in German');
  expect(peek(root, 'rooms\\.1\\.name')).toBe('German Gartenzimmer');
});

test('a shared or source-only field gets no peek', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect($(root, '#t-price-field')).not.toBeNull();
  expect($(root, '#t-price-field .reference-peek')).toBeNull();
  expect($(root, '#t-notes-field')).toBeNull();
});

test('beside English, French offers None, German and Italian — never source, target, missing or off', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  referencePick(root)?.click();
  flushSync();

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: None');
  expect(referenceChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'None',
    'German',
    'Italian— partly written, 0 of 2 texts',
  ]);
  expect(referenceChoices(root).map((b) => b.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
  ]);
});

test('with files only for the source and the language beside it there is no reference control', () => {
  const root = show(sixLanguages('legacy'));
  sideBySide(root);

  expect($(root, '.pane-head h2')?.textContent).toContain('German');
  expect(referencePick(root)).toBeNull();
});

test('the chosen reference is stored per site and user and comes back on the next entry', async () => {
  const key = 'handover:editor-reference:v1:/:u1';
  const first = show({ ...sixLanguages('base'), userId: 'u1' });
  await frenchBesideEnglish(first);
  chooseReference(first, 'German');
  expect(localStorage.getItem(key)).toBe('de');
  unmount(state.app);
  document.body.innerHTML = '';
  localStorage.removeItem('handover:editor-view:v3:/:u1');

  const root = show({ ...sixLanguages('base'), userId: 'u1' });
  await frenchBesideEnglish(root);

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: German');
  expect(peek(root, 'title')).toBe('German Haus am Hafen');
});

test('a stored reference that is now the target shows None, stays stored and returns', async () => {
  const key = 'handover:editor-reference:v1:/:u1';
  localStorage.setItem(key, 'de');
  const root = show({ ...sixLanguages('base'), userId: 'u1' });
  sideBySide(root);

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Haus am Hafen');
  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: None');
  expect($(root, '.reference-peek')).toBeNull();
  expect(localStorage.getItem(key)).toBe('de');

  await choosePaneLanguage(root, 1);

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: German');
  expect(peek(root, 'title')).toBe('German Haus am Hafen');
});

test('a browser that refuses storage still lets the reference be chosen and drawn', async () => {
  const refuse = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect(write).toHaveBeenCalledWith('handover:editor-reference:v1:/:', 'de');
  read.mockRestore();
  write.mockRestore();
});

test('the peek is not an input, not a tab stop, and choosing it leaves nothing to save', async () => {
  const six = structuredWithFrench();
  (six.entry.translations.de as Record<string, unknown>).summary =
    'Ruhige Zimmer über dem [Hafen](https://example.com/hafen).';
  const root = show(six);
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  const peeks = $$<HTMLElement>(root, '.reference-peek');
  expect(peeks.length).toBeGreaterThan(0);
  for (const node of peeks) {
    expect(
      node.querySelector('input, textarea, button, select, a[href], [tabindex], [contenteditable]'),
    ).toBeNull();
    expect(node.hasAttribute('tabindex')).toBe(false);
    expect(node.id).toBe('');
  }
  expect($(root, '[aria-describedby*="reference"]')).toBeNull();
  expect($(root, '.pane-head .autosave')?.textContent?.trim()).toBe('Saved');
});

test('Escape closes the reference choice and gives focus back to its button', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  referencePick(root)?.click();
  flushSync();
  expect($(root, '#reference-languages')).not.toBeNull();

  referenceChoices(root)[1]?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  flushSync();

  expect($(root, '#reference-languages')).toBeNull();
  expect(document.activeElement).toBe(referencePick(root));
});

test('Translate what’s empty still asks for the target alone with a reference chosen', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url) ? Response.json(HELD) : Response.json({ data: {}, pending: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('machine'));
  await frenchBesideEnglish(root);
  chooseReference(root, 'German');

  $<HTMLButtonElement>(root, 'button.btn-fill')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/translate/listings/seaview-cottage/fr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  vi.unstubAllGlobals();
});

// M12 — the pane's run through what its language still owes.
const todoNext = (root: ParentNode) => $<HTMLButtonElement>(root, '.pane-head .btn-todo');
const announced = (root: ParentNode) => $(root, '.pane-head [role="status"]')?.textContent;
const runTodo = async (root: ParentNode) => {
  todoNext(root)?.click();
  await settle();
};
const staleSource = (changed: Record<string, unknown>) => {
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : String(url).startsWith('/admin/api/source/')
        ? Response.json({ changed, translatedAt: '2026-09-01T09:00:00.000Z' })
        : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const CHANGED_TITLE = {
  title: [{ text: 'Harbour ' }, { text: 'House', mark: 'del' }, { text: 'Cottage', mark: 'ins' }],
};
/** French owes the source's drafted subtitle and its lost heading, and its title is behind. */
const owing = () => {
  const opened = sixLanguages('sourceDraft');
  (opened.entry.translations.fr as { body: Record<string, unknown>[] }).body = [
    { _type: 'hero', _id: 'hero0001' },
  ];
  return opened;
};

test('a press visits each empty and stale field in turn, and the last one wraps', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  // Reading a field is not answering it: the run comes round again.
  expect(announced(root)).toBe('');

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('an answered field drops out of the run as it is typed', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  type(root, 'input#t-subtitle', 'Six personnes, chiens bienvenus');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  vi.unstubAllGlobals();
});

test('a dismissed marker leaves the run with the empty fields it left behind', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  $<HTMLButtonElement>(root, '.pane .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('only a language with nothing outstanding is told there is nothing left to do', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show(sixLanguages('base'));
  sideBySide(root);
  await settle();

  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a stale language claims nothing while the list of changes is still being read', async () => {
  const gate = deferred<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? gate.promise
          : Response.json({}),
    ),
  );
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(announced(root)).toBe('');

  gate.resolve(Response.json({ changed: {} }));
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a folded block is opened so the run lands on the input itself', async () => {
  staleSource({});
  const root = show(sixLanguages('staleAndPartial'));
  await frenchBesideEnglish(root);
  await settle();
  $<HTMLButtonElement>(root, '.pane .block-card button.fold')?.click();
  flushSync();
  expect($(root, 'input#t-body\\.0\\.heading')).toBeNull();

  await runTodo(root);

  expect(document.activeElement?.id).toBe('t-body.0.heading');
  expect(document.activeElement?.tagName).toBe('INPUT');
  vi.unstubAllGlobals();
});

// The section is the shell's to redraw, so the focus that lands there is proven in `App.test.ts`.
test('an SEO text takes the run to the SEO tab without dropping the queue', async () => {
  queueList();
  at('/admin/c/listings/structured?queue=de&owed=missing');
  const opened = sixLanguages('structured');
  delete ((opened.entry.translations.de as Record<string, unknown>).seo as Record<string, unknown>)
    .description;
  const root = show({ slug: 'structured', ...opened });
  await settle();

  await runTodo(root);

  expect(location.pathname).toBe('/admin/c/listings/structured/seo');
  expect(location.search).toBe('?queue=de&owed=missing');
  vi.unstubAllGlobals();
});

test('a marker on a row the file no longer has is passed over', async () => {
  staleSource({
    'body[_id=gone0001].heading': [{ text: 'Gone' }],
    title: [{ text: 'Harbour House' }],
  });
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  // The run came round to the title again rather than resting on the row that is gone.
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('a row that sits elsewhere in this language is still matched by its identity', async () => {
  staleSource({});
  const opened = sixLanguages('structured');
  for (const row of (opened.entry.translations.de as { rooms: Record<string, unknown>[] }).rooms)
    delete row.name;
  const root = show({ slug: 'structured', ...opened });
  sideBySide(root);
  await settle();

  // German has the garden room first, so the source's first room is its second row.
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-rooms.1.name');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-rooms.0.name');
  vi.unstubAllGlobals();
});

test('Alt and the down arrow run the pane, unless something else owns the key', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();
  const chord = async (target: Element, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await settle();
  };
  const subtitle = $(root, 'input#t-subtitle');
  if (!subtitle) throw new Error('subtitle missing');

  await chord(subtitle);
  expect(document.activeElement?.id).toBe('t-title');

  // Mid-composition the arrow belongs to the input method.
  await chord($(root, 'input#t-title') as Element, { isComposing: true });
  expect(document.activeElement?.id).toBe('t-title');

  // An open popover answers its own keys.
  $<HTMLButtonElement>(root, '.pane .stale')?.click();
  flushSync();
  await chord($(root, '.pane .popover') as Element);
  expect($(root, '.pane .popover')).not.toBeNull();
  vi.unstubAllGlobals();
});

const CHANGED_HEADING = {
  'body[_id=hero0001].heading': [
    { text: 'Above the ' },
    { text: 'harbour', mark: 'del' },
    { text: 'fish market', mark: 'ins' },
  ],
};

test('a marker dismissed inside a block reaches the pane, which then has nothing left', async () => {
  staleSource(CHANGED_HEADING);
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a field that answers the chord itself keeps it', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();
  const subtitle = $<HTMLInputElement>(root, 'input#t-subtitle');
  if (!subtitle) throw new Error('subtitle missing');
  subtitle.addEventListener('keydown', (e) => e.preventDefault());
  subtitle.focus();

  subtitle.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();

  expect(document.activeElement).toBe(subtitle);
  vi.unstubAllGlobals();
});

test('a re-translated field is answered but stays in the run until its marker goes', async () => {
  const opened = sixLanguages('machine');
  (opened.entry.translations.fr as { body: Record<string, unknown>[] }).body = [
    { _type: 'hero', _id: 'hero0001' },
  ];
  const filled = {
    ...(opened.entry.translations.fr as Record<string, unknown>),
    body: [{ _type: 'hero', _id: 'hero0001', heading: 'Au-dessus du marché' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? Response.json({ changed: CHANGED_HEADING })
          : String(url).startsWith('/admin/api/translate/')
            ? Response.json({ data: filled, pending: true })
            : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show(opened);
  await frenchBesideEnglish(root);
  await settle();
  expect(answered(root)).toBe('1 of 2 texts written');

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button')?.click();
  await settle();

  expect(answered(root)).toBe('2 of 2 texts written');
  await runTodo(root);
  // The words are there, but the source's change has not been acknowledged.
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  expect(announced(root)).toBe('');

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('failed stale-marker loading does not announce that the work is finished', async () => {
  const page = owing();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? new Response('Unavailable', { status: 500 })
          : Response.json({ results: [], updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show(page);
  await frenchBesideEnglish(root);
  await settle();
  type(root, 'input#t-subtitle', 'Sous-titre');
  type(root, 'input#t-body\\.0\\.heading', 'Titre');
  await settle();

  expect(answered(root)).toBe('3 of 3 texts written');
  await runTodo(root);
  expect(announced(root)).not.toBe('Nothing left to do');
  expect($(root, '.marker-load-failure')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Could not load what changed in the source. Retry',
  );
  vi.unstubAllGlobals();
});

test('a network failure loading stale markers can be retried successfully', async () => {
  const page = owing();
  let markers = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (String(url).endsWith('/fr')) {
        markers += 1;
        if (markers === 1) throw new TypeError('offline');
        return Response.json({ changed: {} });
      }
      if (String(url).startsWith('/admin/api/source/')) return Response.json({ changed: {} });
      return Response.json({ results: [], updated_at: 1755864000000, pending: true, problems: [] });
    }),
  );
  const root = show(page);
  await frenchBesideEnglish(root);
  await settle();
  type(root, 'input#t-subtitle', 'Sous-titre');
  type(root, 'input#t-body\\.0\\.heading', 'Titre');
  await settle();

  await runTodo(root);
  expect(announced(root)).toBe('');
  $<HTMLButtonElement>(root, '.marker-load-failure button')?.click();
  await settle();
  expect(root.querySelector('.marker-load-failure')).toBeNull();
  await runTodo(root);
  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});
