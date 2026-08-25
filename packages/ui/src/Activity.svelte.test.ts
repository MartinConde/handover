import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Activity from './Activity.svelte';

let app: ReturnType<typeof mount>;

interface Event {
  id: string;
  at: number;
  kind: string;
  subject: string | null;
  detail: unknown;
  commitSha: string | null;
  user: { id: string; name: string | null; email: string | null } | null;
}
interface Page {
  events: Event[];
  cursor: string | null;
}

const ANNA = { id: 'u2', name: 'Anna Berg', email: 'anna@example.com' };
let seq = 0;
const ev = (kind: string, extra: Partial<Event> = {}): Event => ({
  id: `e${++seq}`,
  at: Date.now() - 3_600_000,
  kind,
  subject: null,
  detail: null,
  commitSha: null,
  user: ANNA,
  ...extra,
});

/** What `GET /admin/api/activity` answers, one page per call, and the member list beside it. */
function server(
  pages: Page | (Page | (() => Promise<Page>))[],
  members: { id: string; name: string; email: string }[] = [],
) {
  const calls: string[] = [];
  const queue = Array.isArray(pages) ? [...pages] : [pages];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/admin/api/members') return Response.json({ members });
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      return Response.json(typeof answer === 'function' ? await answer() : answer);
    }),
  );
  return calls;
}

