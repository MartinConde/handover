# Configuration

`cms.config.ts` at the project root is the one file Handover reads about your site. It is
code: edit it in the repo, it is not editable from the admin. `astro.config.mjs` imports it
and hands it to the integration — `handover(cms)` — so the build reads it as well as the
admin ([Getting started](getting-started.md)). A mistake fails the build with a message
naming the key, for example
`cms.config.ts › collections.listings.route: expected a path starting with "/" containing "[slug]" once, like "/blog/[slug]", got "/listings"`.

```ts
// cms.config.ts
import { defineConfig, navigation } from 'astro-handover';
import { listing, page, site } from './src/content/schemas';

export default defineConfig({
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: {
    listings: { schema: listing, route: '/listings/[slug]', index: '/', load: 'listing' },
    pages: { schema: page, route: '/[slug]', load: 'page' },
  },
  globals: { site, navigation },
});
```

## `collections`

One key per folder under `src/content/`. The key is the folder name: lowercase letters,
digits and dashes.

| Key | Required | What it is |
|---|---|---|
| `schema` | yes | The collection's Zod object from `src/content/schemas.ts`. |
| `route` | no | The detail page's path with `[slug]` exactly once, e.g. `'/blog/[slug]'`. `[slug]` is the entry's filename without `.yaml`. Two collections cannot share a route. |
| `index` | no | The listing page, a fixed path with no `[...]` segment, e.g. `'/blog'`. Used wherever something links to "the blog" as a whole rather than to one entry. |
| `load` | no | The loader's name: `'post'` means `src/loaders/post.ts` ([Template convention](template-convention.md)). |
| `titleField` | no | The field the entry list shows, when the collection is not keyed on `title`: `titleField: 'name'`. It is also the field "New entry" writes the name you type into, so it has to be a text field of this collection's schema — the build says so if it is not. |

## `i18n`

Required, a site with one language included. `locales` are the folder names under
`src/content/<collection>/` and `defaultLocale` is one of them; `prefixDefaultLocale` is
`false` unless you say otherwise. The same block goes in `astro.config.mjs` and the build
stops if the two disagree — the keys, the error and the folder layout are in
[Languages](i18n.md).

## `globals`

One key per site-wide file under `src/content/globals/<locale>/`, mapping the file name
to its schema: `globals: { site, navigation }`. Keys are lowercase letters, digits and
dashes. See [Site files](site-files.md).

## Entry filenames

"New entry" derives the filename from the name you type — the collection's `titleField`
where it has one: transliterated (`ä → ae`, `é → e`, Cyrillic to Latin; other scripts are
dropped), lowercased, anything that is not a letter or digit becomes one dash, capped at
80 characters. An empty name gives `untitled`. If the name already exists in the collection
in any locale, `-2`, `-3`, … is appended. The name is never a random id so the file is
findable in GitHub by eye.

| Title | File |
|---|---|
| `Seaview Cottage` | `seaview-cottage.yaml` |
| `Größe über Fähre` | `groesse-ueber-faehre.yaml` |
| `Seaview Cottage` (again) | `seaview-cottage-2.yaml` |
