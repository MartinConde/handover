import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App.svelte';

let app: ReturnType<typeof mount>;
const session = (role: 'owner' | 'editor' = 'owner') => ({
  collections: ['listings', 'pages'],
  user: { id: 'u1', name: 'Martin', email: 'martin@example.com' },
  role,
});
const show = (signedIn: ReturnType<typeof session> | null | undefined, path = '/admin') => {
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

// The shell serves the same HTML for every /admin path, so the branch is the only gate.
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

// The activity log has no role condition: which events an editor sees is the server's decision.
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

// The role is never a control here: it is changed on the members screen.
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

// The oldest change and the held count are what decide whether to publish now.
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

// Regression: sign-out posted with no content type, which Better Auth refuses with 415.
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

test('an unavailable session check is not presented as signed out and can be retried', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/ping') return Response.json(session());
    if (url === '/admin/api/build') return Response.json({});
    if (url === '/admin/api/dashboard')
      return Response.json({ recent: [], published: null, translations: null });
    if (url === '/admin/api/activity') return Response.json({ events: [] });
    return Response.json({ entries: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show(undefined);

  expect(root.querySelector('input#password')).toBeNull();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not check whether you are signed in',
  );
  root.querySelector<HTMLButtonElement>('.session-unavailable button')?.click();
  await vi.waitFor(() => {
    flushSync();
    expect(root.querySelector('.sidebar')).not.toBeNull();
  });
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/ping');
});

test('a failed pending read is unknown rather than fully published and retry recovers', async () => {
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/drafts') {
        attempts += 1;
        return attempts === 1
          ? new Response('Repository unavailable', { status: 503 })
          : Response.json({ entries: [pendingEntry('pages/home')] });
      }
      if (url === '/admin/api/build') return Response.json({});
      if (url === '/admin/api/dashboard')
        return Response.json({ recent: [], published: null, translations: null });
      if (url === '/admin/api/activity') return Response.json({ events: [] });
      return Response.json({});
    }),
  );
  const root = show(session());
  await vi.waitFor(() => {
    flushSync();
    expect(root.querySelector('.pending-read-error')).not.toBeNull();
  });

  expect(root.querySelector('.indicator')?.textContent).toContain(
    'Unpublished changes unavailable',
  );
  expect(root.textContent).not.toContain('Everything is published');
  root.querySelector<HTMLButtonElement>('.pending-read-error button')?.click();
  await vi.waitFor(() => {
    flushSync();
    expect(root.querySelector('.indicator')?.textContent).toContain('1 unpublished change');
  });
  expect(root.querySelector('.pending-read-error')).toBeNull();
});

test.each(['network', 'server'])(
  'a %s sign-out failure keeps the session visible for retry',
  async (failure) => {
    drafts();
    const previous = globalThis.fetch;
    let refused = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== '/admin/api/auth/sign-out') return previous(url, init);
        if (!refused) return Response.json({ success: true });
        if (failure === 'network') throw new TypeError('Failed to fetch');
        return new Response('Unavailable', { status: 503 });
      }),
    );
    const root = show(session());
    root.querySelector<HTMLButtonElement>('.user-menu > button')?.click();
    flushSync();
    root.querySelector<HTMLButtonElement>('.user-menu .menu button')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(root.textContent).toContain('Could not sign out. Please try again.');
    });
    expect(root.querySelector('.sidebar')).not.toBeNull();
    expect(root.querySelector('input#password')).toBeNull();
    refused = false;
    root.querySelector<HTMLButtonElement>('.user-menu .menu button')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(root.querySelector('input#password')).not.toBeNull();
    });
  },
);