const show = async (role: 'owner' | 'editor' = 'owner') => {
  app = mount(Activity, { target: document.body, props: { role } });
  flushSync();
  await settle();
  return document.body;
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const sentences = (root: ParentNode) => Array.from(root.querySelectorAll('.said')).map(text);
const button = (root: ParentNode, label: string) => {
  const found = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
};
/** A select filter, driven the way a person drives it. */
const choose = async (root: ParentNode, id: string, value: string) => {
  const select = root.querySelector(`#${id}`) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  await settle();
};
const activityCalls = (calls: string[]) => calls.filter((u) => u.startsWith('/admin/api/activity'));

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('a sign-in says which of the three ways in the person used', async () => {
  server({
    events: [
      ev('login', { detail: { method: 'password' } }),
      ev('login', { detail: { method: 'link' } }),
      ev('login', { detail: { method: 'github' } }),
    ],
    cursor: null,
  });

  expect(sentences(await show())).toEqual([
    'Anna Berg signed in with a password.',
    'Anna Berg signed in with an email link.',
    'Anna Berg signed in through GitHub.',
  ]);
});

test('an invite names the address it went to and the role it was for', async () => {
  server({
    events: [ev('invite', { subject: 'u9', detail: { email: 'lea@example.com', role: 'editor' } })],
    cursor: null,
  });

  expect(sentences(await show())).toEqual(['Anna Berg invited lea@example.com as an editor.']);
});

// The subject of a role change is a member id, and the row has to read as a sentence rather
// than as a database key.
test('a role change names the member it was about rather than their id', async () => {
  server(
    { events: [ev('role-change', { subject: 'u9', detail: { role: 'owner' } })], cursor: null },
    [{ id: 'u9', name: 'Jonas Weber', email: 'jonas@example.com' }],
  );

  expect(sentences(await show())).toEqual(['Anna Berg made Jonas Weber an owner.']);
});

test('a role change about somebody since removed still prints no id', async () => {
  server({
    events: [ev('role-change', { subject: 'u9', detail: { role: 'owner' } })],
    cursor: null,
  });

  const said = sentences(await show());
  expect(said).toEqual(['Anna Berg made a member an owner.']);
  expect(said[0]).not.toContain('u9');
});

test('a removal and a revoked invite are different sentences from the one kind', async () => {
  server({
    events: [
      ev('member-removed', { detail: { email: 'lea@example.com', role: 'editor', pending: true } }),
      ev('member-removed', {
        detail: { email: 'jonas@example.com', role: 'editor', pending: false },
      }),
    ],
    cursor: null,
  });

  expect(sentences(await show())).toEqual([
    'Anna Berg revoked the invite to lea@example.com.',
    'Anna Berg removed jonas@example.com.',
  ]);
});

test('a password set says whether it was a first, a change or a reset', async () => {
  server({
    events: [
      ev('password-set', { detail: { how: 'first' } }),
      ev('password-set', { detail: { how: 'changed' } }),
      ev('password-set', { detail: { how: 'reset' } }),
    ],
    cursor: null,
  });

  expect(sentences(await show())).toEqual([
    'Anna Berg set their first password.',
    'Anna Berg changed their password.',
    'Anna Berg reset their password.',
  ]);
});

test('a publish of one file links to the entry and names its language', async () => {
  server({
    events: [
      ev('publish', {
        subject: 'src/content/listings/de/mill-house.yaml',
        detail: { files: 1 },
        commitSha: 'a1b2c3d4e5f60718',
      }),
    ],
    cursor: null,
  });
  const root = await show();

  const link = root.querySelector('.said a');
  expect(link?.getAttribute('href')).toBe('/admin/c/listings/mill-house');
  expect(link?.textContent).toBe('mill-house');
  expect(sentences(root)).toEqual(['Anna Berg published mill-house DE a1b2c3d']);
});

// A commit with no one entry on it has nowhere to send anybody, so it counts its files instead
// — and counts them in words, since 3.11 decides again what a `publish` row carries.
test('a publish with no entry on it counts its files and links to none of them', async () => {
  server({
    events: [
      ev('publish', { detail: { files: 4 }, commitSha: 'a1b2c3d4e5f60718' }),
      ev('publish', { detail: { files: 1 }, commitSha: 'b1b2c3d4e5f60718' }),
      ev('publish', { detail: {}, commitSha: 'c1b2c3d4e5f60718' }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg published 4 files. a1b2c3d',
    'Anna Berg published 1 file. b1b2c3d',
    'Anna Berg published several files. c1b2c3d',
  ]);
  expect(root.querySelector('.said a')).toBe(null);
});

test('a message the provider would not take names what it was for and nobody', async () => {
  server({
    events: [ev('mail-failed', { user: null, detail: { message: 'invite' } })],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['An invite could not be sent.']);
  expect(root.querySelector('.avatar')?.classList.contains('is-system')).toBe(true);
});

// 3.9 to 3.17 add kinds without opening this file, so a kind with no sentence of its own has to
// read as a record rather than throw or render nothing. A subject that is an entry file is
// named the way a publish names one, since that much is true whatever the kind turns out to be.
test('a kind nothing has written a sentence for still reads as a record', async () => {
  server({
    events: [
      ev('lock-takeover', {
        subject: 'src/content/pages/en/contact.yaml',
        detail: { from: 'u9', heldSince: 12 },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['Anna Berg — lock-takeover contact EN']);
  expect(root.querySelector('.said a')?.getAttribute('href')).toBe('/admin/c/pages/contact');
});

// The log outlives the account: the id is there with nothing behind it, and reading that as the
// system would say a person's sign-in was a cron job.
test('an event whose person has been removed is not drawn as the system', async () => {
  server({
    events: [
      ev('login', {
        detail: { method: 'password' },
        user: { id: 'u9', name: null, email: null },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['A removed member signed in with a password.']);
  expect(root.querySelector('.avatar')?.classList.contains('is-system')).toBe(false);
});

test('each row wears the chip of the group its kind belongs to, and an unclaimed kind none', async () => {
  server({
    events: [
      ev('login', { detail: { method: 'password' } }),
      ev('publish', { detail: { files: 2 } }),
      ev('cron-retention', { user: null }),
      ev('something-phase-9-invents'),
    ],
    cursor: null,
  });
  const root = await show();

  expect(
    Array.from(
      root.querySelectorAll('.activity li'),
      (li) => li.querySelector('.badge')?.textContent ?? '',
    ),
  ).toEqual(['Accounts', 'Publishing', 'System', '']);
});

// "Yesterday" is not an audit record, so a row stops counting backwards once it is a week old.
// The buckets are calendar days from local midnight, not elapsed milliseconds, because a day is
// 23 or 25 hours across a daylight-saving change.
test('a time is worded by how long ago it was, and becomes a date after a week', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-25T14:00:00'));
  server({
    events: [
      ev('login', { at: Date.parse('2026-08-25T13:59:55'), detail: { method: 'password' } }),
      ev('login', { at: Date.parse('2026-08-25T13:38:00'), detail: { method: 'password' } }),
      ev('login', { at: Date.parse('2026-08-25T11:59:00'), detail: { method: 'password' } }),
      ev('login', { at: Date.parse('2026-08-24T12:00:00'), detail: { method: 'password' } }),
      ev('login', { at: Date.parse('2026-08-22T14:00:00'), detail: { method: 'password' } }),
      ev('login', { at: Date.parse('2026-08-16T14:00:00'), detail: { method: 'password' } }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(Array.from(root.querySelectorAll('.when'), (t) => t.textContent)).toEqual([
    'Just now',
    '22 min ago',
    '2h ago',
    'Yesterday',
    '3 days ago',
    '16 Aug 2026',
  ]);
});

test('the exact instant is on the row even where the words are relative', async () => {
  server({
    events: [ev('login', { at: 1_755_864_000_000, detail: { method: 'password' } })],
    cursor: null,
  });
  const root = await show();

  const when = root.querySelector('time.when') as HTMLTimeElement;
  expect(when.getAttribute('datetime')).toBe('2025-08-22T12:00:00.000Z');
  expect(when.getAttribute('title')).toContain('22 August 2025');
});

test('choosing a kind group asks the server for that group', async () => {
  const calls = server({ events: [], cursor: null });
  const root = await show();

  await choose(root, 'activity-group', 'Publishing');

  expect(activityCalls(calls).at(-1)).toBe('/admin/api/activity?group=Publishing');
});

test('choosing a person asks the server for that person', async () => {
  const calls = server({ events: [], cursor: null }, [
    { id: 'u9', name: 'Jonas Weber', email: 'jonas@example.com' },
  ]);
  const root = await show();

  await choose(root, 'activity-person', 'u9');

  expect(activityCalls(calls).at(-1)).toBe('/admin/api/activity?user=u9');
});

test('an entry filter sends the path exactly, since that is what the server matches on', async () => {
  const calls = server({ events: [], cursor: null });
  const root = await show();

  const box = root.querySelector('#activity-entry') as HTMLInputElement;
  box.value = 'src/content/listings/en/mill-house.yaml';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  await settle();

  expect(activityCalls(calls).at(-1)).toBe(
    '/admin/api/activity?entry=src%2Fcontent%2Flistings%2Fen%2Fmill-house.yaml',
  );
});

// The cursor belongs to the query that produced it. Carrying it across a filter change appends
// page two of the old question under page one of the new one.
test('changing a filter drops the cursor it was holding', async () => {
  // Page two hands back a cursor of its own: a screen holding one that answers `null` cannot
  // carry anything, so the fixture has to give it something to carry.
  const calls = server([
    { events: [ev('login', { detail: { method: 'password' } })], cursor: '1000.a' },
    { events: [ev('login', { detail: { method: 'link' } })], cursor: '2000.b' },
  ]);
  const root = await show();
  button(root, 'Load more').click();
  await settle();

  await choose(root, 'activity-group', 'Accounts');

  expect(activityCalls(calls)).toEqual([
    '/admin/api/activity?',
    '/admin/api/activity?cursor=1000.a',
    '/admin/api/activity?group=Accounts',
  ]);
});

test('load more appends the next page rather than replacing the list', async () => {
  server([
    {
      events: [
        ev('login', { detail: { method: 'password' } }),
        ev('login', { detail: { method: 'link' } }),
      ],
      cursor: '1000.a',
    },
    { events: [ev('login', { detail: { method: 'github' } })], cursor: null },
  ]);
  const root = await show();

  button(root, 'Load more').click();
  await settle();

  expect(sentences(root)).toEqual([
    'Anna Berg signed in with a password.',
    'Anna Berg signed in with an email link.',
    'Anna Berg signed in through GitHub.',
  ]);
  expect(root.querySelector('.load-more')).toBe(null);
});

test('load more says so, and refuses a second press, while the page is on its way', async () => {
  let land: (page: Page) => void = () => {};
  const second = new Promise<Page>((resolve) => {
    land = resolve;
  });
  server([
    { events: [ev('login', { detail: { method: 'password' } })], cursor: '1000.a' },
    () => second,
  ]);
  const root = await show();

  const more = () => root.querySelector('.load-more button') as HTMLButtonElement;
  more().click();
  await settle();
  expect([more().textContent?.trim(), more().disabled]).toEqual(['Loading…', true]);

  land({ events: [ev('login', { detail: { method: 'link' } })], cursor: null });
  await settle();
  expect(sentences(root)).toHaveLength(2);
});

// Replacing the list under somebody is a change axe scores nothing on and a keyboard pass does
// not catch: the region has to be in the document before its content changes, or nothing is said.
test('the result of a filter is announced, not only redrawn', async () => {
  const calls = server([
    { events: [ev('login', { detail: { method: 'password' } })], cursor: null },
    { events: [], cursor: null },
  ]);
  const root = await show();
  const said = () => root.querySelector('[role="status"]')?.textContent?.trim();
  expect(said()).toBe('1 event shown');

  await choose(root, 'activity-group', 'Media');

  expect(activityCalls(calls).at(-1)).toBe('/admin/api/activity?group=Media');
  expect(said()).toBe('No activity matches these filters');
});

test('an editor is offered no person filter and is told whose activity this is', async () => {
  const calls = server({ events: [], cursor: null });
  const root = await show('editor');

  expect(root.querySelector('#activity-person')).toBe(null);
  expect(text(root.querySelector('.list-note') as HTMLElement)).toContain('your own activity');
  expect(calls).not.toContain('/admin/api/members');
});

test('an owner whose filters match nothing is offered a way back', async () => {
  const calls = server({ events: [], cursor: null });
  const root = await show();
  await choose(root, 'activity-group', 'Media');
  expect(text(root)).toContain('No activity matches these filters');

  button(root, 'Clear filters').click();
  await settle();

  expect(activityCalls(calls).at(-1)).toBe('/admin/api/activity?');
  expect((root.querySelector('#activity-group') as HTMLSelectElement).value).toBe('');
});

// "Nothing here" and "nothing matches" are different answers, and only one of them mentions
// the filters somebody has set.
test('a log with nothing in it yet is not the same sentence as one nothing matches', async () => {
  server({ events: [], cursor: null });
  const root = await show();

  expect(text(root)).toContain('Nothing has been recorded yet');
  expect(text(root)).not.toContain('No activity matches these filters');
});
