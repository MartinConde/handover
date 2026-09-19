import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { UiLocale } from '../i18n.js';
import NewEntry from './NewEntry.svelte';

let app: ReturnType<typeof mount>;

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

test('creation is a modal keyboard boundary with a predictable first control', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [] })),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  const dialog = document.querySelector<HTMLDialogElement>('[aria-labelledby="new-entry-h"]');
  const title = document.querySelector<HTMLInputElement>('#new-title');
  const create = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(title);

  create?.focus();
  create?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(title);
  title?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(create);
});

test('creation cannot be dismissed while its write is in flight', async () => {
  const writing = deferred<Response>();
  const close = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url === '/admin/api/entries/pages' && init?.method === 'POST'
        ? writing.promise
        : Promise.resolve(Response.json({ entries: [] })),
    ),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: close },
  });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  if (!title) throw new Error('title missing');
  title.value = 'A page';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  flushSync();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLButtonElement>('.actions .btn')?.disabled).toBe(true);

  writing.resolve(new Response('refused', { status: 500 }));
  await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

test('creation waits for its catalogue and retry restores templates and collision preview', async () => {
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json({ entries: [{ id: 'new-page' }], templates: ['campaign'] });
    }),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  if (!title) throw new Error('title missing');
  title.value = 'New page';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(document.querySelector('.entry-read-error')?.textContent).toContain(
    'Could not check existing pages',
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.body.textContent).not.toContain('Saved as new-page.');

  document.querySelector<HTMLButtonElement>('.entry-read-error button')?.click();
  await settle();

  expect(document.body.textContent).toContain('Saved as new-page-2.');
  expect(document.body.textContent).toContain('Campaign template');
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

test.each([
  ['entry row', { entries: [null] }],
  ['template row', { entries: [], templates: [null] }],
])(
  'an invalid directory %s uses the retry state without rendering unsafe data',
  async (_name, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
    app = mount(NewEntry, {
      target: document.body,
      props: { collection: 'pages', onclose: () => {} },
    });
    await settle();

    expect(document.querySelector('.entry-read-error')?.textContent ?? '').toContain(
      'Could not check existing pages',
    );
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  },
);

test.each([
  ['a string', 'not a directory'],
  ['an array', []],
])('an invalid directory envelope containing %s uses the retry state', async (_name, body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  expect(document.querySelector('.entry-read-error')?.textContent ?? '').toContain(
    'Could not check existing pages',
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
});

test('an empty directory record remains a valid empty result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  expect(document.querySelector('.entry-read-error')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

test('an open creation keeps its draft and translates retained failure', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('Draft already exists', { status: 409 });
      reads += 1;
      return Response.json({ entries: [], templates: ['flat-by-the-sea'] });
    }),
  );
  const props = $state({
    collection: 'listings',
    uiLocale: 'en' as UiLocale,
    onclose: () => {},
  });
  app = mount(NewEntry, { target: document.body, props });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  const starter = document.querySelector<HTMLInputElement>('input[value="flat-by-the-sea"]');
  if (!title || !starter) throw new Error('creation controls missing');
  title.value = 'Küstenhaus';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  starter.click();
  document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  await settle();
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('That did not work (409)');

  props.uiLocale = 'de';
  flushSync();

  expect(document.querySelector('h2')?.textContent).toBe('Neuer Eintrag in listings');
  expect(document.querySelector('#new-title')).toBe(title);
  expect(title.value).toBe('Küstenhaus');
  expect(starter.checked).toBe(true);
  expect(document.querySelector('[role="alert"]')).toBe(alert);
  expect(alert?.textContent).toContain('Das hat nicht funktioniert (409).');
  expect(alert?.textContent).toContain('Draft already exists');
  expect(reads).toBe(1);
});

