import { expect, test } from 'vitest';
import { fakeGit, manual, RULE, redirects } from '../db.fixtures.js';
import {
  collapseRedirects,
  editRedirects,
  readRedirects,
  redirectError,
  redirectRule,
  redirectSourceError,
  redirectsText,
} from './redirects.js';

// The asset server matches exactly, so both forms of `from` are written and `to` lands in one hop.
test("redirectsText writes each from both ways and to in the site's own form", () => {
  const rule = { _id: 'aaaaaaaa', status: 301 as const, createdAt: '2026-01-01T00:00:00Z' };
  const rules = [
    { ...rule, from: '/old', to: '/new', reason: 'slug-change' as const, entry: 'pages/new' },
    { ...rule, from: '/brochure', to: 'https://example.com/b.pdf', reason: 'manual' as const },
    { ...rule, from: '/gone/', to: '/', reason: 'deleted' as const },
  ];
  expect(redirectsText('default', rules, true)).toBe(
    '/old /new/ 301\n/old/ /new/ 301\n/brochure https://example.com/b.pdf 301\n/brochure/ https://example.com/b.pdf 301\n/gone / 301\n/gone/ / 301\n',
  );
  expect(redirectsText('default', rules.slice(0, 1), false)).toBe(
    '/old /new 301\n/old/ /new 301\n',
  );
  expect(redirectsText('default', [], true)).toBe('');
});

test('a rule appended re-points the rule that led to its old address', () => {
  const collapsed = collapseRedirects(
    [manual('/a', '/b', 'first')],
    [manual('/b', '/c', 'second')],
  );

  expect(collapsed).toEqual([manual('/a', '/c', 'first'), manual('/b', '/c', 'second')]);
});

test('a rule appended that sends an address back to itself drops the rule that moved it', () => {
  const collapsed = collapseRedirects([manual('/a', '/b', 'first')], [manual('/b', '/a', 'back')]);

  expect(collapsed).toEqual([manual('/b', '/a', 'back')]);
});

test('a rule appended whose destination already forwards lands where that forwards', () => {
  const collapsed = collapseRedirects(
    [manual('/b', '/c', 'first')],
    [manual('/a', '/b', 'second')],
  );

  expect(collapsed).toEqual([manual('/b', '/c', 'first'), manual('/a', '/c', 'second')]);
});

// A hand-edited file may hold a chain, or a loop, the admin would never have written.
test('a rule appended follows a hand-written chain to its end and never round a loop', () => {
  const chain = [manual('/b', '/c', 'first'), manual('/c', '/d', 'second')];

  expect(collapseRedirects(chain, [manual('/a', '/b', 'third')]).at(-1)).toEqual(
    manual('/a', '/d', 'third'),
  );
  expect(
    collapseRedirects([...chain, manual('/d', '/b', 'round')], [manual('/a', '/b', 'in')]).at(-1),
  ).toEqual(manual('/a', '/d', 'in'));
});

// An edit is the same write as an add, made in place.
test('a rule already in the file is re-collapsed where it stands', () => {
  const collapsed = collapseRedirects(
    [manual('/p', '/a', 'lead'), manual('/a', '/b', 'edited'), manual('/x', '/y', 'onward')],
    [manual('/a', '/x', 'edited')],
  );

  expect(collapsed).toEqual([
    manual('/p', '/y', 'lead'),
    manual('/a', '/y', 'edited'),
    manual('/x', '/y', 'onward'),
  ]);
});

// A hidden entry's rule is dropped again by its `entry`, so re-pointing it must keep that link.
test('a re-pointed rule keeps the entry it belongs to when the new rule names none', () => {
  const hidden = {
    ...RULE,
    _id: 'hidden01',
    from: '/listings/mill',
    to: '/listings',
    reason: 'hidden' as const,
    entry: 'listings/mill',
  };

  const collapsed = collapseRedirects([hidden], [manual('/listings', '/homes', 'second')]);

  expect(collapsed[0]).toEqual({ ...hidden, to: '/homes', entry: 'listings/mill' });
});

test('reading redirects from a repository that has never written one is no rules', async () => {
  const { git } = fakeGit({});

  expect(await readRedirects('default', git)).toEqual([]);
});

