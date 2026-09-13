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
  expect(q('.editor-modes')?.getAttribute('aria-label')).toBe('Editoransicht');
  expect(qa<HTMLButtonElement>('.editor-modes button').map((button) => button.textContent)).toEqual(
    ['Formular', 'Geteilt', 'Canvas'],
  );
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
    q<HTMLButtonElement>('[aria-label="Language"] button[aria-pressed="true"]')?.textContent,
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

  qa<HTMLButtonElement>('[aria-label="Language"] button')[1]?.click();
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
  expect(q('.hold-toggle')?.getAttribute('aria-pressed')).toBe('true');
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
