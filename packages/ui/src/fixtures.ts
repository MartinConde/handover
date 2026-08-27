import { diffEntry, type Form } from '@handover/core';
import { mount } from 'svelte';
import Diff from './Diff.svelte';
import PagePicker, { type PickEntry } from './PagePicker.svelte';
import './tokens.css';

// Every shape the form can produce, so the page below shows what each one's diff reads like:
// the drawer shows one entry's, and this is all of them at once.
const everything: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['bedrooms'], label: 'Bedrooms', type: 'number', required: false, i18n: 'duplicate' },
    { path: ['available'], label: 'Available', type: 'boolean', required: false },
    { path: ['viewing'], label: 'Viewing', type: 'date', required: false },
    { path: ['status'], label: 'Status', type: 'select', required: false, options: ['for-sale'] },
    { path: ['agent'], label: 'Agent', type: 'reference', required: false, collection: 'team' },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false, accept: [] },
    { path: ['tour'], label: 'Tour', type: 'embed', required: false },
    { path: ['seo'], label: 'SEO', type: 'seo', required: false },
    { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
    { path: ['enquiry'], label: 'Enquiry', type: 'link', required: false },
    {
      path: ['address'],
      label: 'Address',
      type: 'group',
      required: false,
      fields: [{ path: ['street'], label: 'Street', type: 'text', required: false }],
    },
    {
      path: ['viewings'],
      label: 'Viewings',
      type: 'array',
      required: false,
      item: [{ path: ['note'], label: 'Note', type: 'text', required: false }],
    },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: false, types: ['hero', 'cta'] },
    {
      path: ['tags'],
      label: 'Tags',
      type: 'array',
      required: false,
      item: [{ path: [], label: '', type: 'text', required: true }],
    },
    { path: ['legacy'], label: 'Legacy', type: 'unsupported' },
  ],
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
  },
};

const hero = { _type: 'hero', _id: 'aaaa1111', heading: 'Seaview Cottage' };
const gallery = { _type: 'hero', _id: 'bbbb2222', heading: 'Gallery' };
const map = { _type: 'cta', _id: 'cccc3333', heading: 'Where it is' };
const signup = { _type: 'cta', _id: 'dddd4444', heading: 'Newsletter signup' };

const before = {
  _version: 1,
  title: 'Seaview Cottage',
  body: '## The house\n\nA slate terrace above the harbour.',
  price: 450000,
  bedrooms: 2,
  available: true,
  viewing: '2026-09-01',
  status: 'for-sale',
  agent: 'anna',
  brochure: { src: 'media/9f3a.pdf', name: 'Details' },
  tour: { url: 'https://vimeo.com/1', title: 'Walk through' },
  seo: { title: 'Seaview Cottage', description: 'Two bedrooms above the harbour' },
  image: { src: 'media/4b1d.webp', alt: 'The front of the house', width: 2400 },
  enquiry: { href: '/contact', label: 'Ask about this' },
  address: { street: 'Quay Road' },
  viewings: [{ note: 'Saturday morning' }, { note: 'Sunday afternoon' }],
  blocks: [hero, gallery, map],
  tags: ['sea view', 'terrace', 'parking'],
  legacy: [['a']],
};

const after = {
  ...before,
  title: 'Seaview Cottage, Devon',
  body: '## The house\n\nA west-facing slate terrace above the harbour.',
  price: 435000,
  bedrooms: 3,
  available: false,
  viewing: '2026-09-08',
  status: 'under-offer',
  agent: 'martin',
  brochure: { src: 'media/71c8.pdf', name: 'Full details' },
  tour: { url: 'https://vimeo.com/2', title: 'Walk through the garden' },
  seo: { title: 'Seaview Cottage, Devon', description: 'Three bedrooms above the harbour' },
  image: { src: 'media/4b1d.webp', alt: 'The front of the house from the quay', width: 2400 },
  enquiry: { href: '/contact', label: 'Ask us about this' },
  address: { street: 'Harbour Road' },
  viewings: [{ note: 'Saturday morning' }, { note: 'Sunday at four' }],
  blocks: [gallery, hero, signup],
  tags: ['sea view', 'roof terrace', 'parking'],
  legacy: [['b']],
};