test('one rule taken out is a commit of redirects.yaml alone', async () => {
  const { git, published } = fakeGit({
    'src/content/redirects.yaml':
      '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/old"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n  - _id: "bbbbbbbb"\n    from: "/gone"\n    to: "/"\n    status: 302\n    reason: "manual"\n    createdAt: "2026-01-02T00:00:00Z"\n',
  });

  const result = await editRedirects('default', git, 'Delete redirect /gone', (rules) =>
    rules.filter((r) => r._id !== 'bbbbbbbb'),
  );

  expect(result).toEqual({ commit_sha: 'commit-B' });
  expect(published[0]?.message).toBe('Delete redirect /gone');
  expect(published[0]?.files.map((f) => f.path)).toEqual(['src/content/redirects.yaml']);
  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: 'aaaaaaaa',
      from: '/old',
      to: '/new',
      status: 301,
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
});

const site = {
  pages: { '/listings/harbour-flat': 'Harbour Flat' },
  rules: [manual('/summer-offer', '/listings', 'taken')],
};

test('an empty box is asked for rather than corrected', () => {
  expect(redirectError('default', { from: '  ', to: '/listings' }, site)).toEqual({
    field: 'from',
    message: 'An old address is needed.',
    descriptor: { code: 'REDIRECT_FROM_REQUIRED' },
  });
  expect(redirectError('default', { from: '/a', to: '' }, site)).toEqual({
    field: 'to',
    message: 'A destination is needed.',
    descriptor: { code: 'REDIRECT_TO_REQUIRED' },
  });
});

test('redirect sources are literal paths and slash variants share one address', () => {
  expect(redirectSourceError('/listings/*')).toContain('literal');
  expect(redirectSourceError('/listings/:slug')).toContain('literal');
  expect(redirectSourceError('/listings//harbour-flat')).toContain('normalized');
  expect(redirectSourceError('/listings/%2e%2e/admin')).toContain('normalized');
  expect(redirectSourceError('/listings/%2a')).toContain('literal');
  expect(
    redirectError('default', { from: '/listings/harbour-flat/', to: '/listings' }, site),
  ).toMatchObject({ descriptor: { code: 'REDIRECT_SHADOWS_PAGE' } });
  expect(redirectError('default', { from: '/summer-offer/', to: '/listings' }, site)).toMatchObject(
    { descriptor: { code: 'REDIRECT_FROM_EXISTS' } },
  );
});

test.each(['/admin', '/admin/api/drafts', '/_preview/home', '/_astro/app.js'])(
  'redirect source %s is reserved for the application',
  (from) => {
    expect(redirectError('default', { from, to: '/listings' }, site)).toMatchObject({
      descriptor: { code: 'REDIRECT_FROM_RESERVED' },
    });
  },
);

test('encoded paths and slash-normalized loops use their served address', () => {
  expect(
    redirectError('default', { from: '/listings/%68arbour-flat', to: '/listings' }, site),
  ).toMatchObject({ descriptor: { code: 'REDIRECT_SHADOWS_PAGE' } });
  expect(collapseRedirects([manual('/a', '/b/', 'one')], [manual('/b', '/a/', 'two')])).toEqual([
    manual('/b', '/a/', 'two'),
  ]);
});

test('redirect destinations may contain literal percent signs in queries or external paths', () => {
  for (const to of ['/offer?discount=10%', 'https://example.com/10%-off']) {
    expect(redirectError('default', { from: '/sale', to }, site)).toBeUndefined();
    expect(collapseRedirects([], [manual('/sale', to)])).toEqual([manual('/sale', to)]);
  }
});

test.each(['/sale?campaign=x', '/sale#details', '/offers/../sale', '/offers/%2e%2e/sale/'])(
  'a redirect cannot loop back through the destination %s',
  (to) => {
    expect(redirectError('default', { from: '/sale', to }, site)).toMatchObject({
      descriptor: { code: 'REDIRECT_SAME_ADDRESS' },
    });
  },
);

