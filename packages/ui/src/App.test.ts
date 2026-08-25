import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App.svelte';

let app: ReturnType<typeof mount>;
const session = (role: 'owner' | 'editor' = 'owner') => ({
  collections: ['listings', 'pages'],
  user: { id: 'u1', name: 'Martin', email: 'martin@example.com' },
  role,
});
const show = (signedIn: ReturnType<typeof session> | null, path = '/admin') => {
  app = mount(App, { target: document.body, props: { session: signedIn, path } });
  flushSync();
  return document.body;
};
const drafts = (...files: string[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/ping')
        return Response.json({ ok: true, collections: ['listings', 'pages'] });
      if (url.startsWith('/admin/api/entries/')) return Response.json({ entries: [] });
      return Response.json({ files: files.map((path) => ({ path, updated_at: 1755864000000 })) });
    }),
  );
afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

test('the shell renders sidebar, top bar and main regions once logged in', () => {
  drafts();
  const root = show(session());
  expect(root.querySelector('aside.sidebar[aria-label="Main"]')).not.toBeNull();
  expect(root.querySelector('header.topbar')).not.toBeNull();
  expect(root.querySelector('main.main')).not.toBeNull();
  expect(root.querySelector('input[type="password"]')).toBeNull();
});

test('the Manage group offers Members and Settings to an owner', () => {
  drafts();
  const root = show(session('owner'));
  const links = root.querySelectorAll<HTMLAnchorElement>('[aria-labelledby="nav-manage"] a');
  expect(Array.from(links, (a) => a.textContent)).toEqual([
    'Media',
    'Activity',
    'Members',
    'Settings',
  ]);
});

test('an editor is offered neither Members nor Settings', () => {
  drafts();
  const root = show(session('editor'));
  const links = root.querySelectorAll<HTMLAnchorElement>('[aria-labelledby="nav-manage"] a');
  expect(Array.from(links, (a) => a.textContent)).toEqual(['Media', 'Activity']);
});

// A Manage destination whose screen has not been built yet must say so: the shell serves the
// same HTML for every /admin path, so falling through would show a page headed Dashboard.
// Members was this test's subject until its screen was built; Settings is 3.25's.
test('a Manage route with no screen yet names itself', () => {
  drafts();
  const root = show(session('owner'), '/admin/settings');
  expect(root.querySelector('main.main h1')?.textContent).toBe('Settings');
  expect(root.querySelector('main.main')?.textContent).toContain('This screen is not built yet');
});

test('an owner on the members route gets the members screen, not the placeholder', () => {
  drafts();
  const root = show(session('owner'), '/admin/members');
  expect(root.querySelector('main.main')?.textContent).not.toContain('not built yet');
  expect(root.querySelector('main.main .list-toolbar .btn-primary')?.textContent?.trim()).toBe(
    'Invite',
  );
});

test('the signed-in name and role are in the top bar', () => {
  drafts();
  const root = show(session('owner'));
  expect(root.querySelector('.user-menu .name')?.textContent).toBe('Martin');
  expect(root.querySelector('.user-menu .role')?.textContent).toBe('Owner');
});

// Regression: sign-out was posted with no content type, which Better Auth refuses with 415 —
// the form came back while the cookie stayed valid.
test('signing out posts a request Better Auth accepts, and shows the login form', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ success: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show(session('owner'));

  root.querySelector<HTMLButtonElement>('.user-menu button')?.click();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();

  const call = fetchMock.mock.calls.find(([url]) => url === '/admin/api/auth/sign-out');
  expect(call?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  expect(root.querySelector('input#password')).not.toBeNull();
});

test('without a session only the login form renders', () => {
  const root = show(null);
  expect(root.querySelector('label[for="password"]')?.textContent).toBe('Password');
  expect(root.querySelector('input#password[type="password"]')).not.toBeNull();
  expect(root.querySelector('.sidebar')).toBeNull();
});

test('the indicator counts the pending files and opens the drawer', async () => {
  drafts('src/content/listings/en/mill-house.yaml');
  const root = show(session());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const indicator = root.querySelector<HTMLButtonElement>('button.indicator');
  expect(indicator?.textContent?.trim()).toBe('1 unpublished change');
  expect(root.querySelector('.drawer')).toBeNull();

  indicator?.click();
  flushSync();
  expect(root.querySelector('.drawer .drawer-meta .count')?.textContent).toBe('1 file');
  // The shell is inert while the drawer is up, so focus has to be inside it.
  expect(document.activeElement).toBe(root.querySelector('.drawer'));

  root.querySelector<HTMLButtonElement>('.drawer [aria-label="Close"]')?.click();
  flushSync();
  expect(root.querySelector('.drawer')).toBeNull();
  expect(document.activeElement).toBe(indicator);
});

test('the sidebar links one entry list per configured collection', async () => {
  drafts();
  const root = show(session());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const links = root.querySelectorAll<HTMLAnchorElement>('[aria-labelledby="nav-content"] a');
  expect(Array.from(links, (a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Listings', '/admin/c/listings'],
    ['Pages', '/admin/c/pages'],
  ]);
});

test("a collection path renders that collection's entry list", async () => {
  drafts();
  const root = show(session(), '/admin/c/listings');
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  expect(root.querySelector('.list-toolbar h1')?.textContent).toContain('Listings');
  expect(
    root.querySelector('[aria-labelledby="nav-content"] a[aria-current="page"]')?.textContent,
  ).toBe('Listings');
});

// The load-bearing half of the way out of a conflict: after the draft is gone the editor must
// not keep the values it had, or the next keystroke saves them back over what was taken.
test('discarding a draft loads the entry again instead of leaving the old one on screen', async () => {
  const PATH = 'src/content/listings/en/mill-house.yaml';
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
    if (url === '/admin/api/drafts')
      return Response.json({ files: [{ path: PATH, updated_at: 1755864000000 }] });
    if (url === '/admin/api/publish')
      return Response.json({ error: 'refused', paths: [PATH] }, { status: 409 });
    if (init?.method === 'DELETE') return Response.json({});
    return Response.json({
      fields: [],
      blocks: {},
      data: { title: 'The Mill House' },
      pending: ['en'],
      problems: [],
      locales: ['en'],
      defaultLocale: 'en',
      sourceLocale: 'en',
      drift: [],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    }
  };
  const loads = () =>
    fetchMock.mock.calls.filter(([url]) => url === '/admin/api/entries/listings/mill-house').length;

  const root = show(session(), '/admin/c/listings/mill-house');
  await settle();
  expect(loads()).toBe(1);

  root.querySelector<HTMLButtonElement>('button.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();
  root.querySelector<HTMLButtonElement>('.change-row.is-blocked .change-actions .btn')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.dialog .btn-danger')?.click();
  await settle();

  expect(loads()).toBe(2);
});
