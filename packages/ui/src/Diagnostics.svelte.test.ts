import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Diagnostics from './Diagnostics.svelte';

let app: ReturnType<typeof mount>;

const CONFIG = {
  collections: [{ name: 'pages' }, { name: 'listings', route: '/listings/[slug]' }],
  locales: ['en', 'de'],
  defaultLocale: 'en',
  mediaBase: 'https://media.example.com',
  mailer: { provider: 'resend', from: 'hello@example.com' },
  preview: true,
  dev: false,
};

/** One of the client's own keys as the settings endpoint answers for it. */
type Key = {
  key: string;
  source: 'settings' | 'env' | 'code' | 'off';
  fallback: 'env' | 'code' | 'off';
  hint: string | null;
  updatedAt: number | null;
  by: string | null;
};
const NOTHING_SET: Key[] = [
  { key: 'deepl', source: 'off', fallback: 'off', hint: null, updatedAt: null, by: null },
  { key: 'assist', source: 'off', fallback: 'off', hint: null, updatedAt: null, by: null },
];

/** What the diagnostics endpoints answer, plus every request the screen made. */
let requests: string[] = [];
let sent: { url: string; init?: RequestInit }[] = [];
function server(
  answers: Record<string, Response | (() => Response)> = {},
  config: Partial<typeof CONFIG> = {},
  keys: Key[] = NOTHING_SET,
) {
  const calls: string[] = [];
  requests = calls;
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      sent.push({ url, init });
      // A test's own answer wins, so the settings list can be made to fail like anything else.
      const answer = answers[url];
      if (answer !== undefined) return typeof answer === 'function' ? answer() : answer;
      if (url === '/admin/api/diagnostics') return Response.json({ ...CONFIG, ...config });
      if (url === '/admin/api/settings') return Response.json({ integrations: keys });
      return Response.json({ ok: true, detail: `${url} answered.` });
    }),
  );
  return calls;
}

