import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import EditorLocaleFixture from './EditorLocaleFixture.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) =>
  Array.from(document.body.querySelectorAll<T>(selector));
const switchLocale = () => {
  q<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();
};

test('live interface language updates editor chrome and dates without replacing the active field', async () => {
  const turnedOffAt = new Date(2026, 7, 12, 12).getTime();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({ held_by: null, mine: true, expires_at: turnedOffAt + 120_000 })
      : url === '/admin/api/deleted/listings'
        ? Response.json({
            deleted: [
              {
                at: turnedOffAt,
                slug: 'seaview-cottage',
                locales: ['de'],
                whole: false,
                commit_sha: 'off-1',
              },
            ],
          })
        : url === '/admin/api/drafts/listings/seaview-cottage' && init?.method === 'PUT'
          ? Response.json({ updated_at: turnedOffAt, pending: true, problems: [] })
          : url === '/admin/api/publish/checks'
            ? Response.json({ results: [] })
            : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  const input = q<HTMLInputElement>('input#f-title');
  if (!input) throw new Error('title input missing');
  input.value = 'Unsaved harbour words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dataset.localeProof = 'same-editor-field';
  expect(q('.slug-row .mode')?.textContent).toBe('Same as the file name');
  q<HTMLButtonElement>('.slug-row .btn-link')?.click();
  flushSync();
  const address = q<HTMLInputElement>('#entry-address');
  if (!address) throw new Error('address input missing');
  address.value = 'coastal-home';
  address.dispatchEvent(new Event('input', { bubbles: true }));
  address.dataset.localeProof = 'same-address-field';
  address.focus();
  const requestsBeforeSwitch = fetchMock.mock.calls.length;

  q<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();

  const current = q<HTMLInputElement>('input#f-title');
  expect(q('.editor-beside')?.getAttribute('aria-label')).toBe('Neben dem Formular');
  expect(
    qa<HTMLButtonElement>('.editor-beside button').map((button) => button.textContent),
  ).toEqual(['Live-Vorschau', 'Übersetzen']);
  expect(q('.canvas-open')?.textContent).toBe('Canvas');
  expect(q('.tabs')?.getAttribute('aria-label')).toBe('Eintragsbereiche');
  expect(qa<HTMLAnchorElement>('.tabs a').map((link) => link.textContent)).toEqual([
    'Inhalt',
    'Verlauf',
  ]);
  expect(q('.entry-header button.btn-primary')?.textContent).toBe('Diesen Eintrag veröffentlichen');
  expect(current).toBe(input);
  expect(current?.value).toBe('Unsaved harbour words');
  expect(current?.dataset.localeProof).toBe('same-editor-field');
  const currentAddress = q<HTMLInputElement>('#entry-address');
  expect(q('label[for="entry-address"]')?.textContent).toBe('Webadresse auf Englisch');
  expect(currentAddress).toBe(address);
  expect(currentAddress?.value).toBe('coastal-home');
  expect(currentAddress?.dataset.localeProof).toBe('same-address-field');
  expect(document.activeElement).toBe(currentAddress);
  expect(
    q<HTMLButtonElement>('[aria-label="Sprache"] button[aria-pressed="true"]')?.textContent,
  ).toContain('EN');
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);
  q<HTMLButtonElement>('.slug-row .btn-ghost')?.click();
  flushSync();

  q<HTMLButtonElement>('[aria-label="Weitere Aktionen"]')?.click();
  flushSync();
  expect(
    qa<HTMLButtonElement>('[role="menu"][aria-label="Weitere Aktionen"] button').map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['Umbenennen', 'Ausblenden', 'Löschen']);
  qa<HTMLButtonElement>('[role="menu"][aria-label="Weitere Aktionen"] button')[0]?.click();
  flushSync();
  expect(q('.dialog h2')?.textContent).toBe('Unsaved harbour words umbenennen');
  expect(q('.dialog label[for="rename-to"]')?.textContent).toBe('Dateiname');
  q<HTMLButtonElement>('.dialog button:not(.btn-primary)')?.click();
  flushSync();

  qa<HTMLButtonElement>('[aria-label="Sprache"] button')[1]?.click();
  for (let attempt = 0; attempt < 10 && !q('.pane time'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync();
  }
  expect(q('.pane time')?.textContent ?? '').toBe('12. August 2026 um 12:00');
});

