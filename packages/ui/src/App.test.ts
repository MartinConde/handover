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
const pendingEntry = (key: string) => ({
  key,
  title: key.split('/')[1] ?? key,
  collection: key.split('/')[0] ?? '',
  locales: ['en'],
  files: [`src/content/${key.split('/')[0]}/en/${key.split('/')[1]}.yaml`],
  updated_at: 1755864000000,
});
// What the build endpoint answers, per test; `{}` is a site with no build status at all.
let buildBody: Record<string, unknown> = {};
const drafts = (...keys: string[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/ping')
        return Response.json({ ok: true, collections: ['listings', 'pages'] });
      if (url.startsWith('/admin/api/entries/')) return Response.json({ entries: [] });
      if (url.startsWith('/admin/api/activity')) return Response.json({ events: [], cursor: null });
      if (url === '/admin/api/members') return Response.json({ members: [] });
      if (url === '/admin/api/build') return Response.json(buildBody);
      return Response.json({ entries: keys.map(pendingEntry) });
    }),
  );
afterEach(() => {
  unmount(app);
  buildBody = {};
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

// The activity log is the one Manage screen with no role condition on its branch: an editor
// sees it, and which events are in it is decided by the server.
test('an editor on the activity route gets the screen, not the placeholder', () => {
  drafts();
  const root = show(session('editor'), '/admin/activity');
  expect(root.querySelector('main.main')?.textContent).not.toContain('not built yet');
  expect(root.querySelector('main.main h1')?.textContent).toBe('Activity');
  expect(root.querySelector('#activity-person')).toBeNull();
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

test('the indicator counts the pending entries and opens the drawer', async () => {
  drafts('listings/mill-house');
  const root = show(session());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const indicator = root.querySelector<HTMLButtonElement>('button.indicator');
  expect(indicator?.textContent?.trim()).toBe('1 unpublished change');
  expect(root.querySelector('.drawer')).toBeNull();

  indicator?.click();
  flushSync();
  expect(root.querySelector('.drawer .drawer-meta .count')?.textContent).toBe('1 change');
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
      return Response.json({ entries: [pendingEntry('listings/mill-house')] });
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

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

// A status that only changes colour is not a status: every state says what it is in words, and
// the live region holds the state rather than the counter that ticks beside it.
test('a running build says so in words, inside a live region', async () => {
  buildBody = { commit_sha: 'c0ffee11', state: 'building', started_at: Date.now() - 80_000 };
  drafts();
  const root = show(session());
  await settle();

  const region = root.querySelector('.topbar [role="status"]');
  expect(region?.querySelector('.pill')?.className).toContain('pill-building');
  expect(region?.textContent).toContain('Building…');
  // The elapsed time is out of the live region's reach, or every tick says the pill again.
  expect(root.querySelector('.topbar .pill .detail')?.getAttribute('aria-hidden')).toBe('true');
});

test('a build that is still running warns that the admin may reload', async () => {
  buildBody = { commit_sha: 'c0ffee11', state: 'building' };
  drafts();
  const root = show(session());
  await settle();

  expect(root.querySelector('.banner-info')?.textContent).toContain('may reload briefly');
});

test('a failed build says so and offers a revert of that commit', async () => {
  buildBody = { commit_sha: 'c0ffee11', state: 'failed' };
  drafts();
  const root = show(session());
  await settle();

  const pill = root.querySelector('.topbar .pill');
  expect(pill?.className).toContain('pill-failed');
  expect(pill?.textContent).toContain('Build failed');
  pill?.querySelector<HTMLButtonElement>('.btn-link')?.click();
  flushSync();
  expect(document.querySelector('[aria-labelledby="revert-h"]')).not.toBeNull();
  expect(root.querySelector('.banner-info')).toBeNull();
});

test('a site with no build status draws no pill and no banner', async () => {
  drafts();
  const root = show(session());
  await settle();

  expect(root.querySelector('.topbar .pill')).toBeNull();
  expect(root.querySelector('.banner-info')).toBeNull();
  // The live region stays, so the first state to arrive is announced rather than missed.
  expect(root.querySelector('.topbar [role="status"]')).not.toBeNull();
});

// The live pill says when the site last changed, not only that it is up — app-shell state 1.
test('a live build says since when', async () => {
  buildBody = {
    commit_sha: 'c0ffee11',
    state: 'live',
    live_at: new Date('2026-08-25T14:02:00').getTime(),
  };
  drafts();
  const root = show(session());
  await settle();

  const pill = root.querySelector('.topbar .pill');
  expect(pill?.className).toContain('pill-live');
  expect(pill?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Live since 02:02 PM');
});

// The pill on a site that has published nothing is the worker's own deploy: worth showing, but
// there is no commit of the admin's behind it to take back.
test('a failed build with no commit of ours offers no revert', async () => {
  buildBody = { state: 'failed' };
  drafts();
  const root = show(session());
  await settle();

  const pill = root.querySelector('.topbar .pill');
  expect(pill?.textContent).toContain('Build failed');
  expect(pill?.querySelector('.btn-link')).toBeNull();
});

// After a revert the drawer's "Published 1 change" describes a commit that no longer stands, and
// its Revert would be refused. The panel goes with the publish it was about.
test("a revert clears the drawer's account of the publish it undid", async () => {
  buildBody = { commit_sha: 'c0ffee11', state: 'building' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
      if (url === '/admin/api/build') return Response.json(buildBody);
      if (url === '/admin/api/publish')
        return Response.json({ commit_sha: 'c0ffee11', paths: ['src/content/listings/en/a.yaml'] });
      if (url === '/admin/api/revert') return Response.json({ commit_sha: 'rev999', paths: [] });
      void init;
      return Response.json({ entries: [pendingEntry('listings/a')] });
    }),
  );
  const root = show(session());
  await settle();
  root.querySelector<HTMLButtonElement>('.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();
  expect(root.querySelector('.publish-result')).not.toBeNull();

  root.querySelector<HTMLButtonElement>('.publish-result .btn-link')?.click();
  flushSync();
  document.querySelector<HTMLButtonElement>('[aria-labelledby="revert-h"] .btn-danger')?.click();
  await settle();

  expect(root.querySelector('.publish-result')).toBeNull();
  expect(root.querySelector('.drawer')).not.toBeNull();
});
