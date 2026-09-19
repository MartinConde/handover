import type { Drift, Field, Form } from '@handover/core';
import type { SourceProblem } from './SourceRecovery.svelte';

// Six languages, the smallest set where the switcher is a select and the list overflows.
// Plain data only, so a core or route test can copy a variant without the UI runtime.

type Data = Record<string, unknown>;

/** Editor's `entry` prop, as `getEntry` answers it. */
export type SixLanguageEntry = {
  fields: Field[];
  blocks: Record<string, Field[]>;
  data: Data;
  pending: string[];
  published: string[];
  problems: { path: string; message: string }[];
  locales: string[];
  defaultLocale: string;
  sourceLocale: string;
  offered: string[];
  translations: Record<string, Data>;
  stale: string[];
  drift: Drift[];
  translator?: boolean;
};

/** One row of `GET /admin/api/entries/{collection}`. */
export type SixLanguageRow = {
  id: string;
  locales: Record<string, { title: string; path: string }>;
  offered?: string[];
  pending?: boolean;
  stale?: string[];
};

type Variant = {
  form: Form;
  /** Each language's effective file; a language with none is absent here, not empty. */
  files: Record<string, Data>;
  offered: string[];
  published: string[];
  pending: string[];
  /** What `staleLocales` answers over `files`, which is what the editor is sent. */
  stale: string[];
  /** What the last build saw, where a draft makes it differ from `stale`. */
  builtStale?: string[];
  translator?: boolean;
};

export const SIX = ['en', 'de', 'fr', 'it', 'es', 'nl'];
const FIVE = ['en', 'de', 'fr', 'it', 'es'];

const form: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['subtitle'], label: 'Subtitle', type: 'text', required: false },
    { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['body'], label: 'Body', type: 'blocks', required: true, types: ['hero'] },
  ],
  blocks: { hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }] },
};

// `sourceHash` of the English and German files below under `form`; any other hash reads stale.
const EN_HASH = 'af809e0fcc9aa132';
const DE_HASH = '8b6dae7a90d6a4e3';
const mark = (sourceLocale: string, sourceHash: string, translatedAt: string) => ({
  sourceLocale,
  sourceBlob: `${sourceLocale}-blob-0001`,
  sourceHash,
  translatedAt,
});

const price = '€180 per night';
const english = {
  title: 'Harbour House',
  price,
  notes: 'Key box code is in the owner handbook',
  body: [{ _type: 'hero', _id: 'hero0001', heading: 'Above the harbour' }],
};
const german = {
  title: 'Haus am Hafen',
  price,
  body: [{ _type: 'hero', _id: 'hero0001', heading: 'Über dem Hafen' }],
};
const french = {
  title: 'Maison du port',
  price,
  body: [{ _type: 'hero', _id: 'hero0001', heading: 'Au-dessus du port' }],
};
// What creating a translation writes: the structure and shared values, no text.
const created = { price, body: [{ _type: 'hero', _id: 'hero0001' }] };

const head = (source: string | undefined, offered: string[]) => ({
  _version: 1,
  ...(source ? { _source: source } : {}),
  ...(offered.length < SIX.length ? { _locales: offered } : {}),
});

const baseFiles = {
  en: { ...head('en', FIVE), ...english },
  de: {
    ...head('en', FIVE),
    _i18n: mark('en', EN_HASH, '2026-09-01T09:00:00.000Z'),
    ...german,
  },
  fr: {
    ...head('en', FIVE),
    _i18n: mark('en', 'a1b2c3d4e5f60718', '2026-06-01T09:00:00.000Z'),
    ...french,
  },
  it: { ...head('en', FIVE), ...created },
};
const base: Variant = {
  form,
  files: baseFiles,
  offered: FIVE,
  published: ['en', 'de', 'fr'],
  pending: ['it'],
  stale: ['fr'],
};