test('German publish tooltips keep the header reason order', async () => {
  let locked = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/locks/')
        ? Response.json(
            locked
              ? { held_by: { id: 'u2', name: 'Anna Berg' }, mine: false, expires_at: Date.now() }
              : { held_by: null, mine: true, expires_at: Date.now() + 120_000 },
          )
        : Response.json({}),
    ),
  );
  const titles: { en: string | null; de: string | null }[] = [];
  for (const state of ['locked', 'drift', 'missing'] as const) {
    locked = state === 'locked';
    app = mount(EditorLocaleFixture, {
      target: document.body,
      props: {
        publishState: state === 'locked' ? 'clean' : state,
      },
    });
    await new Promise((resolve) => setTimeout(resolve));
    flushSync();
    const en =
      q<HTMLButtonElement>('.entry-header button.btn-primary')?.getAttribute('title') ?? null;
    q<HTMLButtonElement>('[data-locale-switch]')?.click();
    flushSync();
    const de =
      q<HTMLButtonElement>('.entry-header button.btn-primary')?.getAttribute('title') ?? null;
    titles.push({ en, de });
    unmount(app);
    document.body.innerHTML = '';
  }
  app = mount(EditorLocaleFixture, { target: document.body });

  expect(titles).toEqual([
    {
      en: 'Somebody else is editing this entry',
      de: 'Jemand anderes bearbeitet diesen Eintrag',
    },
    {
      en: 'The languages of this entry disagree about its blocks',
      de: 'Die Sprachen dieses Eintrags unterscheiden sich bei den Blöcken',
    },
    {
      en: 'Fill in what is missing before publishing this entry',
      de: 'Fülle die fehlenden Angaben aus, bevor du diesen Eintrag veröffentlichst',
    },
  ]);
});

test('retained drift and restore guidance retranslate in place', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/locks/')
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
        : Response.json({}),
    ),
  );
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: {
      publishState: 'drift',
      pending: true,
      restored: '2026-08-12T12:00:00.000Z',
    },
  });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  const banner = q('.lock-banner.is-drift');
  expect(banner?.textContent).toContain('Restored the version from');
  expect(banner?.textContent).toContain('decide what to keep');

  switchLocale();

  expect(q('.lock-banner.is-drift')).toBe(banner);
  expect(banner?.textContent).toContain('Die Version von');
  expect(banner?.textContent).toContain('entscheide, was bleiben soll');
});

test('an open publish confirmation retranslates without rerunning checks', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
      : url === '/admin/api/publish/checks'
        ? Response.json({
            results: [
              {
                check: 'image-alt',
                entry: 'listings/seaview-cottage',
                path: 'src/content/listings/en/seaview-cottage.yaml',
                fieldPath: 'photo.alt',
                severity: 'warn',
                message: 'Photo has no alt text',
              },
            ],
          })
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, { target: document.body, props: { pending: true } });
  await vi.waitFor(() => expect(q<HTMLButtonElement>('.entry-header .btn-primary')).toBeTruthy());
  q<HTMLButtonElement>('.entry-header .btn-primary')?.click();
  await vi.waitFor(() => expect(q('#publish-h')?.textContent).toBe('Publish Seaview Cottage?'));
  flushSync();
  const dialog = q<HTMLDialogElement>('dialog[open]');
  const calls = fetchMock.mock.calls.length;

  switchLocale();

  expect(q<HTMLDialogElement>('dialog[open]')).toBe(dialog);
  expect(q('#publish-h')?.textContent).toBe('Seaview Cottage veröffentlichen?');
  expect(q('.checks .sev')?.textContent).toBe('Warnung');
  expect(q('.dialog .btn-primary')?.textContent).toBe('Trotzdem veröffentlichen (1 Warnung)');
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

test('content-language creation controls retranslate without changing the selected language', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
      : url === '/admin/api/translate/listings/seaview-cottage/de'
        ? new Response('provider diagnostic', {
            status: 503,
            headers: { 'content-type': 'text/plain' },
          })
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: { targetOffered: true, translator: true },
  });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  qa<HTMLButtonElement>('[aria-label="Language"] button')[1]?.click();
  flushSync();
  const pane = q<HTMLElement>('.pane.is-locale');
  const create = q<HTMLButtonElement>('.pane .btn-create');
  expect(pane?.textContent).toContain('Create from English');
  expect(pane?.textContent).toContain('Create and pre-fill');
  const requestsBeforeSwitch = fetchMock.mock.calls.length;

  switchLocale();

  expect(q('.pane.is-locale')).toBe(pane);
  expect(q('.pane h2')?.textContent).toBe('Deutsch');
  expect(q('.pane .btn-create')).toBe(create);
  expect(pane?.textContent).toContain('Aus Englisch erstellen');
  expect(pane?.textContent).toContain('Erstellen und vorübersetzen');
  expect(
    q<HTMLButtonElement>('[aria-label="Sprache"] button[aria-pressed="true"]')?.textContent,
  ).toContain('DE');
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);

  q<HTMLButtonElement>('.pane .btn-fill')?.click();
  await vi.waitFor(() =>
    expect(q('.pane [role="alert"]')?.textContent).toContain(
      'Die Sprache wurde erstellt, aber die Übersetzung ist fehlgeschlagen.',
    ),
  );
  flushSync();
  switchLocale();
  expect(q('.pane.is-locale')).toBe(pane);
  expect(q('.pane [role="alert"]')?.textContent).toContain(
    'The language was created, but translation failed.',
  );
});

