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
  /** What a publish row's expansion reads: `GET /admin/api/activity/diff?sha=`, by sha. */
  diffs: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const queue = Array.isArray(pages) ? [...pages] : [pages];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/admin/api/members') return Response.json({ members });
      if (url.startsWith('/admin/api/activity/diff?')) {
        const sha = new URLSearchParams(url.split('?')[1]).get('sha') ?? '';
        return sha in diffs ? Response.json(diffs[sha]) : new Response('', { status: 404 });
      }
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

// The dashboard draws the same rows with no member list — an owner-only read it does not
// make — so the row carries the name it was about at the time, and a member since renamed or
// removed is still named.
test('a role change names the member from the row itself when there is no member list', async () => {
  server({
    events: [ev('role-change', { subject: 'u9', detail: { role: 'owner', name: 'Jonas Weber' } })],
    cursor: null,
  });

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

// A global is edited at its own address rather than under a collection, and every other link to
// one on every other screen goes there.
test('a row about a global links to Site settings, not to a collection', async () => {
  server({
    events: [
      ev('publish', {
        subject: 'src/content/globals/en/site.yaml',
        detail: { files: 1 },
        commitSha: 'a1b2c3d4e5f60718',
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(root.querySelector('.said a')?.getAttribute('href')).toBe('/admin/site/site');
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

// 3.14 to 3.29 add kinds without opening this file, so a kind with no sentence of its own has
// to read as a record rather than throw or render nothing. A subject that is an entry file is
// named the way a publish names one, since that much is true whatever the kind turns out to be.
test('a kind nothing has written a sentence for still reads as a record', async () => {
  server({
    events: [ev('template-saved', { subject: 'src/content/pages/en/contact.yaml' })],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['Anna Berg — template-saved contact EN']);
  expect(root.querySelector('.said a')?.getAttribute('href')).toBe('/admin/c/pages/contact');
});

// Both rows are written with the old name in `detail.from` and the entry as it is now as the
// subject, which is the one of the two that is somewhere to go.
test('a rename and a duplicate name what the entry was and link to what it is', async () => {
  server({
    events: [
      ev('entry-rename', {
        subject: 'src/content/pages/en/contact.yaml',
        detail: { from: 'contact-us' },
      }),
      ev('entry-duplicate', {
        subject: 'src/content/listings/en/mill-house-copy.yaml',
        detail: { from: 'mill-house' },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg renamed contact-us to contact EN',
    'Anna Berg duplicated mill-house as mill-house-copy EN',
  ]);
  expect(Array.from(root.querySelectorAll('.said a')).map((a) => a.getAttribute('href'))).toEqual([
    '/admin/c/pages/contact',
    '/admin/c/listings/mill-house-copy',
  ]);
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

// A cron row is a sentence like every other, not the job's internal name with a dash in it.
test('a cron row says what the job did, or why it did not', async () => {
  server({
    events: [
      ev('cron-reconcile', { user: null, detail: { done: 2 } }),
      ev('cron-retention', { user: null, detail: { done: 1 } }),
      ev('cron-orphans', { user: null, detail: { done: 3 } }),
      ev('cron-orphans', { user: null, detail: { error: 'the repository could not be reached' } }),
      ev('cron-later', { user: null, detail: { done: 1 } }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'The hourly media check recorded 2 uploads the library had missed.',
    'The daily clean-up removed 1 activity row older than 180 days.',
    'The daily clean-up discarded 3 drafts whose file is no longer in the repository.',
    'The daily draft clean-up failed: the repository could not be reached.',
    'The later job ran and did 1 thing.',
  ]);
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

// The two ways a publish comes back with nothing written, and the one row on this screen that
// The mockup's state 5: the row opens on what the commit changed, field by field, read from
// the server only once somebody asks — a log page of fifty publishes is not fifty git reads.
test('a publish row opens to the commit read field by field, not to its files', async () => {
  const calls = server(
    {
      events: [
        ev('publish', {
          subject: 'src/content/listings/en/mill-house.yaml',
          detail: { files: 1, entries: ['listings/mill-house'] },
          commitSha: 'def5678abc',
        }),
      ],
      cursor: null,
    },
    [],
    {
      def5678abc: {
        entries: [
          {
            key: 'listings/mill-house',
            groups: [
              {
                locale: 'en',
                changes: [
                  { path: 'rooms', label: 'Rooms', kind: 'value', before: '2', after: '4' },
                ],
              },
            ],
          },
        ],
        more: 0,
      },
    },
  );
  const root = await show();

  const toggle = root.querySelector('.expand button') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-label')).toBe('What changed, 1h ago');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(calls.some((u) => u.startsWith('/admin/api/activity/diff'))).toBe(false);

  toggle.click();
  flushSync();
  await settle();

  const panel = root.querySelector('.activity-detail') as HTMLElement;
  expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.hidden).toBe(false);
  expect(text(panel)).toContain('mill-house');
  expect(text(panel)).toContain('Rooms2 → 4');
  expect(text(panel)).not.toContain('rooms:');
  expect(calls.filter((u) => u.startsWith('/admin/api/activity/diff'))).toEqual([
    '/admin/api/activity/diff?sha=def5678abc',
  ]);
});

// expands: 3.19 puts the other commit's diff under it, this puts the reason.
test('a failed publish says the repository refused it and opens on the reason', async () => {
  server({
    events: [ev('publish-failed', { detail: { files: 3, reason: 'ref-moved' } })],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['Publish failed: the repository refused the update.']);
  const toggle = root.querySelector('.expand button') as HTMLButtonElement;
  const panel = root.querySelector('.activity-detail') as HTMLElement;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.hidden).toBe(true);

  toggle.click();
  flushSync();

  expect(root.querySelector('.activity-detail')?.textContent).toContain(
    'Another change reached the repository first.',
  );
  expect((root.querySelector('.activity-detail') as HTMLElement).hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

test('a publish stopped by a file somebody else changed names that entry', async () => {
  server({
    events: [
      ev('publish-conflict', {
        subject: 'src/content/listings/en/mill-house.yaml',
        detail: { files: 1 },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['Publish stopped: somebody else had changed mill-house EN']);
  expect(root.querySelector('.said a')?.getAttribute('href')).toBe('/admin/c/listings/mill-house');
  expect(root.querySelector('.activity-detail')?.textContent).toContain(
    'discard the draft in the pending-changes drawer',
  );
});

// 3.10's two kinds, whose sentences the mockup draws beside the failed publish.
test('a take-over and a released hold read as sentences, and neither expands', async () => {
  server({
    events: [
      ev('lock-takeover', {
        subject: 'src/content/pages/en/contact.yaml',
        detail: { from: 'Martin Vale' },
      }),
      ev('hold-released', {
        subject: 'src/content/pages/en/about-us.yaml',
        detail: { from: 'Martin Vale' },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    "Anna Berg took over Martin Vale's editing of contact EN",
    "Anna Berg released Martin Vale's hold on about-us EN",
  ]);
  expect(root.querySelector('.expand button')).toBe(null);
  expect(root.querySelector('.activity-detail')).toBe(null);
});

// One kind, two writers: the drawer's Discard and a version restored over unpublished changes.
test('a discard reads as a sentence, and a restore over a draft says which it was', async () => {
  server({
    events: [
      ev('draft-discard', {
        subject: 'src/content/pages/en/contact.yaml',
        detail: { locales: ['en', 'de'] },
      }),
      ev('draft-discard', {
        subject: 'src/content/pages/en/about-us.yaml',
        detail: { locales: ['en'], restore: 'abc1234' },
      }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg discarded the unpublished changes to contact EN',
    'Anna Berg restored an older version over the unpublished changes to about-us EN',
  ]);
});

// The hold toggle writes no name, so the sentence has to read without one.
test('a hold released with nobody named still reads', async () => {
  server({
    events: [ev('hold-released', { subject: 'src/content/pages/en/about-us.yaml' })],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual(['Anna Berg released the hold on about-us EN']);
});

// 3.14's kind. There is no media library to open until Phase 4, so the row says what happened
// and stops there.
test('an upload reads as a sentence, named by the file it was chosen as', async () => {
  server({
    events: [
      ev('upload', { subject: 'a'.repeat(64), detail: { name: 'seaview.jpg', bytes: 128_000 } }),
      ev('upload', { subject: 'b'.repeat(64) }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg uploaded seaview.jpg.',
    'Anna Berg uploaded a file.',
  ]);
  expect(root.querySelector('.said a')).toBe(null);
});

// 4.3's two. Archiving and unarchiving are the same kind and are told apart by the flag, so
// each is its own sentence; a delete says where the file went, because it is the only row in
// the log about bytes that are gone.
test('putting a picture away, taking it back and deleting it each read as themselves', async () => {
  server({
    events: [
      ev('media-archive', { subject: 'a'.repeat(64), detail: { archived: true, name: 'old.jpg' } }),
      ev('media-archive', {
        subject: 'a'.repeat(64),
        detail: { archived: false, name: 'old.jpg' },
      }),
      ev('media-delete', { subject: 'a'.repeat(64), detail: { name: 'old.jpg', bytes: 900 } }),
      ev('media-delete', { subject: 'b'.repeat(64) }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg archived old.jpg.',
    'Anna Berg took old.jpg out of the archive.',
    'Anna Berg deleted old.jpg from storage.',
    'Anna Berg deleted a file from storage.',
  ]);
});

// 3.25's kind. The value is never in the row, and never was in the log: what happened to which
// key is the whole of it.
test('a key the client set reads as what happened to it, and never as the key', async () => {
  server({
    events: [
      ev('setting-changed', { subject: 'deepl', detail: { how: 'set' } }),
      ev('setting-changed', { subject: 'deepl', detail: { how: 'replaced' } }),
      ev('setting-changed', { subject: 'assist', detail: { how: 'removed' } }),
      ev('setting-changed', { subject: 'unheard-of', detail: {} }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg set the DeepL key.',
    'Anna Berg replaced the DeepL key.',
    'Anna Berg removed the writing help key.',
    'Anna Berg changed a key.',
  ]);
});

// The two commits that take a file away, and the one that puts one back. A delete is named
// rather than linked: the entry is gone, so the link would be a 404.
test('the two removals and a restore each read as their own sentence', async () => {
  server({
    events: [
      ev('entry-delete', {
        subject: 'src/content/listings/en/mill-house.yaml',
        detail: { locales: ['en', 'de'] },
        commitSha: 'd1b2c3d4e5f60718',
      }),
      ev('locale-off', {
        subject: 'src/content/listings/en/harbour-flat.yaml',
        detail: { locales: ['de'] },
        commitSha: 'e1b2c3d4e5f60718',
      }),
      ev('revert', {
        subject: 'src/content/listings/en/mill-house.yaml',
        detail: { of: 'd1b2c3d', files: 2, restore: true },
        commitSha: 'f1b2c3d4e5f60718',
      }),
      ev('revert', { detail: { of: 'a1b2c3d', files: 2 }, commitSha: 'a2b2c3d4e5f60718' }),
    ],
    cursor: null,
  });
  const root = await show();

  expect(sentences(root)).toEqual([
    'Anna Berg deleted mill-house (EN, DE). d1b2c3d',
    'Anna Berg turned DE off for harbour-flat EN e1b2c3d',
    'Anna Berg restored mill-house EN f1b2c3d',
    'Anna Berg undid a publish. a2b2c3d',
  ]);
  expect(root.querySelectorAll('.said a').length).toBe(2);
});

// The way back is on the row that recorded the removal, and only there: a publish is undone
// from the drawer, and a row with no commit behind it has nothing to put back.
test('restore is offered on a removal and sends the commit that row named', async () => {
  const calls = server({
    events: [
      ev('entry-delete', {
        subject: 'src/content/listings/en/mill-house.yaml',
        detail: { locales: ['en'] },
        commitSha: 'd1b2c3d4e5f60718',
      }),
      ev('publish', { detail: { files: 1 }, commitSha: 'a1b2c3d4e5f60718' }),
    ],
    cursor: null,
  });
  const root = await show();

  // The publish row's own button is the one that opens its diff, in `.expand`; Restore is not
  // offered on it.
  const buttons = Array.from(root.querySelectorAll('li .meta > button'));
  expect(buttons.map((b) => b.textContent)).toEqual(['Restore']);
  (buttons[0] as HTMLButtonElement).click();
  await settle();

  expect(fetch).toHaveBeenCalledWith('/admin/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: 'd1b2c3d4e5f60718' }),
  });
  // And the list is read again, so the row it was on can say what it says now.
  expect(activityCalls(calls).length).toBe(2);
});

// The one case a restore is refused: something is at the path again. The server's own sentence
// names the file, and nothing was written.
test('a refused restore says what the server said', async () => {
  server({
    events: [
      ev('entry-delete', {
        subject: 'src/content/listings/en/mill-house.yaml',
        detail: { locales: ['en'] },
        commitSha: 'd1b2c3d4e5f60718',
      }),
    ],
    cursor: null,
  });
  const root = await show();
  vi.mocked(fetch).mockImplementationOnce(
    async () =>
      new Response(JSON.stringify({ error: 'mill-house.yaml has changed since that commit' }), {
        status: 409,
      }),
  );

  (root.querySelector('li .meta button') as HTMLButtonElement).click();
  await settle();

  expect(root.querySelector('.notice-warn')?.textContent).toContain('has changed since');
});