const variants = {
  /** English source; `de` answered, `fr` stale, `it` created and untouched, `es` missing, `nl` off. */
  base,
  /** `it` and `es` both offered with no file. */
  twoMissing: {
    ...base,
    files: { en: baseFiles.en, de: baseFiles.de, fr: baseFiles.fr },
    pending: [],
  },
  /** Written in German, English offered with no file, every language offered. */
  germanFirst: {
    form,
    files: { de: { ...head('de', SIX), ...german, notes: 'Der Code steht im Handbuch' } },
    offered: SIX,
    published: ['de'],
    pending: [],
    stale: [],
  },
  /** Two files and no `_source`: the source is inferred, default language first. */
  legacy: {
    form,
    files: {
      en: { ...head(undefined, SIX), ...english },
      de: {
        ...head(undefined, SIX),
        _i18n: mark('en', EN_HASH, '2026-09-01T09:00:00.000Z'),
        ...german,
      },
    },
    offered: SIX,
    published: ['en', 'de'],
    pending: [],
    stale: [],
  },
  /** Written in German; only the newest file, `fr`, says so, which outranks the default-first guess. */
  partlyMarked: {
    form,
    files: {
      en: {
        ...head(undefined, SIX),
        _i18n: mark('de', DE_HASH, '2026-08-01T09:00:00.000Z'),
        ...english,
      },
      de: { ...head(undefined, SIX), ...german, notes: 'Der Code steht im Handbuch' },
      fr: {
        ...head('de', SIX),
        _i18n: mark('de', DE_HASH, '2026-09-10T09:00:00.000Z'),
        ...french,
      },
    },
    offered: SIX,
    published: ['en', 'de', 'fr'],
    pending: [],
    stale: [],
  },
  /** `de` answered with two machine-translated fields. */
  machine: {
    ...base,
    files: {
      ...baseFiles,
      de: { ...baseFiles.de, _machine: ['title', 'body[_id=hero0001].heading'] },
    },
    translator: true,
  },
  /** English edited, German created and never touched: unpublished and missing its required title. */
  untouchedInvalid: {
    form,
    files: {
      en: { ...head('en', SIX), ...english, title: 'Harbour House, Kiel' },
      de: { ...head('en', SIX), ...created },
    },
    offered: SIX,
    published: ['en'],
    pending: ['en', 'de'],
    stale: [],
  },
  /** `fr` is stale and has lost its heading, so it is also partly written. */
  staleAndPartial: {
    ...base,
    files: {
      ...baseFiles,
      fr: { ...baseFiles.fr, body: [{ _type: 'hero', _id: 'hero0001' }] },
    },
  },
  /** An English draft adds a subtitle; no other file has a draft, so `de` now owes it. */
  sourceDraft: {
    ...base,
    files: { ...baseFiles, en: { ...baseFiles.en, subtitle: 'Sleeps six, dogs welcome' } },
    pending: ['en', 'it'],
    stale: ['de', 'fr'],
    builtStale: ['fr'],
  },
  /** Text in groups, rows, scalar lists, blocks and every structured prop that is translated. */
  structured: {
    form: {
      fields: [
        { path: ['title'], label: 'Title', type: 'text', required: true },
        { path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' },
        {
          path: ['details'],
          label: 'Details',
          type: 'group',
          required: false,
          i18n: 'duplicate',
          fields: [
            { path: ['sleeps'], label: 'Sleeps', type: 'number', required: false },
            { path: ['caption'], label: 'Caption', type: 'text', required: false, i18n: true },
          ],
        },
        {
          path: ['rooms'],
          label: 'Rooms',
          type: 'array',
          required: false,
          item: [{ path: ['name'], label: 'Name', type: 'text', required: true }],
        },
        {
          path: ['features'],
          label: 'Features',
          type: 'array',
          required: false,
          item: [{ path: [], label: '', type: 'text', required: true }],
        },
        { path: ['photo'], label: 'Photo', type: 'image', required: false, preset: {} },
        {
          path: ['brochure'],
          label: 'Brochure',
          type: 'file',
          required: false,
          accept: ['application/pdf'],
        },
        { path: ['video'], label: 'Video', type: 'embed', required: false },
        { path: ['seo'], label: 'SEO', type: 'seo', required: false },
        { path: ['body'], label: 'Body', type: 'blocks', required: false, types: ['cta'] },
      ],
      blocks: {
        cta: [
          { path: ['heading'], label: 'Heading', type: 'text', required: true },
          { path: ['button'], label: 'Button', type: 'link', required: false },
        ],
      },
    },
    files: {
      en: {
        ...head('en', FIVE),
        title: 'Harbour House',
        summary: '**Quiet** rooms above the harbour.',
        details: { sleeps: 6, caption: 'Sleeps six' },
        rooms: [
          { _id: 'room0001', name: 'Harbour room' },
          { _id: 'room0002', name: 'Garden room' },
        ],
        features: ['Sea view', 'Log burner'],
        photo: { src: 'media/harbour.webp', alt: 'The harbour at dusk' },
        brochure: { src: 'files/brochure.pdf', name: 'Harbour House brochure.pdf' },
        video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Walk through the house' },
        seo: {
          title: 'Harbour House holiday let',
          description: 'A quiet house above the harbour.',
          image: { src: 'media/harbour.webp', alt: 'The harbour at dusk' },
        },
        body: [
          {
            _type: 'cta',
            _id: 'cta00001',
            heading: 'Book your stay',
            button: { type: 'url', href: 'https://example.com/book', label: 'Book now' },
          },
        ],
      },
      de: {
        ...head('en', FIVE),
        title: 'Haus am Hafen',
        summary: '**Ruhige** Zimmer über dem Hafen.',
        details: { sleeps: 6, caption: 'Für sechs Personen' },
        rooms: [
          { _id: 'room0002', name: 'Gartenzimmer' },
          { _id: 'room0001', name: 'Hafenzimmer' },
        ],
        features: ['Meerblick', 'Kaminofen'],
        photo: { src: 'media/harbour.webp', alt: 'Der Hafen in der Dämmerung' },
        brochure: { src: 'files/brochure.pdf', name: 'Haus am Hafen Broschüre.pdf' },
        video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Rundgang durch das Haus' },
        seo: {
          title: 'Ferienhaus am Hafen',
          description: 'Ein ruhiges Haus über dem Hafen.',
          image: { src: 'media/harbour.webp', alt: 'Der Hafen in der Dämmerung' },
        },
        body: [
          {
            _type: 'cta',
            _id: 'cta00001',
            heading: 'Jetzt buchen',
            button: { type: 'url', href: 'https://example.com/book', label: 'Buchen' },
          },
        ],
      },
    },
    offered: FIVE,
    published: ['en', 'de'],
    pending: [],
    stale: [],
  },
} satisfies Record<string, Variant>;

export type SixLanguageVariant = keyof typeof variants;
export const SIX_LANGUAGE_VARIANTS = Object.keys(variants) as SixLanguageVariant[];

// Every call is a deep copy, so one test's typing never reaches the next test's entry.
const variant = (name: SixLanguageVariant): Variant => structuredClone(variants[name]);

/** The source each variant resolves to by the rules of `entrySource`, worked out by hand. */
export const SIX_LANGUAGE_SOURCES: Record<SixLanguageVariant, string> = {
  base: 'en',
  twoMissing: 'en',
  germanFirst: 'de',
  legacy: 'en',
  partlyMarked: 'de',
  machine: 'en',
  untouchedInvalid: 'en',
  staleAndPartial: 'en',
  sourceDraft: 'en',
  structured: 'en',
};

/** The effective files, form and offer, for core and route tests. */
export function sixLanguageFiles(name: SixLanguageVariant = 'base') {
  const { form, files, offered } = variant(name);
  return { form, files, offered };
}

/** `show(sixLanguages('base'))` opens the editor on the variant, as `getEntry` would answer it. */
export function sixLanguages(name: SixLanguageVariant = 'base'): { entry: SixLanguageEntry } {
  const v = variant(name);
  const source = SIX_LANGUAGE_SOURCES[name];
  return {
    entry: {
      ...v.form,
      data: v.files[source] as Data,
      translations: Object.fromEntries(
        Object.entries(v.files).filter(([locale]) => locale !== source),
      ),
      pending: v.pending,
      published: v.published,
      problems: [],
      locales: [...SIX],
      defaultLocale: 'en',
      sourceLocale: source,
      offered: v.offered,
      stale: v.stale,
      drift: [],
      ...(v.translator ? { translator: true } : {}),
    },
  };
}

/** The list rows for the variants, each under its own name, in the order they are declared. */
export function sixLanguageRows(): SixLanguageRow[] {
  const rows = SIX_LANGUAGE_VARIANTS.map((name) => {
    const v = variant(name);
    return {
      id: name,
      locales: Object.fromEntries(
        Object.entries(v.files).map(([locale, data]) => [
          locale,
          {
            title: typeof data.title === 'string' ? data.title : '',
            path: `src/content/listings/${locale}/${name}.yaml`,
          },
        ]),
      ),
      ...(v.offered.length < SIX.length ? { offered: v.offered } : {}),
      ...(v.pending.length ? { pending: true } : {}),
      ...((v.builtStale ?? v.stale).length ? { stale: v.builtStale ?? v.stale } : {}),
    };
  });
  const conflict = sourceConflict();
  return [...rows, { id: 'sourceConflict', locales: conflict.row }];
}

/** Two files naming different sources: the entry refuses to open and draws `SourceRecovery`. */
export function sourceConflict() {
  const files: Record<string, Data> = {
    en: { ...head('en', SIX), ...english },
    de: { ...head('de', SIX), ...german },
  };
  const problem: SourceProblem = {
    code: 'ENTRY_SOURCE_CONFLICT',
    marks: { en: 'en', de: 'de' },
    files: ['en', 'de'],
    offered: [...SIX],
  };
  const row = {
    en: { title: english.title, path: 'src/content/listings/en/sourceConflict.yaml' },
    de: { title: german.title, path: 'src/content/listings/de/sourceConflict.yaml' },
  };
  return { form: structuredClone(form), files: structuredClone(files), problem, row };
}
