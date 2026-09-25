import { LOCK_TTL } from '@handover/core';
import { flushSync, mount } from 'svelte';
import { expect, test, vi } from 'vitest';
import { deferred } from '../test-helpers.fixture.js';
import Editor from './Editor.svelte';
import {
  $,
  $$,
  addressed,
  autosaved,
  bilingual,
  entry,
  HELD,
  heldBy,
  isLint,
  isLock,
  show,
  state,
  tick,
  type,
  useEditorSetup,
  wrote,
} from './editor.fixture.js';

useEditorSetup();

// Detection only: field-by-field resolution is the three-way view, not built yet.
test('a file somebody changed in the repository badges the header and names the drawer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : url === '/admin/api/publish'
          ? Response.json({ error: 'moved', paths: ['src/content/x.yaml'] }, { status: 409 })
          : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '.dialog')).toBeNull();
  expect($(root, '.entry-header .badge-danger')?.textContent).toBe(
    'Changed in the repository since you opened it',
  );
  expect($(root, '.entry-header .subline')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Somebody changed this in the repository after you opened it. Open Unpublished changes to resolve it field by field, or to discard yours and take what is there now.',
  );
});

// A field renamed in schemas.ts before its migration would otherwise lose its value on first save.
test('a key no descriptor mentions is written back, not dropped', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...entry, data: { ...entry.data, subtitle: 'By the harbour' } },
  });
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: {
          title: 'Seaview House',
          seo: { description: 'Harbour view' },
          photos: [],
          subtitle: 'By the harbour',
        },
        tab: 'tab-1',
      }),
    });
  });
});