test('visible scalar validation and controls reformat without validating or replacing input', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
      : url === '/admin/api/publish/checks'
        ? Response.json({ results: [] })
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: { scalarFeedback: true },
  });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const input = q<HTMLInputElement>('input#f-title');
  const select = q<HTMLSelectElement>('select#f-status');
  if (!input || !select) throw new Error('scalar controls missing');
  input.value = 'Words not validated yet';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dataset.validationProof = 'same-input';
  const requestsBeforeSwitch = fetchMock.mock.calls.length;

  expect(q('#f-title-err')?.textContent).toBe('Required');
  expect(q('#f-count-err')?.textContent).toBe('Enter a number greater than 1.5');
  expect(q('#f-note-err')?.textContent).toBe('Use the newsroom wording');
  expect(select.options[0]?.textContent).toBe('Choose…');
  expect(input.getAttribute('aria-required')).toBe('true');
  expect(q('#f-count')?.getAttribute('aria-required')).toBe('true');
  expect(q('#f-featured')?.getAttribute('aria-required')).toBe('true');
  expect(q('#f-availableFrom')?.getAttribute('aria-required')).toBe('true');
  expect(select.getAttribute('aria-required')).toBe('true');

  switchLocale();

  expect(q('#f-title-err')?.textContent).toBe('Erforderlich');
  expect(q('#f-count-err')?.textContent).toBe('Gib eine Zahl größer als 1,5 ein');
  expect(q('#f-featured-err')?.textContent).toBe('Wähle ein oder aus');
  expect(q('#f-availableFrom-err')?.textContent).toBe('Gib ein gültiges Datum ein');
  expect(q('#f-status-err')?.textContent).toBe('Wähle eine der verfügbaren Optionen');
  expect(q('#f-note-err')?.textContent).toBe('Use the newsroom wording');
  expect(q<HTMLInputElement>('input#f-title')).toBe(input);
  expect(input.value).toBe('Words not validated yet');
  expect(input.dataset.validationProof).toBe('same-input');
  expect(q<HTMLSelectElement>('select#f-status')).toBe(select);
  expect(select.options[0]?.textContent).toBe('Auswählen…');
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);
});

