import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Redirects from './Redirects.svelte';

// Testing: what a row says about a rule and who owns it, the search and the reason filter, the
// three writes and the sentence each refusal carries, the age warning on a delete, and the three
// verdicts Test reads off the live site.
// Not testing: the route branch that mounts this screen, or the page picker, which has its own.

type Rule = {
  _id: string;
  from: string;
  to: string;
  status: 301 | 302;
  reason: 'slug-change' | 'hidden' | 'deleted' | 'manual';
  entry?: string;
  createdAt: string;
  title?: string;
  pending?: true;
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const rule = (over: Partial<Rule> = {}): Rule => ({
  _id: 'aaaaaaaa',
  from: '/summer-offer',
  to: '/listings',
  status: 301,
  reason: 'manual',
  createdAt: ago(120),
  ...over,
});

let app: ReturnType<typeof mount>;
let asked: { url: string; method: string; body: unknown }[] = [];
let rules: Rule[] = [];
let refusal: { status: number; body: unknown } | undefined;
/** What fetching the old address answers: the fields the verdict reads, or a network failure. */
let live: { status: number; redirected: boolean; url: string } | Error = {
  status: 404,
  redirected: false,
  url: `${location.origin}/summer-offer`,
};

const show = async () => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === '/admin/api/entries')
        return Response.json({ entries: [], locales: ['en', 'de'], defaultLocale: 'en' });
      // The old address itself, asked of the site: what the asset server answers with today.
      if (!url.startsWith('/admin/')) {
        if (live instanceof Error) throw live;
        return live as unknown as Response;
      }
      if (init?.method && init.method !== 'GET')
        return refusal
          ? Response.json(refusal.body, { status: refusal.status })
          : Response.json({});
      return Response.json({ rules });
    }),
  );
  app = mount(Redirects, { target: document.body, props: {} });
  await settle();
  return document.body;
};

// The screen loads the table and the picker's list before it draws either.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  rules = [];
  refusal = undefined;
  live = { status: 404, redirected: false, url: `${location.origin}/summer-offer` };
});