test('the indicator counts the pending entries and opens the drawer', async () => {
  drafts('listings/mill-house');
  const root = show(session());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const indicator = root.querySelector<HTMLButtonElement>('button.indicator');
  expect(indicator?.textContent).toContain('1 unpublished change');
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

// Manage's Settings is the developer's read-only config, so Site settings is its own group.
test('the sidebar offers Site settings above the collections', async () => {
  drafts();
  const root = show(session('owner'));
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const link = root.querySelector<HTMLAnchorElement>('[aria-labelledby="nav-site"] a');
  expect([link?.textContent, link?.getAttribute('href')]).toEqual(['Site settings', '/admin/site']);
});

// Every site has redirects, listed on that screen, so it is offered with no globals declared.
test('Site settings is offered on a site that declares no globals', async () => {
  drafts();
  const root = show(session(), '/admin/site/redirects');
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  expect(root.querySelector('[aria-labelledby="nav-site"] a')?.getAttribute('aria-current')).toBe(
    'page',
  );
});

// /admin/site/site is entries/globals/site, edited on the entry screen.
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
  await vi.dynamicImportSettled();
  flushSync();

  expect(root.querySelector('.entry-header h1')?.textContent).toBe('Site details');
  expect(root.querySelector<HTMLInputElement>('input#f-footerText')?.value).toBe(
    'Coastal homes since 2009',
  );
});

// The top-bar count and the Publish button describe the same fact, so a save must move both.
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
        return Response.json({ held_by: null, mine: true, expires_at: 1755864120000 });
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

// Once the draft is gone the editor must drop its values, or the next keystroke saves them back.
test('discarding a draft loads the entry again instead of leaving the old one on screen', async () => {
  const PATH = 'src/content/listings/en/mill-house.yaml';
  let entryLoads = 0;
  let discarded = false;
  const mutationOrder: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
    if (url === '/admin/api/drafts')
      return Response.json({ entries: discarded ? [] : [pendingEntry('listings/mill-house')] });
    if (url === '/admin/api/publish/checks') return Response.json({ results: [] });
    if (url === '/admin/api/publish') {
      mutationOrder.push('publish');
      return Response.json({ error: 'refused', paths: [PATH] }, { status: 409 });
    }
    if (url === '/admin/api/drafts/listings/mill-house' && init?.method === 'PUT') {
      mutationOrder.push(`save:${JSON.parse(String(init.body)).data.title}`);
      return Response.json({ pending: true, problems: [], revisions: { en: 'saved-latest' } });
    }
    if (init?.method === 'DELETE') {
      mutationOrder.push('discard');
      discarded = true;
      return Response.json({});
    }
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120000 });
    if (url === '/admin/api/entries/listings/mill-house') {
      entryLoads += 1;
      return Response.json({
        fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
        blocks: {},
        data: { title: entryLoads === 1 ? 'Draft title' : 'Repository title' },
        revisions: { en: entryLoads === 1 ? 'opened' : 'reloaded' },
        pending: discarded ? [] : ['en'],
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
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    }
  };
  const root = show(session(), '/admin/c/listings/mill-house');
  await vi.dynamicImportSettled();
  await settle();
  expect(entryLoads).toBe(1);
  const input = root.querySelector<HTMLInputElement>('#f-title');
  if (!input) throw new Error(`Editor did not open: ${root.textContent}`);
  input.value = 'Final local title';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  root.querySelector<HTMLButtonElement>('button.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();
  root.querySelector<HTMLButtonElement>('.change-row.is-blocked .change-actions .btn')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.dialog .btn-danger')?.click();
  await settle();

  expect(mutationOrder).toEqual(['save:Final local title', 'publish', 'discard']);
  expect(entryLoads).toBe(2);
  expect(root.querySelector<HTMLInputElement>('#f-title')?.value).toBe('Repository title');
});

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

// The live region holds the state in words, not the counter that ticks beside it.
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

// The live pill says when the site last changed, not only that it is up.
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

