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
      if (url === '/admin/api/dashboard')
        return Response.json({ recent: [], published: null, translations: null });
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

// Settings was the last Manage destination with no screen behind it, so the shell's "not built
// yet" placeholder went with it. An editor who types the route is not shown the screen: the
// shell serves the same HTML for every /admin path, so the branch is the gate the sidebar is not.
test('an owner on the settings route gets the diagnostics screen', () => {
  drafts();
  const root = show(session('owner'), '/admin/settings');
  expect(root.querySelector('main.main h1')?.textContent).toBe('Settings');
  expect(root.querySelector('main.main .list-note')?.textContent).toContain('cms.config.ts');
});

test('an editor who types the settings route is not shown it', () => {
  drafts();
  const root = show(session('editor'), '/admin/settings');
  expect(root.querySelector('main.main h1')?.textContent).toBe('Dashboard');
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

// The account menu. Name, email and role are context inside it and the role is never a control:
// it is changed on the members screen.
test('the account menu opens from the top bar with the two things it offers', () => {
  drafts();
  const root = show(session('editor'));
  expect(root.querySelector('.user-menu .menu')).toBeNull();

  const toggle = root.querySelector<HTMLButtonElement>('.user-menu > button');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  toggle?.click();
  flushSync();

  const menu = root.querySelector('.user-menu .menu');
  expect(menu?.querySelector('.who .name')?.textContent).toContain('Martin');
  expect(menu?.querySelector('.who .badge')?.textContent).toBe('Editor');
  expect(menu?.querySelector('.who .email')?.textContent).toBe('martin@example.com');
  expect(
    Array.from(menu?.querySelectorAll('a, button') ?? [], (e) => e.textContent?.trim()),
  ).toEqual(['Account', 'Sign out']);
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
});

test('Escape closes the account menu', () => {
  drafts();
  const root = show(session());
  root.querySelector<HTMLButtonElement>('.user-menu > button')?.click();
  flushSync();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();
  expect(root.querySelector('.user-menu .menu')).toBeNull();
});

// On a phone the narrow rule takes the sidebar away, so the nav is unreachable without this.
test('the menu button opens the sidebar, and a link inside it closes it again', () => {
  drafts();
  const root = show(session());
  const button = root.querySelector<HTMLButtonElement>('.menu-button');
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  expect(root.querySelector('.sidebar.is-open')).toBeNull();

  button?.click();
  flushSync();
  expect(root.querySelector('.sidebar.is-open')).not.toBeNull();

  root.querySelector<HTMLAnchorElement>('.sidebar a[href="/admin/media"]')?.click();
  flushSync();
  expect(root.querySelector('.sidebar.is-open')).toBeNull();
});

// Beside the count, the two facts that decide whether to publish now: how long the oldest change
// has been waiting, and how many are being held back.
test('the indicator names the oldest change and how many are held', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/ping')
        return Response.json({ ok: true, collections: ['listings', 'pages'] });
      if (url === '/admin/api/build') return Response.json({});
      if (url === '/admin/api/dashboard')
        return Response.json({ recent: [], published: null, translations: null });
      return Response.json({
        entries: [
          pendingEntry('listings/mill-house'),
          { ...pendingEntry('pages/home'), held_by: { id: 'u2', name: 'Anna' } },
        ],
      });
    }),
  );
  const root = show(session());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();

  const detail = root.querySelector('.indicator .detail')?.textContent?.replace(/\s+/g, ' ').trim();
  expect(detail).toBe('· oldest 22 aug 2025 · 1 on hold');
});

