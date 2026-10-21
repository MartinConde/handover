# A page with an address per language

A collection with [`localizedSlugs`](configuration.md#localizedslugs) is not addressed by its
file name: `de/home.yaml` with `slug: startseite` is served at `/de/startseite` and no longer at
`/de/home`. The old address 301s from `_redirects`, which the assets layer serves before the
route runs.

The loader resolves the address with `entryAt()` rather than by id — the file name comes back
off the entry, for the switcher:

```ts
import { entryAt, getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt(source, cms, 'pages', locale, slug);
  if (!entry) return undefined;
  const name = entry.id.slice(locale.length + 1);
  return {
    data: entry.data,
    locale,
    locales: await getEntryLocales(source, cms, 'pages', name),
  };
}
```

A **prerendered** route is the same call: the address is what `getStaticPaths` put in the
params. One `getStaticPaths` per language, each in that language's own folder:

```astro
---
// src/pages/de/listings/[slug].astro
export async function getStaticPaths() {
  const { listings } = await loadIndex(staticSource, { locale: 'de' });
  return listings.map(({ address }) => ({ params: { slug: address } }));
}

const listing = await load(staticSource, { locale: 'de', slug: Astro.params.slug! });
if (!listing) throw new Error(`No listing de/${Astro.params.slug}`);
---
```

`entryAddress(entry.data, name)` is each address — the `slug` in the file, or the
file name. Never `entry.data.slug`: Astro puts a warning getter there on every entry without
one, and touching it logs on every render.

**A miss here is a bug and not a 404**, the one place the rule in [Loaders and pages](loaders.md#a-loader) is the other way round:
every path came from `getStaticPaths`, so `undefined` means the build disagrees with itself.