test('visible validation and a pending save retranslate without losing queued edits', async () => {
  vi.useFakeTimers();
  const first = deferred<Response>();
  const saves: { data: { title: string } }[] = [];
  let refuseSave = false;
  let refuseHold = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/locks/'))
        return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 });
      if (url === '/admin/api/publish/checks') return Response.json({ results: [] });
      if (url.startsWith('/admin/api/hold/'))
        return refuseHold
          ? new Response('hold service 4', {
              status: 500,
              headers: { 'content-type': 'text/plain' },
            })
          : Response.json({ held: true });
      if (url === '/admin/api/drafts/listings/seaview-cottage' && init?.method === 'PUT') {
        saves.push(JSON.parse(String(init.body)));
        if (saves.length === 1) return first.promise;
        if (refuseSave)
          return new Response('upstream write 7', {
            status: 500,
            headers: { 'content-type': 'text/plain' },
          });
        return Response.json({ pending: true, problems: [], revisions: { en: 'third' } });
      }
      return Response.json({});
    }),
  );
  app = mount(EditorLocaleFixture, { target: document.body, props: { feedback: true } });
  await vi.advanceTimersByTimeAsync(0);
  const input = q<HTMLInputElement>('input#f-title');
  if (!input) throw new Error('title input missing');
  input.value = 'First unsaved words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dataset.localeProof = 'pending-save-field';
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect(q('.autosave')?.textContent).toContain('Saving…');
  expect(q('#f-summary-err')?.textContent).toBe('Required');

  switchLocale();

  expect(q('.autosave')?.textContent).toContain('Wird gespeichert…');
  expect(q('#f-summary-err')?.textContent).toBe('Erforderlich');
  expect(q<HTMLInputElement>('input#f-title')).toBe(input);
  expect(input.value).toBe('First unsaved words');
  expect(input.dataset.localeProof).toBe('pending-save-field');

  input.value = 'Latest queued words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  first.resolve(Response.json({ pending: true, problems: [], revisions: { en: 'second' } }));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(saves.map((save) => save.data.title)).toEqual([
    'First unsaved words',
    'Latest queued words',
  ]);
  expect(input.value).toBe('Latest queued words');
  expect(q('.autosave')?.textContent).toContain('Gespeichert');

  q<HTMLButtonElement>('.hold-toggle')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(q('.entry-header .subline')?.textContent).toContain('Zurückgehalten');
  switchLocale();
  expect(q('.entry-header .subline')?.textContent).toContain('On hold');
  expect(q<HTMLInputElement>('input#f-title')).toBe(input);

  refuseHold = true;
  q<HTMLButtonElement>('.hold-toggle')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(q('.notice-danger')?.textContent).toContain('The hold could not be changed.');
  expect(q('.notice-danger')?.textContent).toContain('Technical detail: hold service 4');
  switchLocale();
  expect(q('.notice-danger')?.textContent).toContain(
    'Der Status „Noch nicht bereit“ konnte nicht geändert werden.',
  );
  expect(q('.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
  switchLocale();

  refuseSave = true;
  input.value = 'Retry these words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  const notices = () =>
    qa('.notice-danger')
      .map((notice) => notice.textContent)
      .join(' ');
  expect(notices()).toContain('Your changes are still here.');
  expect(notices()).toContain('Technical detail: upstream write 7');
  switchLocale();
  expect(notices()).toContain('Deine Änderungen sind noch hier.');
  expect(notices()).toContain('Technisches Detail: upstream write 7');
  expect(input.value).toBe('Retry these words');

  refuseSave = false;
  q<HTMLButtonElement>('.notice-danger .btn-link')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(notices()).not.toContain('Deine Änderungen sind noch hier.');
  expect(q('.autosave')?.textContent).toContain('Gespeichert');
});

test('an open take-over confirmation retranslates without changing the lock or editor instance', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({
          held_by: { id: 'u2', name: 'Anna Berg' },
          mine: false,
          expires_at: Date.now() + 120_000,
        })
      : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  const field = q<HTMLInputElement>('input#f-title');
  const requestsBeforeSwitch = fetchMock.mock.calls.length;
  q<HTMLButtonElement>('.lock-banner .btn-link')?.click();
  flushSync();
  const dialog = q<HTMLElement>('.dialog');
  expect(dialog?.textContent).toContain('Take over editing from Anna Berg?');

  switchLocale();

  expect(q('.lock-banner')?.textContent).toContain('Wird von Anna Berg bearbeitet');
  expect(q('.dialog')).toBe(dialog);
  expect(dialog?.textContent).toContain('Bearbeitung von Anna Berg übernehmen?');
  expect(q<HTMLInputElement>('input#f-title')).toBe(field);
  expect(q<HTMLFieldSetElement>('.form > fieldset')?.disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);
});

test('a refused take-over stays in the open dialog, retranslates, and retries', async () => {
  let takeAttempts = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/admin/api/locks/')) return Response.json({});
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.take === true) {
      takeAttempts += 1;
      return takeAttempts === 1
        ? new Response('lock store unavailable', {
            status: 500,
            headers: { 'content-type': 'text/plain' },
          })
        : Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 });
    }
    return Response.json({
      held_by: { id: 'u2', name: 'Anna Berg' },
      mine: false,
      expires_at: Date.now() + 120_000,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: { initialUiLocale: 'de' },
  });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  const field = q<HTMLInputElement>('input#f-title');
  q<HTMLButtonElement>('.lock-banner .btn-link')?.click();
  flushSync();
  const dialog = q<HTMLDialogElement>('dialog[open]');

  q<HTMLButtonElement>('dialog[open] .btn-primary')?.click();
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();

  expect(q('dialog[open] [role="alert"]')?.textContent ?? '').toContain(
    'Die Bearbeitung konnte nicht übernommen werden.',
  );
  expect(q('dialog[open] [role="alert"]')?.textContent ?? '').toContain(
    'Technisches Detail: lock store unavailable',
  );
  expect(qa('.main > [role="alert"]')).toHaveLength(0);
  expect(q<HTMLDialogElement>('dialog[open]')).toBe(dialog);
  expect(q<HTMLInputElement>('input#f-title')).toBe(field);
  expect(q<HTMLFieldSetElement>('.form > fieldset')?.disabled).toBe(true);

  switchLocale();

  expect(q<HTMLDialogElement>('dialog[open]')).toBe(dialog);
  expect(q('dialog[open] [role="alert"]')?.textContent ?? '').toContain(
    'The lock could not be taken over.',
  );
  expect(q('dialog[open] [role="alert"]')?.textContent ?? '').toContain(
    'Technical detail: lock store unavailable',
  );
  expect(q<HTMLInputElement>('input#f-title')).toBe(field);

  q<HTMLButtonElement>('dialog[open] .btn-primary')?.click();
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();

  expect(takeAttempts).toBe(2);
  expect(q('dialog[open]')).toBeNull();
  expect(q<HTMLInputElement>('input#f-title')).toBe(field);
  expect(q<HTMLFieldSetElement>('.form > fieldset')?.disabled).toBe(false);
});