const show = async (
  answers: Record<string, Response | (() => Response)> = {},
  config: Partial<typeof CONFIG> = {},
  keys: Key[] = NOTHING_SET,
) => {
  server(answers, config, keys);
  app = mount(Diagnostics, { target: document.body });
  flushSync();
  await settle();
  return document.body;
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const card = (root: HTMLElement, name: string) => {
  const found = Array.from(root.querySelectorAll<HTMLElement>('.check-card')).find(
    (c) => c.querySelector('.name')?.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No check card named ${name}`);
  return found;
};
/** The same lookup, for a card a test expects not to be there: a missing one reads as empty. */
const cardOr = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll<HTMLElement>('.check-card')).find(
    (c) => c.querySelector('.name')?.textContent?.trim() === name,
  ) ?? document.createElement('div');
const press = (within: ParentNode, label: string) => {
  const found = Array.from(within.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  found.click();
  flushSync();
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// The one check on the page with a side effect. Opening Settings must not mail the owner, so
// the email card is the only one that waits to be asked.
test('opening the page runs every check except the one that sends an email', async () => {
  await show();
  expect(requests.filter((url) => url.startsWith('/admin/api/checks/')).sort()).toEqual([
    '/admin/api/checks/build',
    '/admin/api/checks/database',
    '/admin/api/checks/github',
    '/admin/api/checks/storage',
    '/admin/api/checks/translation',
  ]);
});

test('the test email is sent only when its own button is pressed', async () => {
  const root = await show({
    '/admin/api/checks/email': Response.json({ ok: true, to: 'martin@example.com' }),
  });
  expect(text(card(root, 'Email'))).not.toContain('martin@example.com');

  press(card(root, 'Email'), 'Send a test email');
  await settle();

  expect(requests).toContain('/admin/api/checks/email');
  expect(text(card(root, 'Email'))).toContain('Sent to martin@example.com.');
});

test("a failing check shows the developer's own sentence and counts at the top", async () => {
  const root = await show({
    '/admin/api/checks/storage': () =>
      Response.json({ error: 'The bucket refused the upload (403)' }, { status: 502 }),
  });
  expect(text(card(root, 'Images and files (R2)'))).toContain(
    'The bucket refused the upload (403)',
  );
  expect(card(root, 'Images and files (R2)').querySelector('.badge')?.textContent).toBe(
    'Not working',
  );
  expect(text(root.querySelector('.page-alert') as HTMLElement)).toBe(
    '1 check is failing. Uploading pictures and files will not work until it is fixed.',
  );
  // A failure never hides the rest of the page: the checks below it are still there.
  expect(text(card(root, 'Database'))).toContain('answered');
});

test('two failures are one sentence naming both, in the plural', async () => {
  const root = await show({
    '/admin/api/checks/storage': () => Response.json({ error: 'no' }, { status: 502 }),
    '/admin/api/checks/database': () => Response.json({ error: 'no' }, { status: 502 }),
  });
  expect(text(root.querySelector('.page-alert') as HTMLElement)).toBe(
    '2 checks are failing. Uploading pictures and files and editing anything at all will not work until they are fixed.',
  );
});

test('a check whose thing the site never configured is off, not broken', async () => {
  const root = await show({
    '/admin/api/checks/translation': Response.json({
      off: true,
      detail: 'No DEEPL_API_KEY and no translate hook, so the Translate button is hidden.',
    }),
  });
  expect(card(root, 'Translation').querySelector('.badge')?.textContent).toBe('Not in use');
  expect(root.querySelector('.page-alert')).toBeNull();
});

test('the configuration is read back as facts nobody can edit here', async () => {
  const root = await show();
  const facts = text(root.querySelector('.facts') as HTMLElement);
  expect(facts).toContain('Listings /listings/[slug]');
  expect(facts).toContain('English default');
  expect(facts).toContain('Resend from hello@example.com');
  expect(root.querySelector('.settings input')).toBeNull();
});

test('a build without preview names the variable that turns it on', async () => {
  const root = await show({}, { preview: false });
  expect(text(root.querySelector('.facts') as HTMLElement)).toContain('PREVIEW_ENABLED');
});

// The button commits to the repository, so it is a developer's and not a client's.
test('simulating a conflict is offered in development and nowhere else', async () => {
  const off = await show();
  expect(text(off)).not.toContain('Simulate a conflict');
  unmount(app);
  document.body.innerHTML = '';

  const root = await show({}, { dev: true });
  expect(text(root)).toContain('Developer tools');
  press(root, 'Simulate a conflict');
  await settle();
  expect(text(root)).toContain('Open Unpublished changes to resolve it');
});

// --- Integrations: the one section of this page that writes ---

const SET_HERE: Key[] = [
  {
    key: 'deepl',
    source: 'settings',
    fallback: 'off',
    hint: 'x7Kq',
    updatedAt: Date.parse('2026-05-03T09:00:00Z'),
    by: 'Martin',
  },
  { key: 'assist', source: 'off', fallback: 'off', hint: null, updatedAt: null, by: null },
];
const type = (root: ParentNode, value: string) => {
  const input = root.querySelector('input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const submit = (root: ParentNode) => {
  (root.querySelector('form') as HTMLFormElement).requestSubmit();
  flushSync();
};
const dialog = () => document.querySelector('.dialog') as HTMLElement | null;

test('a key set here is known by its last four, by who set it and by nothing else', async () => {
  const root = await show({}, {}, SET_HERE);
  const deepl = cardOr(root, 'DeepL');
  expect(text(deepl)).toContain('…x7Kq');
  expect(text(deepl)).toContain('set by Martin on 3 May 2026');
  expect(deepl.querySelector('.badge')?.textContent).toBe('Set here');
});

test('removing a key says what takes over before the button is pressed', async () => {
  const off = await show({}, {}, SET_HERE);
  expect(text(cardOr(off, 'DeepL'))).toContain('Removing it hides the Translate button');
  unmount(app);
  document.body.innerHTML = '';

  const root = await show({}, {}, [{ ...(SET_HERE[0] as Key), fallback: 'env' }]);
  expect(text(cardOr(root, 'DeepL'))).toContain(
    "Removing it falls back to the key in your site's settings",
  );
});

test("a key only the site's own settings hold is named as the developer's", async () => {
  const root = await show({}, {}, [
    { key: 'deepl', source: 'env', fallback: 'env', hint: null, updatedAt: null, by: null },
  ]);
  const deepl = cardOr(root, 'DeepL');
  expect(text(deepl)).toContain("Set in your site's own settings by your developer");
  expect(text(deepl)).not.toContain('Remove');
  press(deepl, 'Set a key here');
  expect(text(dialog() as HTMLElement)).toContain('DeepL key');
});

test('a site whose own code translates is not offered a key that would do nothing', async () => {
  const root = await show({}, {}, [
    { key: 'deepl', source: 'code', fallback: 'code', hint: null, updatedAt: null, by: null },
  ]);
  const deepl = cardOr(root, 'DeepL');
  expect(text(deepl)).toContain('translates with its own code');
  expect(deepl.querySelectorAll('button')).toHaveLength(0);
});

test('nothing set anywhere says what is switched off, and offers a key', async () => {
  const root = await show();
  expect(text(cardOr(root, 'DeepL'))).toContain('the Translate button is hidden everywhere');
  // Nothing reads a writing-help key yet, and a card that implied otherwise would be a promise.
  expect(text(cardOr(root, 'Writing help (AI)'))).toContain('no writing help in this version yet');
});

test('a saved key goes to its own endpoint and the list is read again', async () => {
  const root = await show(
    { '/admin/api/settings/deepl': Response.json({ ok: true }) },
    {},
    SET_HERE,
  );
  press(cardOr(root, 'DeepL'), 'Replace');
  type(dialog() as HTMLElement, 'fx-1111-9zQp');
  submit(dialog() as HTMLElement);
  await settle();

  const put = sent.find((call) => call.init?.method === 'PUT');
  expect(put?.url).toBe('/admin/api/settings/deepl');
  expect(JSON.parse(String(put?.init?.body))).toEqual({ value: 'fx-1111-9zQp' });
  // The card is drawn from the answer to a fresh read, never from what was typed.
  expect(requests.filter((url) => url === '/admin/api/settings')).toHaveLength(2);
  expect(dialog()).toBeNull();
});

test('what was typed is gone from the page once it is saved', async () => {
  const root = await show(
    { '/admin/api/settings/deepl': Response.json({ ok: true }) },
    {},
    SET_HERE,
  );
  press(cardOr(root, 'DeepL'), 'Replace');
  type(dialog() as HTMLElement, 'fx-1111-9zQp');
  submit(dialog() as HTMLElement);
  await settle();
  expect(text(root)).not.toContain('fx-1111-9zQp');
  expect(root.querySelector('input')).toBeNull();
});

test('a key the service refuses keeps the dialog open and says what refused it', async () => {
  const root = await show(
    {
      '/admin/api/settings/deepl': () =>
        Response.json({ error: 'DeepL refused the translation (403)' }, { status: 502 }),
    },
    {},
    SET_HERE,
  );
  press(cardOr(root, 'DeepL'), 'Replace');
  type(dialog() as HTMLElement, 'wrong');
  submit(dialog() as HTMLElement);
  await settle();

  const open = dialog();
  expect(open).not.toBeNull();
  expect(text(open ?? document.createElement('div'))).toContain(
    'DeepL refused the translation (403)',
  );
  expect(requests.filter((url) => url === '/admin/api/settings')).toHaveLength(1);
});

test('removing a key asks the route to and reads the list again', async () => {
  const root = await show(
    { '/admin/api/settings/deepl': Response.json({ ok: true }) },
    {},
    SET_HERE,
  );
  press(cardOr(root, 'DeepL'), 'Remove');
  await settle();

  const gone = sent.find((call) => call.init?.method === 'DELETE');
  expect(gone?.url).toBe('/admin/api/settings/deepl');
  expect(requests.filter((url) => url === '/admin/api/settings')).toHaveLength(2);
});

// The half axe scores nothing on: a dialog that opens takes focus, and closing gives it back.
test('the dialog takes focus and hands it back to the button that opened it', async () => {
  const root = await show({}, {}, SET_HERE);
  const replace = Array.from(cardOr(root, 'DeepL').querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith('Replace'),
  ) as HTMLButtonElement;
  replace.focus();
  replace.click();
  flushSync();
  expect(document.activeElement?.id).toBe('key-value');

  press(dialog() ?? document.createElement('div'), 'Cancel');
  expect(document.activeElement).toBe(replace);
});

test('keys that could not be read say so where the cards would have been', async () => {
  const root = await show({
    '/admin/api/settings': () => Response.json({ error: 'no' }, { status: 500 }),
  });
  const section = Array.from(root.querySelectorAll<HTMLElement>('.settings-section')).find(
    (s) => s.querySelector('h2')?.textContent === 'Integrations',
  );
  expect(text(section ?? document.createElement('div'))).toContain(
    'The keys you own could not be read (500).',
  );
});