test('a successful commit refreshes a live build and polls only until it settles', async () => {
  vi.useFakeTimers();
  let committed = false;
  let buildReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/build') {
        buildReads += 1;
        if (!committed)
          return Response.json({ commit_sha: 'before123', state: 'live', live_at: Date.now() });
        return buildReads === 2
          ? Response.json({ commit_sha: 'after456', state: 'building', committed_at: Date.now() })
          : Response.json({ commit_sha: 'after456', state: 'live', live_at: Date.now() });
      }
      if (url === '/admin/api/redirects' && init?.method === 'POST') {
        committed = true;
        return Response.json({});
      }
      if (url === '/admin/api/entries')
        return Response.json({ entries: [], locales: ['en'], defaultLocale: 'en' });
      if (url === '/admin/api/redirects') return Response.json({ rules: [] });
      if (url === '/admin/api/drafts') return Response.json({ entries: [] });
      return Response.json({});
    }),
  );
  const root = show(session(), '/admin/site/redirects');
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(root.querySelector('.topbar .pill')?.className).toContain('pill-live');

  root.querySelector<HTMLButtonElement>('.list-toolbar .btn-primary')?.click();
  flushSync();
  const from = root.querySelector<HTMLInputElement>('#rd-from');
  if (!from) throw new Error('redirect dialog did not open');
  from.value = '/old-address';
  from.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector<HTMLInputElement>('input[name="rd-kind"][value="url"]')?.click();
  flushSync();
  const to = root.querySelector<HTMLInputElement>('#rd-url');
  if (!to) throw new Error('redirect URL field did not open');
  to.value = 'https://example.com/new-address';
  to.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector<HTMLFormElement>('.dialog form')?.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(root.querySelector('.topbar .pill')?.className).toContain('pill-building');
  expect(buildReads).toBe(2);

  await vi.advanceTimersByTimeAsync(10_000);
  flushSync();
  expect(root.querySelector('.topbar .pill')?.className).toContain('pill-live');
  expect(buildReads).toBe(3);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(buildReads).toBe(3);
  vi.useRealTimers();
});

// With nothing published the pill is the worker's own deploy, with no commit to take back.
test('a failed build with no commit of ours offers no revert', async () => {
  buildBody = { state: 'failed' };
  drafts();
  const root = show(session());
  await settle();

  const pill = root.querySelector('.topbar .pill');
  expect(pill?.textContent).toContain('Build failed');
  expect(pill?.querySelector('.btn-link')).toBeNull();
});

// After a revert the panel describes a commit that no longer stands, so it goes with the publish.
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

// A sidebar click swaps the screen in place and the address bar follows, so a reload still lands.
test('a sidebar click swaps the screen without a page load', async () => {
  drafts();
  history.replaceState({}, '', '/admin');
  const root = show(session('owner'));
  const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('nav a')).find(
    (a) => a.textContent === 'Settings',
  );
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link?.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
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

test('back and forward move the screen with the address', async () => {
  drafts();
  history.replaceState({}, '', '/admin/settings');
  const root = show(session('owner'), '/admin/settings');
  history.replaceState({}, '', '/admin/activity');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000 });
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

// Moving between tabs must not re-read the entry, or everything typed goes with it.
test('the history tab is an address of the same entry, not a second load of it', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/ping') return Response.json({ ok: true, collections: ['listings'] });
    if (url === '/admin/api/drafts') return Response.json({ entries: [] });
    if (url === '/admin/api/build') return Response.json({});
    if (url.startsWith('/admin/api/history/')) return Response.json({ versions: [], more: false });
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000 });
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

const historyEntry = (title: string, drift: unknown[] = []) => ({
  fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
  blocks: {},
  data: { title },
  revisions: { en: `${title}-en`, de: `${title}-de` },
  pending: ['en'],
  published: ['en', 'de'],
  problems: [],
  locales: ['en', 'de'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en', 'de'],
  translations: { de: { title: `${title} DE` } },
  stale: [],
  drift,
});
const clickRequired = (root: ParentNode, selector: string) => {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`${selector} missing`);
  button.click();
};