const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
const all = (sel: string) => Array.from(document.body.querySelectorAll(sel));
const click = (sel: string) => {
  q<HTMLElement>(sel).click();
  flushSync();
};
const type = (sel: string, value: string) => {
  const el = q<HTMLInputElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const rows = () =>
  all('.table .row').map((row) =>
    Array.from(row.querySelectorAll('.td'), (td) => td.textContent?.trim().replace(/\s+/g, ' ')),
  );

test('a row says where the rule came from and a rule waiting on a draft says it is not live', async () => {
  rules = [
    rule({
      _id: 'a',
      from: '/old-mill',
      to: '/listings/mill-house',
      reason: 'slug-change',
      entry: 'listings/mill-house',
      title: 'The Mill House',
    }),
    rule({
      _id: 'b',
      from: '/campaign',
      to: 'https://example.com/x.pdf',
      status: 302,
      pending: true,
    }),
  ];
  await show();

  const [first, second] = rows();
  expect(first?.slice(0, 5)).toEqual([
    '/old-mill',
    '/listings/mill-house',
    '301',
    'Slug change',
    'The Mill House',
  ]);
  expect(second?.slice(0, 4)).toEqual([
    '/campaign Not published yet',
    'https://example.com/x.pdf',
    '302',
    'Manual',
  ]);
  expect(q('.notice-info').textContent).toContain('not live yet');
});

// Unhiding removes the rule in the same commit, so this screen never takes one out: the row
// says whose it is instead of offering an action that would come undone at the next publish.
test('a hidden entry’s rule is locked, and both buttons say why', async () => {
  rules = [
    rule({ _id: 'c', reason: 'hidden', entry: 'listings/mill-house', title: 'The Mill House' }),
  ];
  await show();

  expect(q('.table .row').classList.contains('is-managed')).toBe(true);
  // Test stays live: a managed rule is still one a client wants to know is working.
  const buttons = all('.menu-cell button:not(.btn-test)') as HTMLButtonElement[];
  expect(buttons.map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
  expect(q<HTMLButtonElement>('.menu-cell .btn-test').disabled).toBe(false);
  const why = q(`#${buttons[0]?.getAttribute('aria-describedby')}`);
  expect(why.textContent).toContain('managed by The Mill House');
});

test('the search matches the old address and the new one', async () => {
  rules = [
    rule({ _id: 'a', from: '/summer-offer', to: '/listings' }),
    rule({ _id: 'b', from: '/brochure', to: 'https://cdn.example.com/summer.pdf' }),
    rule({ _id: 'c', from: '/team/john', to: '/team' }),
  ];
  await show();

  type('#rd-q', 'summer');

  expect(rows().map((r) => r[0])).toEqual(['/summer-offer', '/brochure']);
});

test('the reason filter keeps only the rules of that kind', async () => {
  rules = [
    rule({ _id: 'a', from: '/one', reason: 'manual' }),
    rule({ _id: 'b', from: '/two', reason: 'deleted' }),
  ];
  await show();

  const select = q<HTMLSelectElement>('#rd-reason');
  select.value = 'deleted';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();

  expect(rows().map((r) => r[0])).toEqual(['/two']);
});

test('adding a rule posts what was typed and reloads the table', async () => {
  await show();
  click('.list-toolbar .btn-primary');

  type('#rd-from', '/summer-offer');
  click('input[name="rd-kind"][value="url"]');
  type('#rd-url', 'https://example.com/offer');
  click('input[name="rd-code"][value="302"]');
  q<HTMLFormElement>('.dialog form').requestSubmit();
  await settle();

  expect(asked.filter((a) => a.method === 'POST')).toEqual([
    {
      url: '/admin/api/redirects',
      method: 'POST',
      body: { from: '/summer-offer', to: 'https://example.com/offer', status: 302 },
    },
  ]);
  expect(document.body.querySelector('.dialog')).toBe(null);
});

// The server owns every refusal, and the sentence belongs under the box it is about.
test('a refusal is shown under the box the server names', async () => {
  refusal = {
    status: 422,
    body: {
      field: 'from',
      message: 'This is a real page. A redirect here would hide Harbour Flat from visitors.',
    },
  };
  await show();
  click('.list-toolbar .btn-primary');
  type('#rd-from', '/listings/harbour-flat');
  q<HTMLFormElement>('.dialog form').requestSubmit();
  await settle();

  expect(q('#rd-from-e').textContent).toContain('would hide Harbour Flat');
  expect(q<HTMLInputElement>('#rd-from').getAttribute('aria-invalid')).toBe('true');
});

test('a rule already pointing at the address being claimed is named before it is rewritten', async () => {
  rules = [rule({ _id: 'a', from: '/listings/seaview-cottage', to: '/summer-offer' })];
  await show();
  click('.list-toolbar .btn-primary');
  type('#rd-from', '/summer-offer');

  expect(q('.dialog .notice-info').textContent).toContain('/listings/seaview-cottage');
});

test('deleting a rule younger than a year warns with its age and then deletes it', async () => {
  rules = [rule({ _id: 'a', createdAt: ago(120) })];
  await show();
  click('.menu-cell button:last-child');

  expect(q('.dialog .notice-warn').textContent?.replace(/\s+/g, ' ')).toContain(
    'This rule is 4 months old',
  );

  click('.dialog .btn-danger');
  await settle();

  expect(asked.filter((a) => a.method === 'DELETE')).toEqual([
    { url: '/admin/api/redirects/a', method: 'DELETE', body: undefined },
  ]);
});

test('a rule older than a year is deleted without the warning', async () => {
  rules = [rule({ _id: 'a', createdAt: ago(400) })];
  await show();
  click('.menu-cell button:last-child');

  expect(q('.dialog')).toBeTruthy();
  expect(document.body.querySelector('.dialog .notice-warn')).toBe(null);
});

// Test asks the live site, from the browser, for the old address — the file is not the answer,
// since a rule is live only after a publish and a build. Three verdicts: it works, it is not
// there yet, or something else is answering.
const verdict = async () => {
  click('.menu-cell .btn-test');
  await settle();
  const pop = q('.test-pop');
  return {
    kind: q('.test-pop .verdict').className.replace('verdict', '').trim(),
    line: q('.test-pop .line').textContent?.replace(/\s+/g, ' ').trim(),
    text: pop.textContent ?? '',
  };
};

test('Test reads Working when the old address lands where the rule points', async () => {
  rules = [rule()];
  live = { status: 200, redirected: true, url: `${location.origin}/listings/` };
  await show();

  const seen = await verdict();
  expect(seen.kind).toBe('is-ok');
  expect(seen.line).toBe('/summer-offer → /listings/');
  expect(asked.at(-1)).toMatchObject({ url: '/summer-offer', method: 'GET' });
  expect(q('.test-pop').getAttribute('role')).toBe('status');
});

test('Test reads Not there yet on a 404, naming the build', async () => {
  rules = [rule()];
  await show();

  const seen = await verdict();
  expect(seen.kind).toBe('is-wait');
  expect(seen.line).toBe('/summer-offer → 404');
  expect(seen.text).toContain('still building');
});

test('Test reads a mismatch when a page answers or the address forwards elsewhere', async () => {
  rules = [rule()];
  live = { status: 200, redirected: false, url: `${location.origin}/summer-offer` };
  await show();
  const page = await verdict();
  expect(page.kind).toBe('is-bad');
  expect(page.line).toBe('/summer-offer → 200 (no redirect)');
  expect(page.text).toContain('A real page answers at this address');

  live = { status: 200, redirected: true, url: `${location.origin}/de/` };
  const elsewhere = await verdict();
  expect(elsewhere.kind).toBe('is-bad');
  expect(elsewhere.line).toBe('/summer-offer → /de/');
  expect(elsewhere.text).toContain('somewhere else');
});

// A rule pointing off this site: following it is a request to another origin, which the browser
// will not show this page. That failure is the rule doing its job.
test('Test on a rule pointing off the site counts a refused cross-origin follow as Working', async () => {
  rules = [rule({ to: 'https://example.com/brochure.pdf' })];
  live = new TypeError('Failed to fetch');
  await show();

  const seen = await verdict();
  expect(seen.kind).toBe('is-ok');
  expect(seen.text).toContain('off this site');
});