test('configured-base and build-time application paths cannot become redirects', () => {
  expect(
    redirectError(
      'default',
      { from: '/studio/%61dmin/api', to: '/listings' },
      { ...site, base: '/studio' },
    ),
  ).toMatchObject({ descriptor: { code: 'REDIRECT_FROM_RESERVED' } });
  expect(() => redirectsText('default', [manual('/admin/api', '/listings')], false)).toThrow(
    /reserved/,
  );
});

test('an old address that is not a path says so with the path it meant', () => {
  expect(redirectError('default', { from: 'summer-offer', to: '/listings' }, site)).toEqual({
    field: 'from',
    message: 'An address has to start with "/" — did you mean "/summer-offer"?',
    descriptor: { code: 'REDIRECT_FROM_SLASH', suggestion: '/summer-offer' },
  });
});

test('an old address given as a full web address is refused as one', () => {
  expect(
    redirectError('default', { from: 'https://example.com/x', to: '/listings' }, site)?.message,
  ).toBe('An old address is a path on this site, like "/summer-offer", not a full web address.');
});

test('an old address that is a real page names the page it would hide', () => {
  expect(
    redirectError('default', { from: '/listings/harbour-flat', to: '/listings' }, site),
  ).toEqual({
    field: 'from',
    message: 'This is a real page. A redirect here would hide Harbour Flat from visitors.',
    descriptor: { code: 'REDIRECT_SHADOWS_PAGE', page: 'Harbour Flat' },
  });
});

test('a rule that sends an address to itself is refused on the destination', () => {
  expect(redirectError('default', { from: '/a', to: '/a' }, site)).toEqual({
    field: 'to',
    message: 'This sends visitors back where they came from. Pick somewhere else.',
    descriptor: { code: 'REDIRECT_SAME_ADDRESS' },
  });
});

test('a second rule from an address that already has one is refused', () => {
  expect(redirectError('default', { from: '/summer-offer', to: '/other' }, site)?.message).toBe(
    'There is already a redirect from this address.',
  );
});

// Editing a rule reads its own `from` back, which is not a clash with itself.
test('a rule keeping its own old address is not refused as a duplicate', () => {
  expect(
    redirectError('default', { from: '/summer-offer', to: '/other' }, site, 'taken'),
  ).toBeUndefined();
});

test('a destination that is neither a path nor a web address is refused', () => {
  expect(redirectError('default', { from: '/a', to: 'listings' }, site)).toEqual({
    field: 'to',
    message:
      'A destination is a path on this site or a full web address — did you mean "/listings"?',
    descriptor: { code: 'REDIRECT_TO_INVALID', suggestion: '/listings' },
  });
});

test('a path and an absolute destination are both accepted', () => {
  expect(redirectError('default', { from: '/a', to: '/b' }, site)).toBeUndefined();
  expect(
    redirectError('default', { from: '/a', to: 'https://example.com/b.pdf' }, site),
  ).toBeUndefined();
});

test('redirect fields cannot contain whitespace or control characters', () => {
  for (const value of ['/old\n/shadow', '/old\r/shadow', '/old\t/shadow', '/old shadow']) {
    expect(redirectError('default', { from: value, to: '/new' }, site)).toEqual({
      field: 'from',
      message: 'An old address cannot contain spaces or control characters.',
      descriptor: { code: 'REDIRECT_FROM_WHITESPACE' },
    });
    expect(redirectError('default', { from: '/old', to: value }, site)).toEqual({
      field: 'to',
      message: 'A destination cannot contain spaces or control characters.',
      descriptor: { code: 'REDIRECT_TO_WHITESPACE' },
    });
  }
});

test('lifecycle redirects reject unsafe generated targets before they are stored or emitted', () => {
  expect(() =>
    redirectRule(
      'default',
      { from: '/old', to: '/new\n/shadow', status: 301, reason: 'slug-change' },
      Date.parse('2026-01-01T00:00:00Z'),
    ),
  ).toThrow('redirect destination cannot contain whitespace or control characters');

  expect(() =>
    redirectsText(
      'default',
      [manual('/old\n/shadow https://outside.example 302\n/another', '/new', 'unsafe')],
      true,
    ),
  ).toThrow('redirect source cannot contain whitespace or control characters');
});