test('an edit that could not be stored does not open the drawer', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/drafts/listings/seaview-cottage')
      return new Response('nope', { status: 500 });
    throw new Error(`Unexpected editor request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  expect($(root, '.dialog')).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url === '/admin/api/publish')).toBe(false);
  expect($(root, '.autosave')?.textContent).toBe('Not saved');
});

test('editing the title input updates the title in the header', () => {
  const root = show();
  const input = $<HTMLInputElement>(root, 'input#f-title');
  if (!input) throw new Error('title input missing');
  input.value = 'Seaview House';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect($(root, 'h1')?.textContent).toBe('Seaview House');
});

test('an edit is sent as a draft two seconds after the last keystroke', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { title: 'Seaview House', seo: { description: 'Harbour view' }, photos: [] },
      tab: 'tab-1',
    }),
  });
  expect($(root, '.autosave')?.textContent).toBe('Saved');
});

// The drawer counts entries, not keystrokes, so the shell hears only when pending flips.
test('the first save that makes an entry pending tells the shell; the next does not', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', autosaved());
  const pending = vi.fn();
  const root = show({ onpending: pending });

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  expect(pending).toHaveBeenCalledTimes(1);

  type(root, 'input#f-title', 'Seaview Cottage House');
  await vi.advanceTimersByTimeAsync(2000);
  expect(pending).toHaveBeenCalledTimes(1);
});

test('a save of an entry that was already pending tells the shell nothing', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', autosaved());
  const pending = vi.fn();
  const root = show({ entry: { ...entry, pending: ['en'] }, onpending: pending });

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);

  expect(pending).not.toHaveBeenCalled();
});

test('opening an entry and changing nothing writes no draft', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  show();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(wrote(fetchMock)).toEqual([]);
});

// The restore is over before the form draws, so the banner is the only trace of it.
test('a restored version is announced until it is published', () => {
  const root = show({
    restored: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    entry: { ...entry, pending: ['en'] },
  });

  expect($(root, '.lock-banner')?.textContent).toContain('Restored the version from 3 days ago.');
  expect($(root, '.lock-banner')?.textContent).toContain('nothing is live until you publish');
});

test('a restored version already published is not announced', () => {
  const root = show({ restored: new Date().toISOString() });

  expect($(root, '.lock-banner')).toBeNull();
});

test('an entry somebody else is editing reads, and says who has it', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('Being edited by Anna Berg');
  expect($(root, '.lock-banner .when')?.textContent).toContain('active a few seconds ago');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
});

// The lock belongs to the tab, so the same person's second tab is refused too.
test('the same person in a second tab is told it is open in another tab', async () => {
  vi.stubGlobal('fetch', heldBy({ held_by: { id: 'u2', name: 'Anna' } }));
  const root = show({ userId: 'u2' });
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('You have this open in another tab');
  expect($(root, '.lock-banner')?.textContent).not.toContain('Being edited by');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
});

// What tells the tabs apart: a token this tab made up, on every beat and on every save.
test('the beat and the save carry the same tab token', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);

  const sent = (call: unknown[]) =>
    (JSON.parse((call[1] as { body: string }).body) as { tab?: string }).tab;
  const beat = fetchMock.mock.calls.find((call) => isLock(call[0]));
  const save = wrote(fetchMock)[0];
  expect(sent(beat ?? [])).toMatch(/\S/);
  expect(sent(save ?? [])).toBe(sent(beat ?? []));
});

// A holder who stopped typing is a minute from losing the lock; one mid-sentence is not.
test('the banner says how long ago the holder last typed', async () => {
  vi.stubGlobal('fetch', heldBy({ expires_at: Date.now() + LOCK_TTL - 70_000 }));
  const root = show();
  await tick();
  flushSync();

  expect($(root, '.lock-banner .when')?.textContent).toContain('nothing typed for a minute');
});

test('a lock that has run out leaves the screen reading, with a way back in', async () => {
  vi.stubGlobal('fetch', heldBy({ held_by: null, expires_at: null }));
  const changed = vi.fn();
  const root = show({ onchanged: changed });
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('Nobody is editing this entry any more');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  expect(changed).toHaveBeenCalled();
});

test('the entry this screen opened is taken as it opens', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  show();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/locks/listings/seaview-cottage',
    expect.objectContaining({ method: 'POST', body: expect.stringContaining('"tab":') }),
  );
});

test('a draft that is ahead of the published file can be published on load', () => {
  state.app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: ['en'] },
      onchanged: () => {},
    },
  });
  expect($<HTMLButtonElement>(document.body, 'button.btn-primary')?.disabled).toBe(false);
});

test('a draft write that fails says so instead of claiming it is saved', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 500 })),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($(root, '.autosave')?.textContent).toBe('Not saved');
});

test('a draft that matches the published file again leaves nothing to publish', async () => {
  vi.useFakeTimers();
  // The server owns the answer: it compares the stored bytes against the file in git.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) =>
      isLock(url)
        ? Response.json(HELD)
        : Response.json({
            updated_at: 1755864000000,
            pending: !init.body.includes('"title":"Seaview Cottage"'),
            problems: [],
          }),
    ),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);

  type(root, 'input#f-title', 'Seaview Cottage');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
});

const withProblems = (problems: { path: string; message: string }[]) => {
  state.app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: ['en'], problems },
      onchanged: () => {},
    },
  });
  return document.body;
};

// Regression: a required field with no widget yet used to say only "Not saved".
test('what the schema is still missing is counted in the header and marked on the field', () => {
  const root = withProblems([{ path: 'title', message: 'Required' }]);
  expect($(root, '.problems')?.textContent).toBe('1 problem');
  expect($(root, 'input#f-title')?.getAttribute('aria-invalid')).toBe('true');
  expect($(root, '#f-title-err')?.textContent).toBe('Required');
});

test('two problems are counted as two, and Publish is held back until they are gone', () => {
  const root = withProblems([
    { path: 'title', message: 'Required' },
    { path: 'seo.description', message: 'Required' },
  ]);
  expect($(root, '.problems')?.textContent).toBe('2 problems');
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
});

test('the problem count moves focus to the first field it is counting', () => {
  const root = withProblems([{ path: 'seo.description', message: 'Required' }]);
  $<HTMLButtonElement>(root, '.problems')?.click();
  flushSync();
  expect(document.activeElement?.id).toBe('f-seo.description');
});

test('an entry with nothing missing shows no count', () => {
  const root = show();
  expect($(root, '.problems')).toBeNull();
});

test('an autosave that stores an entry the schema refuses says so instead of Not saved', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        updated_at: 1755864000000,
        pending: true,
        problems: [{ path: 'title', message: 'Required' }],
      }),
    ),
  );
  const root = show();
  type(root, 'input#f-title', '');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($(root, '.autosave')?.textContent).toBe('Saved');
  expect($(root, '.problems')?.textContent).toBe('1 problem');
});

// State 10: the form is about a structure the languages have not agreed on, so it is not drawn.
test('an entry whose languages disagree gets the panel where its form would be', () => {
  const root = show({
    entry: {
      ...entry,
      drift: [
        {
          path: 'blocks[_id=z9y8x7w6]',
          type: 'quote',
          in: ['de'],
          expected: ['en', 'de'],
          values: { de: ['Ein seltener Fund.'] },
        },
      ],
      locales: ['en', 'de'],
    },
  });

  expect($(root, '.lock-banner.is-drift')).not.toBe(null);
  expect($(root, '.drift .block-card')).not.toBe(null);
  expect($(root, 'form.form')).toBe(null);
  expect($<HTMLButtonElement>(root, 'header button.btn-primary')?.disabled).toBe(true);
});

test('applying drift answers reloads the entry instead of reopening an old locale snapshot', async () => {
  const changed = vi.fn(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/admin/api/drift/')
        ? Response.json({})
        : Response.json({ held_by: null, mine: true, expires_at: null }),
    ),
  );
  const root = show({
    onchanged: changed,
    entry: {
      ...entry,
      drift: [
        {
          path: 'blocks[_id=z9y8x7w6]',
          type: 'quote',
          in: ['de'],
          expected: ['en', 'de'],
          values: { de: ['Ein seltener Fund.'] },
        },
      ],
      locales: ['en', 'de'],
    },
  });

  $<HTMLInputElement>(root, '.drift .choice input')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.drift .actions .btn-primary')?.click();
  await tick();

  expect(changed).toHaveBeenCalledOnce();
});

// The file wins over `_locales`, and the disagreement is said above the form.
test('an entry whose _locales its files contradict says so', () => {
  const root = show({
    entry: {
      ...bilingual,
      offerProblems: ['_locales says this entry is not offered in de, and it has a file in de'],
    },
  });

  const banner = $(root, '.lock-banner.is-offer');
  expect(banner?.textContent).toContain('not offered in de');
  expect($(root, 'form.form')).not.toBe(null);
});

// The losing tab finds out from the refused save it makes next.
const refused = () =>
  vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : Response.json(
          {
            held_by: { id: 'u1', name: 'Anna Berg' },
            mine: false,
            expires_at: Date.now() + LOCK_TTL,
          },
          { status: 409 },
        ),
  );

test('a save refused by a take-over says where the work went and stops the tab', async () => {
  vi.useFakeTimers();
  const fetchMock = refused();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
});

// Somebody who opened the entry while this tab's lock had lapsed is named on the next edit.
test('a lapsed lock somebody else took is named on the next edit and nothing is saved', async () => {
  vi.useFakeTimers();
  let claimed = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!isLock(url)) return Response.json({ pending: true, problems: [] });
    if (init?.method !== 'POST')
      return Response.json({ held_by: null, mine: false, expires_at: null });
    if (claimed)
      return Response.json({
        held_by: { id: 'u1', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    claimed = true;
    return Response.json({ held_by: null, mine: true, expires_at: Date.now() + LOCK_TTL });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await vi.advanceTimersByTimeAsync(LOCK_TTL + 16_000);

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect(wrote(fetchMock)).toHaveLength(0);
});

test('lock loss before the debounce cancels the pending save', async () => {
  vi.useFakeTimers();
  let taken = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!isLock(url))
      return Response.json({ pending: true, problems: [], revisions: { en: 'next' } });
    if (init?.method === 'POST' || !taken) return Response.json(HELD);
    return Response.json({
      held_by: { id: 'u2', name: 'Anna Berg' },
      mine: false,
      expires_at: Date.now() + LOCK_TTL,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, revisions: { en: 'legacy' } } });
  await vi.advanceTimersByTimeAsync(0);
  type(root, 'input#f-title', 'Keep this locally');
  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  flushSync();

  expect(wrote(fetchMock)).toHaveLength(0);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep this locally');
});

test('lock loss stops a queued locale save from dispatching', async () => {
  vi.useFakeTimers();
  const source = deferred<Response>();
  let taken = false;
  const drafts: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) {
      if (init?.method === 'POST' || !taken) return Response.json(HELD);
      return Response.json({
        held_by: { id: 'u2', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    }
    if (isLint(url)) return Response.json({ results: [] });
    drafts.push(String(url));
    return drafts.length === 1
      ? source.promise
      : Response.json({ pending: true, problems: [], revision: 'de-next' });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...bilingual, revisions: { en: 'legacy', de: 'de-opened' } },
  });
  await vi.advanceTimersByTimeAsync(0);
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#f-title', 'Source edit');
  type(root, 'input#t-title', 'German edit');
  await vi.advanceTimersByTimeAsync(2000);
  expect(drafts).toEqual(['/admin/api/drafts/listings/seaview-cottage']);

  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  source.resolve(
    Response.json({
      pending: true,
      problems: [],
      revisions: { en: 'en-next', de: 'de-synced' },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(drafts).toEqual(['/admin/api/drafts/listings/seaview-cottage']);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
});

test('lock loss during a request acknowledges its sent version without draining a later edit', async () => {
  vi.useFakeTimers();
  const response = deferred<Response>();
  let taken = false;
  const bodies: { data: { title: string }; revision: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) {
      if (init?.method === 'POST' || !taken) return Response.json(HELD);
      return Response.json({
        held_by: { id: 'u2', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    }
    if (isLint(url)) return Response.json({ results: [] });
    bodies.push(JSON.parse(String(init?.body)));
    return response.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, revisions: { en: 'legacy' } } });
  await vi.advanceTimersByTimeAsync(0);
  type(root, 'input#f-title', 'Sent version');
  await vi.advanceTimersByTimeAsync(2000);
  type(root, 'input#f-title', 'Still local');
  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  response.resolve(Response.json({ pending: true, problems: [], revisions: { en: 'after-sent' } }));
  await vi.advanceTimersByTimeAsync(3000);
  flushSync();

  expect(bodies.map((body) => [body.data.title, body.revision])).toEqual([
    ['Sent version', 'legacy'],
  ]);
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Still local');
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
});

// The holder polls on its own and on refocus, rather than learning of a take-over only on save.
const takenMeanwhile = () =>
  vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({})
      : init?.method === 'POST'
        ? Response.json(HELD)
        : Response.json({
            held_by: { id: 'u1', name: 'Anna Berg' },
            mine: false,
            expires_at: Date.now() + LOCK_TTL,
          }),
  );

test('a holder who types nothing still learns of a take-over within the poll', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', takenMeanwhile());
  const root = show();
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  expect($(root, '.lock-banner')).toBeNull();

  await vi.advanceTimersByTimeAsync(15_000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
});

test('a tab coming back to the front asks about its lock at once', async () => {
  vi.useFakeTimers();
  const fetchMock = takenMeanwhile();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await vi.advanceTimersByTimeAsync(1000);
  const reads = () =>
    fetchMock.mock.calls.filter((call) => isLock(call[0]) && call[1]?.method !== 'POST').length;
  expect(reads()).toBe(0);

  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(reads()).toBe(1);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
});

// Stopping to read is not losing the entry: an idle lock lapses quietly and typing takes it back.
test('a lapsed idle lock stays released without a banner until the next save claims it', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({ pending: true, problems: [] })
      : init?.method === 'POST'
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + LOCK_TTL })
        : Response.json({ held_by: null, mine: false, expires_at: null }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  const claims = () =>
    fetchMock.mock.calls.filter((c) => isLock(c[0]) && c[1]?.method === 'POST').length;
  await vi.advanceTimersByTimeAsync(LOCK_TTL + 16_000);
  flushSync();

  expect(claims()).toBe(1);
  expect($(root, '.lock-banner')).toBeNull();
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(false);

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect(wrote(fetchMock)).toHaveLength(1);
  expect(claims()).toBe(2);
  expect($(root, '.lock-banner')).toBeNull();
});

test('Take over asks first, and reads the entry again once it is yours', async () => {
  const fetchMock = heldBy();
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn();
  const root = show({ onchanged: changed });
  await tick();
  flushSync();

  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  flushSync();
  expect($(root, '.dialog')?.textContent).toContain('Take over editing from Anna Berg?');
  expect(changed).not.toHaveBeenCalled();

  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/locks/listings/seaview-cottage',
    expect.objectContaining({ method: 'POST', body: expect.stringContaining('"take":true') }),
  );
  expect(changed).toHaveBeenCalled();
});

// The hold is stored on the draft rows, so the form's words have to be saved first.
test('Not ready yet stores the edit, then holds the entry', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (String(url).startsWith('/admin/api/hold/'))
      return Response.json({ held: (JSON.parse(String(init?.body)) as { hold: boolean }).hold });
    return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  $<HTMLButtonElement>(root, '.hold-toggle')?.click();
  await tick();
  await tick();
  flushSync();

  expect(wrote(fetchMock).map((call) => call[0])).toEqual([
    '/admin/api/drafts/listings/seaview-cottage',
    '/admin/api/hold/listings/seaview-cottage',
  ]);
  expect(wrote(fetchMock)[1]?.[1]).toMatchObject({ body: JSON.stringify({ hold: true }) });
  expect($(root, '.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
  expect($(root, '.entry-header')?.classList.contains('is-held')).toBe(true);
});

test('an entry with nothing unpublished has nothing to hold back', () => {
  const root = show();
  expect($<HTMLButtonElement>(root, '.hold-toggle')?.disabled).toBe(true);
});

test('an entry somebody is already holding back opens with Ready off', () => {
  const root = show({ entry: { ...entry, pending: ['en'], held: true } });
  expect($(root, '.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
});

// The lock is the entry's, so a refusal in the second language surrenders the whole tab.
test('a refused save in the second language loses the entry too', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', refused());
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
});

test('the take-over confirm closes on Escape and hands focus back', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();
  const trigger = $<HTMLButtonElement>(root, '.lock-banner .btn-link');
  trigger?.focus();
  trigger?.click();
  flushSync();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect($(root, '.dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('the take-over dialog exposes the modal boundary it now enforces', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  flushSync();
  const dialog = $(root, '[aria-labelledby="take-h"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
});

// F05–F07: the mounted editor must keep the actual form, not merely report a failed helper.
test.each([500, 409])(
  'a refused translation flush (%i) keeps its pane and blocks hold/address/status',
  async (status) => {
    const changed = vi.fn();
    const requests = vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'PUT'
          ? Response.json({ reason: 'revision' }, { status })
          : Response.json({}),
    );
    vi.stubGlobal('fetch', requests);
    const root = show({ entry: { ...addressed, hidden: true }, onchanged: changed });
    $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
    flushSync();
    type(root, 'input#t-title', 'Unsaved German');
    $<HTMLButtonElement>(root, '[aria-label="Close side by side"]')?.click();
    await tick();
    flushSync();
    expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Unsaved German');
    expect($(root, '.pane .autosave')?.textContent).toContain('Not saved');
    $<HTMLButtonElement>(root, '.hold-toggle')?.click();
    await tick();
    $<HTMLButtonElement>(root, '.slug-row .btn-link')?.click();
    flushSync();
    $<HTMLButtonElement>(root, '.slug-row .btn')?.click();
    await tick();
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
    await tick();
    expect(wrote(requests).every((c) => (c[1] as RequestInit).method === 'PUT')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  },
);

test('a slow save drains the latest source edit with the returned revision before flush finishes', async () => {
  const { flushNavigation } = await import('../navigate');
  let release!: (response: Response) => void;
  const calls: { data: { title: string }; revision: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) return Response.json(HELD);
      if (isLint(url)) return Response.json({ results: [] });
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1)
        return new Promise<Response>((r) => {
          release = r;
        });
      return Response.json({ pending: true, problems: [], revisions: { en: 'third' } });
    }),
  );
  const root = show({ entry: { ...entry, revisions: { en: 'first' } } });
  type(root, 'input#f-title', 'First edit');
  const flushing = flushNavigation();
  await tick();
  type(root, 'input#f-title', 'Seaview Cottage');
  const again = flushNavigation();
  await tick();
  expect(calls).toHaveLength(1);
  const unloading = new Event('beforeunload', { cancelable: true });
  dispatchEvent(unloading);
  expect(unloading.defaultPrevented).toBe(true);
  release(Response.json({ pending: true, problems: [], revisions: { en: 'second' } }));
  expect(await flushing).toBe(true);
  expect(await again).toBe(true);
  flushSync();
  expect(calls.map((c) => [c.data.title, c.revision])).toEqual([
    ['First edit', 'first'],
    ['Seaview Cottage', 'second'],
  ]);
  expect(
    $(root, '.editor-header .autosave')?.textContent ?? $(root, '.autosave')?.textContent,
  ).toContain('Saved');
});

test('a rejected network save settles, preserves the edit, warns on unload, and can retry', async () => {
  const { flushNavigation } = await import('../navigate');
  let offline = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (offline) throw new TypeError('offline');
      return Response.json({ pending: true, problems: [], revisions: { en: 'next' } });
    }),
  );
  const root = show({ entry: { ...entry, revisions: { en: 'opened' } } });
  type(root, 'input#f-title', 'Keep this text');
  expect(await flushNavigation()).toBe(false);
  flushSync();
  expect($(root, '.autosave')?.textContent).toContain('Not saved');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep this text');
  const unloading = new Event('beforeunload', { cancelable: true });
  dispatchEvent(unloading);
  expect(unloading.defaultPrevented).toBe(true);
  offline = false;
  expect(await flushNavigation()).toBe(true);
  flushSync();
  const savedUnload = new Event('beforeunload', { cancelable: true });
  dispatchEvent(savedUnload);
  expect(savedUnload.defaultPrevented).toBe(false);
});

test.each([500, 409])(
  'a source save failure (%i) prevents status and turn-off mutations',
  async (status) => {
    const changed = vi.fn();
    const requests = vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'PUT'
          ? Response.json({ reason: 'revision' }, { status })
          : Response.json({}),
    );
    vi.stubGlobal('fetch', requests);
    const root = show({ entry: { ...addressed, hidden: true }, onchanged: changed });
    $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
    flushSync();
    type(root, 'input#f-title', 'Keep the source edit');
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
    await tick();
    $<HTMLButtonElement>(root, '.pane-head button.btn-off')?.click();
    flushSync();
    $<HTMLButtonElement>(root, '.dialog button.btn-danger')?.click();
    await tick();
    expect(wrote(requests).length).toBeGreaterThan(0);
    expect(wrote(requests).every((c) => (c[1] as RequestInit).method === 'PUT')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep the source edit');
  },
);

test('the source and translation share a save lane and propagate sibling revisions', async () => {
  const { flushNavigation } = await import('../navigate');
  let release: ((response: Response) => void) | undefined;
  const calls: { url: string; revision: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) return Response.json(HELD);
      if (isLint(url)) return Response.json({ results: [] });
      calls.push({ url, revision: JSON.parse(String(init?.body)).revision });
      if (calls.length === 1)
        return new Promise<Response>((r) => {
          release = r;
        });
      return Response.json({ pending: true, problems: [], revision: 'de-next' });
    }),
  );
  const root = show({ entry: { ...bilingual, revisions: { en: 'en-opened', de: 'de-opened' } } });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#f-price', 'New shared price');
  const flushing = flushNavigation();
  await tick();
  type(root, 'input#t-title', 'New German words');
  const again = flushNavigation();
  await tick();
  expect(calls).toHaveLength(1);
  if (!release) throw new Error('Source save did not start');
  release(
    Response.json({ pending: true, problems: [], revisions: { en: 'en-next', de: 'de-synced' } }),
  );
  expect(await flushing).toBe(true);
  expect(await again).toBe(true);
  expect(calls).toEqual([
    { url: '/admin/api/drafts/listings/seaview-cottage', revision: 'en-opened' },
    { url: '/admin/api/drafts/listings/seaview-cottage/de', revision: 'de-synced' },
  ]);
});

test.each(['source', 'translation'])(
  '%s activity renews a lease despite frequent read polls',
  async (column) => {
    vi.useFakeTimers();
    let expiry = Date.now() + 120000;
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) {
        if (init?.method === 'POST') expiry = Date.now() + 120000;
        return Response.json({ ...HELD, expires_at: expiry });
      }
      return Response.json({ pending: true, problems: [] });
    });
    vi.stubGlobal('fetch', requests);
    try {
      const root = show({ entry: bilingual });
      if (column === 'translation') {
        $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
        flushSync();
      }
      await vi.advanceTimersByTimeAsync(46000);
      type(root, column === 'source' ? 'input#f-title' : 'input#t-title', 'Activity renews');
      await vi.advanceTimersByTimeAsync(2100);
      flushSync();
      const claims = () =>
        requests.mock.calls.filter(([url, init]) => isLock(url) && init?.method === 'POST');
      expect(claims()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(46000);
      flushSync();
      expect(claims()).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);

test.each(['source', 'translation'])(
  'a rejected %s save settles and retains data for retry',
  async (column) => {
    const { flushNavigation } = await import('../navigate');
    let offline = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (isLock(url)) return Response.json(HELD);
        if (offline) throw new TypeError('Network disconnected');
        return Response.json({ pending: true, problems: [] });
      }),
    );
    const root = show({ entry: bilingual });
    if (column === 'translation') {
      $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
      flushSync();
    }
    const field = column === 'source' ? 'input#f-title' : 'input#t-title';
    type(root, field, 'Keep offline words');
    expect(await flushNavigation()).toBe(false);
    flushSync();
    expect(root.textContent).toContain('Not saved');
    expect(root.textContent).not.toContain('Saving…');
    expect($<HTMLInputElement>(root, field)?.value).toBe('Keep offline words');
    offline = false;
    expect(await flushNavigation()).toBe(true);
    flushSync();
    expect(root.textContent).not.toContain('Not saved');
  },
);

test('a rejected status action becomes retryable without discarding the editor', async () => {
  const changed = vi.fn();
  let offline = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (offline) throw new TypeError('offline');
      return Response.json({});
    }),
  );
  const root = show({ entry: { ...entry, hidden: true }, onchanged: changed });
  const clickStatus = () => {
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
  };
  clickStatus();
  await tick();
  flushSync();
  expect(changed).not.toHaveBeenCalled();
  expect(root.textContent).toContain('Connection lost');
  offline = false;
  clickStatus();
  await tick();
  flushSync();
  expect(changed).toHaveBeenCalledOnce();
});
