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

Hiding is a status selector in the entry header — never a field in the form — and a
**Hide** action on each row of the entry list, where checking several rows hides them
together. It is a normal draft-then-publish edit: one commit, like any other.

Because the page has been at its address for months, hiding asks **"Where should visitors
to this page go now?"** before it writes anything: the collection's overview, another page
picked from the list, a web address, or nowhere. The answer becomes one redirect rule per
language, from the address that language served, and it lands in `redirects.yaml` in the
same commit as `_status` ([Site files](site-files.md#redirectsyaml)). Showing the entry
again takes those rules back out, in the commit that puts the page back, so the page
returns to its own address.

One thing hiding does not undo: a rule that already pointed **at** this page — from an
older slug, say — was rewritten to the hide's target when it was hidden, so that nobody
following it hops twice, and it stays rewritten. That URL was the live one at the time.
Point it back at the page yourself if it matters.

"Nowhere" is an honest answer for a page nobody linked to: its address answers 404.

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
rule.

Deleting asks the same question hiding does — **"Where should visitors to this page go
now?"** — because the page has been at its address just as long: the collection's overview,
another page picked from the list, a web address, or nowhere. The delete commits now rather
than at the next publish, so the answer becomes `reason: "deleted"` rules with no `entry` in
the commit that removes the files. Turning off a language that has a file removes that one
file the same way and sends its readers to the collection's overview without asking — the
entry is not going anywhere, only that language's half of it
([Translating](translating.md#turning-a-language-off)). A collection without a `route` has no
URL and gets no rule.

**One rule per language whose URL moved**, under that language's own segment; a delete's
target is resolved per language too, so the German page goes to the German page that was
picked — or, where the picked page has no German half, to that collection's German overview
and then to `/de/`. On a
[`localizedSlugs`](configuration.md#localizedslugs) collection that URL is the `slug` in the
language's own file, so renaming the file writes no rule for a language that has one.

Both wait for whoever has the entry open. They commit every locale file at once, so a rename or
a delete under somebody else's edit would take the file they are typing into out from under
them; while a colleague holds the entry the action is refused and the answer names them.

Both commit first and write to the database second — git and D1 cannot share a transaction, and
the other order would leave an unpublished edit pointing at a file that was never moved. If the
request dies between the two, the draft row left at the old path is swept by a daily job
([Deploy](deploy.md#the-schedule)) once it is a day old, and the entry list already stops
showing it as soon as the build catches up.

From code, `renameEntry` and `deleteEntry` in `@handover/core` do this through the
`GitClient`:

```ts
const i18n = { locales: ['en', 'de'], defaultLocale: 'en' };
const listings = { collection: 'listings', route: '/listings/[slug]', index: '/', i18n };
await renameEntry('default', git, listings, 'seaview-cottage', 'seaview-cottage-devon');
// Where each language's readers go; `undefined` for a language, or for the argument, is nowhere.
await deleteEntry('default', git, listings, 'mill-house', (locale) =>
  locale === 'en' ? '/listings' : `/${locale}/listings`,
);
```

The rule shape, and how the build turns the file into `_redirects`, is in
[Site files](site-files.md#redirects), together with globals, navigation and templates.