const german = {
  _version: 1,
  _i18n: { sourceLocale: 'en', sourceBlob: '3f9c', sourceHash: '8f3a', translatedAt: 'earlier' },
  title: 'Seaview Cottage',
  price: 450000,
  bedrooms: 2,
  image: { src: 'media/4b1d.webp', alt: 'Vorderseite des Hauses', width: 2400 },
};

const cases: { name: string; groups: ReturnType<typeof diffEntry> }[] = [
  {
    name: 'Every field type, in one language',
    groups: diffEntry('demo', everything, { en: before }, { en: after }),
  },
  {
    name: 'Two languages — what they share is lifted out, and German did not move',
    groups: diffEntry(
      'demo',
      everything,
      { en: before, de: german },
      { en: after, de: { ...german, price: 435000, bedrooms: 3 } },
    ),
  },
  {
    name: 'A shared value that moved in the German file alone',
    groups: diffEntry(
      'demo',
      everything,
      { en: before, de: german },
      { en: before, de: { ...german, price: 435000 } },
    ),
  },
  {
    name: 'A translation that moved on its own',
    groups: diffEntry(
      'demo',
      everything,
      { en: before, de: german },
      { en: before, de: { ...german, image: { ...german.image, alt: 'Das Haus vom Kai aus' } } },
    ),
  },
];

const root = document.getElementById('fixtures');
if (!root) throw new Error('Diff fixtures: #fixtures missing');
for (const { name, groups } of cases) {
  const heading = document.createElement('h2');
  heading.textContent = name;
  const host = document.createElement('div');
  root.append(heading, host);
  mount(Diff, { target: host, props: { groups } });
}

// The picker in the three shapes the package opens it in. There is no admin behind this page,
// so its one request is answered here.
const OFFERED: PickEntry[] = [
  {
    collection: 'pages',
    path: 'pages/listings',
    title: 'Listings overview',
    locales: ['en', 'de'],
    urls: { en: '/listings', de: '/de/angebote' },
  },
  {
    collection: 'pages',
    path: 'pages/contact',
    title: 'Contact',
    locales: ['en', 'de'],
    urls: { en: '/contact', de: '/de/kontakt' },
  },
  {
    collection: 'listings',
    path: 'listings/seaview-cottage',
    title: 'Seaview Cottage',
    locales: ['en', 'de'],
    urls: { en: '/listings/seaview-cottage', de: '/de/angebote/seaview-cottage' },
  },
  {
    collection: 'listings',
    path: 'listings/mill-house',
    title: 'Old Mill House',
    locales: ['en'],
    urls: { en: '/listings/mill-house' },
  },
  {
    collection: 'agents',
    path: 'agents/jane-doe',
    title: 'Jane Doe',
    locales: ['en', 'de'],
    urls: {},
  },
  {
    collection: 'agents',
    path: 'agents/james-hartley',
    title: 'James Hartley',
    locales: ['en'],
    urls: {},
  },
];
window.fetch = async () => Response.json({ entries: OFFERED, locales: ['en', 'de'] });

const pickers = [
  {
    name: 'Everything, as a link field opens it',
    props: { collection: undefined, locale: undefined, onurl: undefined },
  },
  {
    name: 'Locked to one collection, as a reference field opens it',
    props: { collection: 'agents', locale: undefined, onurl: undefined },
  },
  {
    name: 'Addresses in German, as the rich text toolbar opens it — with a web address of its own',
    props: {
      collection: undefined,
      locale: 'de',
      onurl: (href: string) => console.log('url', href),
    },
  },
];
for (const { name, props } of pickers) {
  const heading = document.createElement('h2');
  heading.id = `pick-${props.collection ?? props.locale ?? 'all'}`;
  heading.textContent = name;
  const host = document.createElement('div');
  root.append(heading, host);
  mount(PagePicker, {
    target: host,
    props: {
      id: heading.id,
      label: 'pages and entries',
      labelId: heading.id,
      chosen: 'listings/mill-house',
      onpick: (entry: PickEntry) => console.log('picked', entry.path),
      onclose: () => {},
      ...props,
    },
  });
}