test.each([
  [
    'invalid JSON',
    () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  ],
  ['a missing slug', () => Response.json({})],
  ['an unusable slug', () => Response.json({ slug: 'not/a-file-name' })],
])(
  'a successful response with %s keeps the draft and retranslates unconfirmed guidance',
  async (_case, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? response() : Response.json({ entries: [] }),
      ),
    );
    const props = $state({ collection: 'pages', uiLocale: 'en' as UiLocale, onclose: () => {} });
    app = mount(NewEntry, { target: document.body, props });
    await settle();
    const title = document.querySelector<HTMLInputElement>('#new-title');
    if (!title) throw new Error('title missing');
    title.value = 'About';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Creation may have succeeded. Check the entry list before trying again.',
    );
    expect(title.value).toBe('About');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      false,
    );
    expect(location.pathname).not.toContain('undefined');

    props.uiLocale = 'de';
    flushSync();

    expect(document.querySelector('[role="alert"]')).toBe(alert);
    expect(alert?.textContent).toContain(
      'Die Erstellung könnte erfolgreich gewesen sein. Prüfe die Eintragsliste, bevor du es erneut versuchst.',
    );
    expect(title.value).toBe('About');
  },
);

const directory = (body: unknown, posted: (init: RequestInit) => Response) =>
  vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? posted(init) : Response.json(body),
  );

test('a new entry is created in the language the dialog chose', async () => {
  let sent = '';
  vi.stubGlobal(
    'fetch',
    directory({ entries: [], locales: ['en', 'de', 'fr'], defaultLocale: 'en' }, (init) => {
      sent = String(init.body);
      return Response.json({ slug: 'kuestenhaus' });
    }),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  const language = document.querySelector<HTMLSelectElement>('#new-locale');
  if (!language) throw new Error('language select missing');
  expect(Array.from(language.options, (o) => o.value)).toEqual(['en', 'de', 'fr']);
  expect(language.value).toBe('en');
  language.value = 'de';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  await settle();

  expect(JSON.parse(sent)).toEqual({ title: '', locale: 'de' });
});

test('the language the list is filtered to is the one the dialog offers first', async () => {
  vi.stubGlobal(
    'fetch',
    directory({ entries: [], locales: ['en', 'de', 'fr'], defaultLocale: 'en' }, () =>
      Response.json({ slug: 'x' }),
    ),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', preferred: 'fr', onclose: () => {} },
  });
  await settle();

  expect(document.querySelector<HTMLSelectElement>('#new-locale')?.value).toBe('fr');
});

test('a filter language the site does not declare leaves the site default chosen', async () => {
  vi.stubGlobal(
    'fetch',
    directory({ entries: [], locales: ['en', 'de'], defaultLocale: 'de' }, () =>
      Response.json({ slug: 'x' }),
    ),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', preferred: 'fr', onclose: () => {} },
  });
  await settle();

  expect(document.querySelector<HTMLSelectElement>('#new-locale')?.value).toBe('de');
});

test('a one-language site is asked nothing and sends no language', async () => {
  let sent = '';
  vi.stubGlobal(
    'fetch',
    directory({ entries: [], locales: ['en'], defaultLocale: 'en' }, (init) => {
      sent = String(init.body);
      return Response.json({ slug: 'x' });
    }),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  expect(document.querySelector('#new-locale')).toBeNull();
  document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  await settle();

  expect(JSON.parse(sent)).toEqual({ title: '' });
});

test('an interface switch keeps the chosen language and the typed title', async () => {
  vi.stubGlobal(
    'fetch',
    directory({ entries: [], locales: ['en', 'de'], defaultLocale: 'en' }, () =>
      Response.json({ slug: 'x' }),
    ),
  );
  const props = $state({ collection: 'pages', uiLocale: 'en' as UiLocale, onclose: () => {} });
  app = mount(NewEntry, { target: document.body, props });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  const language = document.querySelector<HTMLSelectElement>('#new-locale');
  if (!title || !language) throw new Error('creation controls missing');
  title.value = 'Küstenhaus';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  language.value = 'de';
  language.dispatchEvent(new Event('change', { bubbles: true }));

  props.uiLocale = 'de';
  flushSync();

  expect(document.querySelector('#new-locale')).toBe(language);
  expect(language.value).toBe('de');
  expect(Array.from(language.options, (o) => o.textContent)).toEqual(['Englisch', 'Deutsch']);
  expect(title.value).toBe('Küstenhaus');
});
