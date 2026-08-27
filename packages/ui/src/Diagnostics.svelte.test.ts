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

/** What the diagnostics endpoints answer, plus every request the screen made. */
let requests: string[] = [];
function server(
  answers: Record<string, Response | (() => Response)> = {},
  config: Partial<typeof CONFIG> = {},
) {
  const calls: string[] = [];
  requests = calls;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/admin/api/diagnostics') return Response.json({ ...CONFIG, ...config });
      const answer = answers[url];
      if (answer === undefined) return Response.json({ ok: true, detail: `${url} answered.` });
      return typeof answer === 'function' ? answer() : answer;
    }),
  );
  return calls;
}

const show = async (
  answers: Record<string, Response | (() => Response)> = {},
  config: Partial<typeof CONFIG> = {},
) => {
  server(answers, config);
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