// Regression: sign-out was posted with no content type, which Better Auth refuses with 415 —
// the form came back while the cookie stayed valid.
test('signing out posts a request Better Auth accepts, and shows the login form', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ success: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show(session('owner'));

  root.querySelector<HTMLButtonElement>('.user-menu > button')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.user-menu .menu button')?.click();
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
  expect(indicator?.firstElementChild?.nextSibling?.textContent?.trim()).toBe(
    '1 unpublished change',
  );
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

// Site settings is its own group above the collections, and only where the site declares any:
// with none there is nothing to list, and Manage's Settings is the developer's read-only config.
test('the sidebar offers Site settings above the collections', async () => {
  drafts();
  const root = show(session('owner'));
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const link = root.querySelector<HTMLAnchorElement>('[aria-labelledby="nav-site"] a');
  expect([link?.textContent, link?.getAttribute('href')]).toEqual(['Site settings', '/admin/site']);
});

// Every site has redirects, and they are listed on that screen, so it is offered even where
// the developer declared no globals at all.
test('Site settings is offered on a site that declares no globals', async () => {
  drafts();
  const root = show(session(), '/admin/site/redirects');
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  expect(root.querySelector('[aria-labelledby="nav-site"] a')?.getAttribute('aria-current')).toBe(
    'page',
  );
});

// A global is edited on the entry screen: /admin/site/site is entries/globals/site, which is
// the whole of what "the same form path" means.
test('a global path opens the entry editor on the globals collection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/entries/globals/site')
        return Response.json({
          fields: [{ path: ['footerText'], label: 'Footer text', type: 'text', required: true }],
          blocks: {},
          data: { footerText: 'Coastal homes since 2009' },
          pending: [],
          problems: [],
          locales: ['en'],
          defaultLocale: 'en',
          sourceLocale: 'en',
          offered: ['en'],
          translations: {},
          stale: [],
          drift: [],
          singleton: true,
          label: 'Site details',
        });
      if (url === '/admin/api/build') return Response.json({});
      return Response.json({ entries: [] });
    }),
  );
  const root = show(session('owner'), '/admin/site/site');
  await new Promise((r) => setTimeout(r, 0));
  flushSync();

  expect(root.querySelector('.entry-header h1')?.textContent).toBe('Site details');
  expect(root.querySelector<HTMLInputElement>('input#f-footerText')?.value).toBe(
    'Coastal homes since 2009',
  );
});

// The count in the top bar and the entry's own Publish button describe the same fact, so a save
// that lights one has to move the other: without this the shell says "No unpublished changes"
// beside a lit Publish until something else reloads it.
test('a save that makes an entry pending moves the count in the top bar', async () => {
  vi.useFakeTimers();
  let waiting: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/entries/listings/mill-house')
        return Response.json({
          fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
          blocks: {},
          data: { title: 'The Mill House' },
          pending: [],
          problems: [],
          locales: ['en'],
          defaultLocale: 'en',
          sourceLocale: 'en',
          offered: ['en'],
          translations: {},
          stale: [],
          drift: [],
        });
      if (url === '/admin/api/build') return Response.json({});
      if (url.startsWith('/admin/api/locks/'))
        return Response.json({ held_by: null, mine: true, expires_at: 1755864120000, base: {} });
      if (url.startsWith('/admin/api/drafts/') && init?.method === 'PUT') {
        waiting = ['listings/mill-house'];
        return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
      }
      return Response.json({ entries: waiting.map(pendingEntry) });
    }),
  );
  const root = show(session(), '/admin/c/listings/mill-house');
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(root.querySelector('.indicator')?.textContent?.trim()).toBe('No unpublished changes');

  const input = root.querySelector<HTMLInputElement>('input#f-title');
  if (!input) throw new Error('no title field');
  input.value = 'The Mill House, renamed';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect(root.querySelector('.indicator .detail')).not.toBeNull();
  expect(root.querySelector('.indicator')?.textContent).toContain('1 unpublished change');
  vi.useRealTimers();
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

// The shell is a single page: a sidebar click swaps the screen in place rather than fetching
// the document again, and the address bar follows so a reload or a shared link still lands.
test('a sidebar click swaps the screen without a page load', () => {
  drafts();
  history.replaceState({}, '', '/admin');
  const root = show(session('owner'));
  const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('nav a')).find(
    (a) => a.textContent === 'Settings',
  );
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link?.dispatchEvent(event);
  flushSync();
  expect(event.defaultPrevented).toBe(true);
  expect(location.pathname).toBe('/admin/settings');
  expect(root.querySelector('main.main h1')?.textContent).toBe('Settings');
  expect(link?.getAttribute('aria-current')).toBe('page');
});

test('a modifier-click on a sidebar link is left to the browser', () => {
  drafts();
  history.replaceState({}, '', '/admin');
  const root = show(session('owner'));
  const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('nav a')).find(
    (a) => a.textContent === 'Settings',
  );
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  link?.dispatchEvent(event);
  flushSync();
  expect(event.defaultPrevented).toBe(false);
  expect(location.pathname).toBe('/admin');
});

test('back and forward move the screen with the address', () => {
  drafts();
  history.replaceState({}, '', '/admin/settings');
  const root = show(session('owner'), '/admin/settings');
  history.replaceState({}, '', '/admin/activity');
  window.dispatchEvent(new PopStateEvent('popstate'));
  flushSync();
  expect(root.querySelector('main.main h1')?.textContent).toBe('Activity');
});