test('a historical restore reloads every locale and exposes drift from the restored version', async () => {
  let entryLoads = 0;
  const restore = vi.fn(async () => Response.json({ paths: ['content/en/mill-house.yaml'] }));
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/drafts') return Response.json({ entries: [] });
    if (url === '/admin/api/build') return Response.json({});
    if (url === '/admin/api/entries/listings/mill-house') {
      entryLoads += 1;
      return Response.json(
        entryLoads === 1
          ? historyEntry('Before restore')
          : historyEntry('Restored', [
              {
                path: 'body[_id=restored]',
                in: ['en'],
                expected: ['en', 'de'],
                values: { en: ['Restored block'] },
              },
            ]),
      );
    }
    if (url === '/admin/api/history/listings/mill-house?page=1')
      return Response.json({
        versions: [
          {
            sha: 'abc1234',
            date: '2026-08-20T12:00:00.000Z',
            summary: 'Earlier words',
            locales: ['en'],
          },
        ],
        more: false,
      });
    if (url.startsWith('/admin/api/history/listings/mill-house/diff?'))
      return Response.json({ groups: [] });
    if (url === '/admin/api/history/listings/mill-house/restore') return restore();
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000 });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const settleRestore = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
  };

  const root = show(session(), '/admin/c/listings/mill-house/history');
  await settleRestore();
  clickRequired(root, '.version-row .summary');
  await settleRestore();
  clickRequired(root, '.version-head .btn-primary');
  flushSync();
  clickRequired(root, '.dialog .btn-primary');
  await settleRestore();

  expect(restore).toHaveBeenCalledOnce();
  expect(entryLoads).toBe(2);
  expect(location.pathname).toBe('/admin/c/listings/mill-house');
  expect(root.querySelector('.drift')).not.toBeNull();
  expect(root.textContent).toContain("languages disagree about this entry's blocks");
});

test('an uncertain historical restore authoritatively reloads before editing resumes', async () => {
  let entryLoads = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/admin/api/drafts') return Response.json({ entries: [] });
    if (url === '/admin/api/build') return Response.json({});
    if (url === '/admin/api/entries/listings/mill-house') {
      entryLoads += 1;
      return Response.json(
        historyEntry(entryLoads === 1 ? 'Possibly stale' : 'Authoritative after retry'),
      );
    }
    if (url === '/admin/api/history/listings/mill-house?page=1')
      return Response.json({
        versions: [
          {
            sha: 'abc1234',
            date: '2026-08-20T12:00:00.000Z',
            summary: 'Earlier words',
            locales: ['en'],
          },
        ],
        more: false,
      });
    if (url.startsWith('/admin/api/history/listings/mill-house/diff?'))
      return Response.json({ groups: [] });
    if (url === '/admin/api/history/listings/mill-house/restore')
      throw new TypeError('connection ended without a response');
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: 1755864120000 });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const settleRestore = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
  };

  const root = show(session(), '/admin/c/listings/mill-house/history');
  await settleRestore();
  clickRequired(root, '.version-row .summary');
  await settleRestore();
  clickRequired(root, '.version-head .btn-primary');
  flushSync();
  clickRequired(root, '.dialog .btn-primary');
  await settleRestore();

  expect(entryLoads).toBe(2);
  expect(location.pathname).toBe('/admin/c/listings/mill-house');
  expect(root.querySelector<HTMLInputElement>('#f-title')?.value).toBe('Authoritative after retry');
  expect(root.textContent).not.toContain('Restored the version from');
});

// The drawer's result panel goes with the drawer, so the commit is also said in a lasting notice.
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

