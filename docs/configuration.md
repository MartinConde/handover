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
| `load` | no | The loader's name: `'post'` means `src/loaders/post.ts` ([Loaders and pages](loaders.md)). Preview needs it. |
| `titleField` | no | The field the entry list shows, when the collection is not keyed on `title`: `titleField: 'name'`. It is also the field "New entry" writes the name you type into, so it has to be a text field of this collection's schema — the build says so if it is not. |
| `localizedSlugs` | no | Each language may serve this collection's entries at a web address of its own. See below. |

## `i18n`

Required, a site with one language included. `locales` are the folder names under
`src/content/<collection>/` and `defaultLocale` is one of them; `prefixDefaultLocale` is
`false` unless you say otherwise. The same block goes in `astro.config.mjs` and the build
stops if the two disagree — the keys, the error and the folder layout are in
[Languages](i18n.md).

`translate` is optional and only for using something other than DeepL to
[machine-translate](translating.md#a-machines-first-draft): given the texts and the two
language codes, hand back the same texts translated, in the same order.

```ts
i18n: {
  locales: ['en', 'de'],
  defaultLocale: 'en',
  translate: async (texts, from, to) => myProvider.translate(texts, { from, to }),
}
```

Without it, `DEEPL_API_KEY` ([Deploying](secrets.md)) is what translates; without
either, the admin offers no machine translation at all.

## `localizedSlugs`

Off by default, and a per-collection call rather than a site-wide one: a blog wants a German
address for a German post, a listings grid keyed on a reference number does not.

```ts
collections: {
  posts: { schema: post, route: '/blog/[slug]', localizedSlugs: true },
}
```

The collection's schema declares the field the address is kept in, and it has to be optional:

```ts
export const post = z.object({ slug: z.string().optional(), title: z.string() /* … */ });
```

The collection also needs a `route`: an address is a segment of one, and without it nothing
renders the entry to serve at that address. Miss either and the build stops, the same way a bad
`titleField` does:

```
cms.config.ts › collections.posts.localizedSlugs: this collection's schema has no optional
"slug" text field — add slug: z.string().optional() to it, since the site's own route reads it
```

- **Empty falls back to the file name**, so turning it on changes no URL until someone fills
  one in. The file name is still the entry's id across the languages, and it does not change
  because an address did — renaming is the other action, with the other consequence
- The address is lowercase letters, digits and single dashes, never percent-encoded, and
  unique within its collection and language, drafts counted — a file name is spelled the same
  way for the same reason
- The collection's `glob` loader needs `generateId` so the id stays the file's path — Astro
  files an entry under its `slug` otherwise
  ([Template convention](template-convention.md#contentconfigts))
- Your own route resolves through `entryAt()` rather than by id, or — if it is prerendered —
  builds its paths from `entryAddress()`
  ([Loaders and pages](loaders.md#a-page-with-an-address-per-language))
- Publishing a change to an address that was live writes one `slug-change` redirect, for that
  language only ([Publishing](publishing.md#creating-renaming-and-deleting)) — the other languages' URLs did not move
- Off, a `slug` in a file is an ordinary field of that collection's schema like any other

## `globals`

One key per site-wide file under `src/content/globals/<locale>/`, mapping the file name
to its schema: `globals: { site, navigation }`. Keys are lowercase letters, digits and
dashes, and the key is the file name.

The admin lists them under **Site settings**, in the order they are declared. What each card
is called comes from the schema, so the client reads a name rather than a file name:

```ts
export const site = z
  .object({ name: z.string(), footerText: z.string() })
  .meta({
    label: 'Site details',
    description: 'The name, contact details and footer line every page carries',
  });
```

Without a `label` the card is headed by the key. Every declared global needs its file in the
default language — the build stops and names the one that is missing, since only you can write
the first one. See [Site files](site-files.md).

## `media`

Optional until an entry has a picture in it. `publicBase` is where the site's R2 bucket is
served from — the custom domain on it, no trailing path — and it is config rather than a
secret because the build resolves stored keys with it:

```ts
media: { publicBase: 'https://media.your-site.example' },
```

A content file stores `media/9f3a….webp` and never a URL, so changing this line moves every
picture on the site at once. The four env values that let the admin sign an upload are in
[Media](media.md#4-tell-the-site).

## `mailer`

Optional, and what the admin sends mail with — the settings screen's test email, and the emailed
sign-in link. Name a provider and the address it sends from; `from` is config, never a secret:

```ts
mailer: { provider: 'resend', from: 'Your Site <hello@your-site.com>' },
```

| `provider` | What the Worker needs |
|---|---|
| `'resend'` | `RESEND_API_KEY` |
| `'smtp'` | `SMTP_USER` and `SMTP_PASS`, plus `host` here (and `port`, if it is not `465`) |
| `'cloudflare'` | a `send_email` binding named `EMAIL`, and no secret at all |

Each needs a sending domain it may write from — [Sending email](email.md) has all three, and how
to prove one works. Anything else is a function of your own, given the message and answering with
the provider's id for it where there is one:

```ts
mailer: async ({ to, subject, text, html }) => {
  const { id } = await myProvider.send({ to, subject, text, html });
  return { id };
},
```

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