// The SEO tab is the third address of the same entry, and reached the same way.
test('the seo tab is an address of the same entry', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
    if (url === '/admin/api/drafts') return Response.json({ entries: [] });
    if (url === '/admin/api/build') return Response.json({});
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000, base: {} });
    return Response.json({
      fields: [{ path: ['seo'], label: 'SEO', type: 'seo', required: false }],
      blocks: {},
      data: { title: 'The Mill House' },
      seoDefaults: { en: { titlePattern: '%s · Handover demo' } },
      pending: [],
      published: ['en'],
      problems: [],
      locales: ['en'],
      defaultLocale: 'en',
      sourceLocale: 'en',
      offered: ['en'],
      translations: {},
      stale: [],
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

  const root = show(session(), '/admin/c/listings/mill-house');
  await settle();
  root.querySelector<HTMLAnchorElement>('.tabs a[href$="/seo"]')?.click();
  await settle();

  expect(location.pathname).toBe('/admin/c/listings/mill-house/seo');
  expect(root.querySelector('input#f-seo\\.title')).not.toBeNull();
});

// An entry's tabs are addresses of the same entry: moving between them must not re-read the
// entry, or everything the person has typed and every switch they have set goes with it.
test('the history tab is an address of the same entry, not a second load of it', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
    if (url === '/admin/api/drafts') return Response.json({ entries: [] });
    if (url === '/admin/api/build') return Response.json({});
    if (url.startsWith('/admin/api/history/')) return Response.json({ versions: [], more: false });
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000, base: {} });
    return Response.json({
      fields: [],
      blocks: {},
      data: { title: 'The Mill House' },
      pending: [],
      published: ['en'],
      problems: [],
      locales: ['en'],
      defaultLocale: 'en',
      sourceLocale: 'en',
      offered: ['en'],
      translations: {},
      stale: [],
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
  expect(root.querySelector('.form')).not.toBeNull();

  root.querySelector<HTMLAnchorElement>('.tabs a[href$="/history"]')?.click();
  await settle();

  expect(location.pathname).toBe('/admin/c/listings/mill-house/history');
  expect(root.querySelector('.history')).not.toBeNull();
  expect(root.querySelector('.form')).toBeNull();
  expect(loads()).toBe(1);
});

// App-shell state 9: the drawer's own result panel goes when the drawer closes, so the commit is
// also said once in a notice that outlives it, with an explicit close.
const publishing = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
      if (url === '/admin/api/build') return Response.json(buildBody);
      if (url === '/admin/api/publish')
        return Response.json({ commit_sha: 'c0ffee11', paths: ['src/content/listings/en/a.yaml'] });
      if (url === '/admin/api/revert') return Response.json({ commit_sha: 'rev999', paths: [] });
      return Response.json({ entries: [pendingEntry('listings/a')] });
    }),
  );
const toasts = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.toasts .toast .body'), (el) => el.textContent?.trim());

test('a publish from the drawer is said in a notice that outlives the drawer', async () => {
  publishing();
  const root = show(session());
  await settle();
  expect(root.querySelector('.toasts')).not.toBeNull();
  expect(toasts(root)).toEqual([]);

  root.querySelector<HTMLButtonElement>('.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();
  expect(toasts(root)).toEqual(['Published 1 change — building']);

  root.querySelector<HTMLButtonElement>('.drawer [aria-label="Close"]')?.click();
  flushSync();
  expect(root.querySelector('.drawer')).toBeNull();
  expect(toasts(root)).toEqual(['Published 1 change — building']);

  root.querySelector<HTMLButtonElement>('.toast .close')?.click();
  flushSync();
  expect(toasts(root)).toEqual([]);
});

test('a revert is said in a notice', async () => {
  buildBody = { commit_sha: 'c0ffee11', state: 'failed' };
  publishing();
  const root = show(session());
  await settle();
  root.querySelector<HTMLButtonElement>('.topbar .pill .btn-link')?.click();
  flushSync();
  document.querySelector<HTMLButtonElement>('[aria-labelledby="revert-h"] .btn-danger')?.click();
  await settle();

  expect(toasts(root)).toEqual(['Reverted that publish — building']);
});

test('a notice leaves on its own after a few seconds', async () => {
  vi.useFakeTimers();
  publishing();
  const root = show(session());
  await vi.advanceTimersByTimeAsync(0);
  root.querySelector<HTMLButtonElement>('.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(toasts(root)).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(7_000);
  expect(toasts(root)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_500);
  flushSync();
  expect(toasts(root)).toEqual([]);
  vi.useRealTimers();
});