test('publishing one entry refreshes the shell from Live to the returned build state', async () => {
  let published = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/build')
      return Response.json(
        published
          ? { commit_sha: 'entry456', state: 'building', committed_at: Date.now() }
          : { commit_sha: 'before123', state: 'live', live_at: Date.now() },
      );
    if (url === '/admin/api/drafts')
      return Response.json({ entries: published ? [] : [pendingEntry('listings/mill-house')] });
    if (url === '/admin/api/entries/listings/mill-house')
      return Response.json({
        fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
        blocks: {},
        data: { title: 'The Mill House' },
        revisions: { en: 'opened' },
        pending: published ? [] : ['en'],
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
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120000 });
    if (url === '/admin/api/publish/checks') return Response.json({ results: [] });
    if (url === '/admin/api/publish' && init?.method === 'POST') {
      published = true;
      return Response.json({
        commit_sha: 'entry456',
        paths: ['src/content/listings/en/mill-house.yaml'],
      });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show(session(), '/admin/c/listings/mill-house');
  await vi.dynamicImportSettled();
  await settle();
  expect(root.querySelector('.topbar .pill')?.className).toContain('pill-live');

  Array.from(root.querySelectorAll<HTMLButtonElement>('.entry-header button'))
    .find((button) => button.textContent?.trim() === 'Publish this entry')
    ?.click();
  await settle();
  root.querySelector<HTMLButtonElement>('.dialog .btn-primary')?.click();
  await settle();

  expect(root.querySelector('.topbar .pill')?.className).toContain('pill-building');
  expect(root.querySelector('.indicator')?.textContent).toContain('No unpublished changes');
});

test('drawer publish waits for the mounted entry to save and publishes its latest revision', async () => {
  const start = '/admin/c/listings/mill-house';
  history.replaceState({}, '', start);
  let refuseSave = true;
  let savedTitle = 'Saved draft';
  let published = false;
  const publish = vi.fn(async () => {
    published = true;
    return Response.json({
      commit_sha: 'latest123',
      paths: ['src/content/listings/en/mill-house.yaml'],
    });
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/entries/listings/mill-house')
      return Response.json({
        fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
        blocks: {},
        data: { title: savedTitle },
        revisions: { en: 'opened' },
        pending: published ? [] : ['en'],
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
    if (url.startsWith('/admin/api/locks/'))
      return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120000 });
    if (url === '/admin/api/drafts' && !init?.method)
      return Response.json({
        entries: published ? [] : [pendingEntry('listings/mill-house')],
      });
    if (url === '/admin/api/drafts/listings/mill-house' && init?.method === 'PUT') {
      savedTitle = JSON.parse(String(init.body)).data.title;
      return refuseSave
        ? new Response('offline', { status: 500 })
        : Response.json({ pending: true, problems: [], revisions: { en: 'latest' } });
    }
    if (url === '/admin/api/publish/checks') return Response.json({ results: [] });
    if (url === '/admin/api/publish') return publish();
    if (url === '/admin/api/build') return Response.json({});
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show(session(), start);
  await settle();
  const input = root.querySelector<HTMLInputElement>('#f-title');
  if (!input) throw new Error('Editor did not open');
  input.value = 'Latest words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  root.querySelector<HTMLButtonElement>('.indicator')?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();

  expect(publish).not.toHaveBeenCalled();
  expect(root.querySelector('.drawer [role="alert"]')?.textContent).toContain(
    'latest changes could not be saved',
  );
  expect(input.value).toBe('Latest words');

  refuseSave = false;
  root.querySelector<HTMLButtonElement>('.drawer-foot .btn-primary')?.click();
  await settle();

  expect(savedTitle).toBe('Latest words');
  expect(publish).toHaveBeenCalledOnce();
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

test.each(['link', 'back'])(
  'leaving during the debounce by %s waits for save and keeps the form on failure',
  async (mode) => {
    const start = '/admin/c/listings/mill-house';
    history.replaceState({}, '', start);
    let saving: ((res: Response) => void) | undefined;
    let stored = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/admin/api/entries/listings/mill-house')
          return Response.json({
            fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
            blocks: {},
            data: { title: 'Home' },
            revisions: { en: 'opened' },
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
        if (url.startsWith('/admin/api/locks/'))
          return Response.json({ held_by: null, mine: true, expires_at: Date.now() + 120000 });
        if (init?.method === 'PUT') {
          stored = JSON.parse(String(init.body)).data.title;
          return new Promise<Response>((r) => {
            saving = r;
          });
        }
        if (url === '/admin/api/build') return Response.json({});
        return Response.json({ entries: [] });
      }),
    );
    const root = show(session(), start);
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    const input = root.querySelector<HTMLInputElement>('#f-title');
    if (!input) throw new Error('Editor did not open');
    input.value = 'Final keystroke';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const leave = () => {
      if (mode === 'back') {
        history.replaceState({}, '', '/admin/settings');
        dispatchEvent(new PopStateEvent('popstate'));
      } else
        root
          .querySelector<HTMLAnchorElement>('a[href="/admin/settings"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    leave();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('#f-title')).toBe(input);
    expect(stored).toBe('Final keystroke');
    saving?.(new Response('offline', { status: 500 }));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(root.querySelector('#f-title')).toBe(input);
    expect(location.pathname).toBe(start);
    expect(input.value).toBe('Final keystroke');
    leave();
    await new Promise((r) => setTimeout(r, 0));
    saving?.(Response.json({ pending: true, problems: [], revisions: { en: 'next' } }));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(root.querySelector('#f-title')).toBeNull();
    expect(location.pathname).toBe('/admin/settings');
  },
);