test('German anonymous-holder feedback uses complete sentences', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/locks/')
        ? Response.json({
            held_by: { id: 'u2', name: null },
            mine: false,
            expires_at: Date.now() + 120_000,
          })
        : Response.json({}),
    ),
  );
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: { initialUiLocale: 'de' },
  });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();

  expect(q('.lock-banner')?.textContent).toContain('Eine andere Person bearbeitet diesen Eintrag');
  q<HTMLButtonElement>('.lock-banner .btn-link')?.click();
  flushSync();

  expect([q('.dialog h2')?.textContent, q('.dialog p')?.textContent]).toEqual([
    'Bearbeitung einer anderen Person übernehmen?',
    'Nichts von dem, was jemand anderes geschrieben hat, geht verloren — es gibt einen gemeinsamen Entwurf und du machst dort weiter, wo die Person aufgehört hat.',
  ]);
});

test('the German lost-lock announcement uses a complete anonymous-holder sentence', async () => {
  vi.useFakeTimers();
  let lockReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith('/admin/api/locks/')) return Response.json({});
      lockReads += 1;
      return lockReads === 1
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
        : Response.json({
            held_by: { id: 'u2', name: null },
            mine: false,
            expires_at: Date.now() + 120_000,
          });
    }),
  );
  app = mount(EditorLocaleFixture, {
    target: document.body,
    props: { initialUiLocale: 'de' },
  });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  await vi.advanceTimersByTimeAsync(15_000);
  flushSync();

  expect(q('.lock-banner.is-lost')?.textContent).toContain(
    'Eine andere Person hat diesen Eintrag übernommen.',
  );
});

test('an address refusal retranslates without replacing the address draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/locks/')
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
        : url.includes('/address/')
          ? Response.json(
              {
                code: 'ENTRY_ADDRESS_TAKEN',
                error: 'legacy prose',
                address: 'belegt',
                collection: 'listings',
                locale: 'de',
              },
              { status: 409 },
            )
          : Response.json({}),
    ),
  );
  app = mount(EditorLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  q<HTMLButtonElement>('.slug-row .btn-link')?.click();
  flushSync();
  const input = q<HTMLInputElement>('#entry-address');
  if (!input) throw new Error('address input missing');
  input.value = 'belegt';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  q<HTMLButtonElement>('.slug-row .btn-sm')?.click();
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  expect(q('.slug-row .is-bad')?.textContent).toContain('already the web address');

  switchLocale();

  expect(q<HTMLInputElement>('#entry-address')).toBe(input);
  expect(input.value).toBe('belegt');
  expect(q('.slug-row .is-bad')?.textContent).toContain('bereits die Webadresse');
});

test('an open offsite choice retranslates without losing its target draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/locks/')
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120_000 })
        : Response.json({}),
    ),
  );
  app = mount(EditorLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  q<HTMLButtonElement>('[aria-label="More actions"]')?.click();
  flushSync();
  qa<HTMLButtonElement>('[role="menuitem"]')
    .find((button) => button.textContent?.trim() === 'Delete')
    ?.click();
  flushSync();
  const dialog = q<HTMLDialogElement>('.dialog');
  qa<HTMLInputElement>('.dialog input[type="radio"]')
    .find((input) => input.value === 'url')
    ?.click();
  flushSync();
  const address = q<HTMLInputElement>('#offsite-url');
  if (!dialog || !address) throw new Error('offsite URL choice missing');
  address.value = 'https://example.com/archive';
  address.dispatchEvent(new Event('input', { bubbles: true }));

  switchLocale();

  expect(q('.dialog')).toBe(dialog);
  expect(q('.dialog h2')?.textContent).toBe('Wohin sollen Besucher dieser Seite jetzt gelangen?');
  expect(q<HTMLInputElement>('#offsite-url')).toBe(address);
  expect(address.value).toBe('https://example.com/archive');
});
