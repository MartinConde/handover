import { expect, test } from 'vitest';
import { resolveSeo, SEO_DESCRIPTION_LIMIT, SEO_TITLE_LIMIT, seoMeter } from './seo.js';

const defaults = {
  titlePattern: '%s · Coastal Homes',
  description: 'Coastal homes in Devon.',
  image: { src: 'media/site-card.webp', alt: 'Coastal Homes', width: 1200, height: 630 },
  twitter: '@coastalhomes',
};

test('a search title that was typed is what the page says, pattern or no pattern', () => {
  const resolved = resolveSeo({ title: 'Move to the coast' }, defaults, 'Seaview Cottage');
  expect(resolved.title).toBe('Move to the coast');
});

test('a search title nobody typed is the page title in the site pattern', () => {
  expect(resolveSeo({}, defaults, 'Seaview Cottage').title).toBe('Seaview Cottage · Coastal Homes');
});

test('with no pattern the page title stands on its own', () => {
  expect(resolveSeo({}, { description: 'x' }, 'Seaview Cottage').title).toBe('Seaview Cottage');
});

test('the description and the social image fall back to the site defaults', () => {
  const resolved = resolveSeo({}, defaults, 'Seaview Cottage');
  expect(resolved.description).toBe('Coastal homes in Devon.');
  expect(resolved.image).toEqual(defaults.image);
});

test('the entry wins over the site for both', () => {
  const own = { src: 'media/9f3a2c7e.webp', alt: 'Front of the house', width: 2400, height: 1600 };
  const resolved = resolveSeo({ description: 'Above the harbour.', image: own }, defaults, 'x');
  expect(resolved.description).toBe('Above the harbour.');
  expect(resolved.image).toEqual(own);
});

test('nothing anywhere is nothing, not an empty string', () => {
  const resolved = resolveSeo(undefined, undefined, 'Seaview Cottage');
  expect(resolved).toEqual({ title: 'Seaview Cottage', noindex: false });
});

test('noindex is the entry’s own and is never inherited', () => {
  expect(resolveSeo({ noindex: true }, defaults, 'x').noindex).toBe(true);
  expect(resolveSeo({}, defaults, 'x').noindex).toBe(false);
});

test('a canonical URL is the entry’s own; the site has no default for it', () => {
  expect(resolveSeo({ canonical: 'https://example.com/a' }, defaults, 'x').canonical).toBe(
    'https://example.com/a',
  );
  expect(resolveSeo({}, defaults, 'x').canonical).toBeUndefined();
});

test('the twitter handle is the site’s alone', () => {
  expect(resolveSeo({}, defaults, 'x').twitter).toBe('@coastalhomes');
});

// A pattern is one substitution, so a client whose site name really contains "%s" keeps it.
test('only the first %s becomes the page title', () => {
  expect(resolveSeo({}, { titlePattern: '%s — %s' }, 'Home').title).toBe('Home — %s');
});

// A hand-edited file can hold an empty string where the panel would have written no key.
test('a search title emptied by hand falls back like one never typed', () => {
  expect(resolveSeo({ title: '' }, defaults, 'Seaview Cottage').title).toBe(
    'Seaview Cottage · Coastal Homes',
  );
});

test('the meter counts what is typed against the guidance length', () => {
  expect(seoMeter('Move to the coast', SEO_TITLE_LIMIT)).toBe('About 17 of ≈60 characters');
});

test('over the guidance length the meter says what happens, and still blocks nothing', () => {
  expect(seoMeter('x'.repeat(160), SEO_DESCRIPTION_LIMIT)).toBe(
    'About 160 of ≈155 characters — may be cut off',
  );
});

test('an empty field is guidance rather than a count of nothing', () => {
  expect(seoMeter('   ', SEO_TITLE_LIMIT)).toBe('Up to about 60 characters');
});
