# The language switcher

Which languages an entry can be read in, and the component that offers them. Declaring the
languages is [Languages](i18n.md); this page is drawing the switch on a page that is already
loaded.

## getEntryLocales() and <LocaleSwitcher />

`getEntryLocales()` answers which languages one entry can be read in — it has a file in that
language's folder and the file is not hidden — and where each one is served. It reads the
collections, so it costs the build no lookup of its own. Give it your `cms.config.ts`: the
languages and the collections' routes are all it takes.

```ts
// src/loaders/page.ts
import { getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export const locales = (source: Source, slug: string) =>
  getEntryLocales('default', source, cms, 'pages', slug);
```

```astro
---
// src/pages/de/[slug].astro
import LocaleSwitcher from 'astro-handover/LocaleSwitcher.astro';
import { load, locales, staticSource } from '../../loaders/page';

const slug = Astro.params.slug ?? '';
const data = await load(staticSource, { locale: 'de', slug });
---

<LocaleSwitcher locales={await locales(staticSource, slug)} current="de" />
```

The links come from the collection's `route` with the language's segment applied, so
`prefixDefaultLocale` is honoured and no template hardcodes `/de/`. They are written the way the
page being read is — with the trailing slash or without — so none is a hop through a redirect.
The language being read is a `<span aria-current="true">`, not a link.

An entry that can be read in one language draws **nothing** — a single button says nothing and
goes nowhere — so a site that declares one language never draws a switcher.

Each button is the language's code in capitals. For anything else — the language's own name, a
flag, a menu — call `getEntryLocales()` and write the markup yourself. One URL on its own is
`entryUrl('default', cms.i18n, '/[slug]', slug, 'de')`.

`getEntryLocales()` answers about an entry. A page that is not one — an index, a search, a
contact form — builds its own pair from the same rule:

```astro
---
// src/pages/index.astro
import { entryUrl } from 'astro-handover';
import LocaleSwitcher from 'astro-handover/LocaleSwitcher.astro';
import cms from '../../cms.config';

// `entryUrl` is undefined only for a collection with no route; '/' is one.
const locales = cms.i18n.locales.map((locale) => ({
  locale,
  url: entryUrl('default', cms.i18n, '/', '', locale)!,
}));
---

<LocaleSwitcher locales={locales} current="en" />
```
