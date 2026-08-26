# Entry lifecycle

What happens to an entry's files after they exist: hiding it from the site, creating one,
renaming it and deleting it. The shape of the files themselves is
[Content format](content-format.md).

## Hiding an entry

```yaml
_version: 1
_status: "hidden"
title: "Seaview Cottage"
```

The file stays in the repo and in the admin, and the site ignores it when your loaders
use `filterLive` (see [Rendering content](rendering.md#hidden-entries)).

## Creating an entry

"New entry" asks for a title and derives the filename from it
([Configuration](configuration.md#entry-filenames)). The file itself is not written until
the entry is published for the first time — until then it is a draft in D1, so the
filename can still change and an abandoned entry leaves nothing behind. After the first
publish, changing the filename is the rename below.

## Renaming and deleting an entry

The filename is the entry's id across locales, so a rename moves every locale file in one
commit. Because the URL comes from the filename, the same commit appends a redirect to
`src/content/redirects.yaml` (created if missing):

```yaml
_version: 1
rules:
  - _id: "m4n5o6p7"
    from: "/listings/seaview-cottage"
    to: "/listings/seaview-cottage-devon"
    status: 301
    reason: "slug-change"
    entry: "listings/seaview-cottage-devon"
    createdAt: "2026-08-20T10:14:00Z"
```

Renaming twice keeps the oldest URL pointing at the newest name; renaming back removes the
rule. Deleting an entry removes every locale file in one commit and, when the editor chose
where visitors should go, appends a `reason: "deleted"` rule with no `entry`; turning off a
language that has a file removes that one file the same way, with the same rule for the URL
it served ([Translating](translating.md#turning-a-language-off)). A collection without a
`route` has no URL and gets no rule.

**One rule per language whose URL moved**, under that language's own segment; a delete's
target is served under it too, so the German page goes to the German index. On a
[`localizedSlugs`](configuration.md#localizedslugs) collection that URL is the `slug` in the
language's own file, so renaming the file writes no rule for a language that has one.

From code, `renameEntry` and `deleteEntry` in `@handover/core` do this through the
`GitClient`:

```ts
const i18n = { locales: ['en', 'de'], defaultLocale: 'en' };
const listings = { collection: 'listings', route: '/listings/[slug]', index: '/', i18n };
await renameEntry('default', git, listings, 'seaview-cottage', 'seaview-cottage-devon');
await deleteEntry('default', git, listings, 'mill-house', '/'); // undefined = no redirect
```

The rule shape, and how the build turns the file into `_redirects`, is in
[Site files](site-files.md#redirects), together with globals, navigation and templates.
