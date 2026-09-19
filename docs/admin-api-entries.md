# The admin API — entries

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Reading

A collection, an entry and its history; creating one and giving a language its own address.
The changes that commit — a rename, a delete, a language turned off, hiding — are
[entry lifecycle](admin-api-lifecycle.md).

```
GET /admin/api/entries                      →  { "entries": [{ "collection", "path", "title", "locales", "urls", "hidden" }], "indexes": [{ "collection", "index": true, "path", "title", "locales", "urls" }], "locales": ["en", "de"], "defaultLocale": "en" }
```

Everything an editor can point at, across every collection the site declares, in config
order. `path` is `collection/slug` — what a `reference` and an entry `link` store — `locales`
is the languages that entry has a file in, and `urls` is the address each of them serves it
at, empty for a collection with no `route`. `hidden` is whether the entry is off the site,
which the picker says on the row rather than dropping it. It is what the page picker lists,
wherever the picker appears.

```
GET /admin/api/entries/:collection          →  { "entries": [{ "id", "locales", "pending", "edited", "stale", "partial", "machine" }], "locales": ["en", "de"], "defaultLocale": "en", "index": "/listings", "templates": ["house"] }
```

The collection's entries for the list screen: one row per entry, `id` is the filename and
`locales` maps each locale to `{ title, path }` plus `status: "hidden"` when it is hidden, and
`offered` is there when the entry is not offered in every language. The response's own
`locales` is the languages the site declares, in config order, `defaultLocale` the one of them a
new entry is written in unless another is chosen, and `index` the collection's
page above them, which is where the hide dialog offers to send a hidden entry's readers.
Titles come from the field the collection is keyed on — `title`, or its
[`titleField`](configuration.md#collections); an entry that has not filled it in lists by
filename. The list is the build's [content index](publishing.md#the-content-index) with the pending
drafts laid over it, so an entry you have edited but not published shows what you typed.
It reads nothing from GitHub. `pending` is there on an entry that has unpublished changes,
which is what the duplicate dialog asks its question about, and `templates` names the
[starters](site-files.md#templates) this collection ships. `edited` is who last touched the
entry — `{ at, by, kind }`, where `kind` is `"edit"` for a draft nobody has published and
`"publish"` for the commit that carried the last one out — and `null` when the activity log
goes back no further. `stale` names the languages the last build found translated from a
source that has moved on since, and is absent where there are none.
`partial` maps each language whose file answers only some of the source's text to
`[written, of]` (`{ "de": [3, 5] }`), and `machine` names the languages whose file still holds
machine-translated text. Both are counted from the build with the pending drafts over it, so a
new translation or an edit to the source shows at once, while `stale` waits for the next build;
a language can be both stale and partial. A missing, complete or turned-off language is not in
`partial`, and both are absent where there are none, or where the entry's files disagree about
its [source language](source-language.md).

```
GET /admin/api/entries/:collection/:slug  →  { fields, blocks, data, translations, pending, problems, hidden, redirects, titleField, locales, defaultLocale, sourceLocale, offered, drift, stale, translator, route, index, prefixDefaultLocale }
```

`data` is the draft when there is one, otherwise the file. `pending` is the entry's languages
whose draft is ahead of the repository, in config order: `[]` when nothing of it is waiting,
`["en"]` when `data` is a draft, `["de"]` when a translation is drafted and the default
language is not — the editor offers **Publish…** whenever it is not empty. It is a list of
locales here and the `true`/`false` of one file in the [draft writes](admin-api-drafts.md). `problems` is the
same list the autosave answers with, so an entry names what is missing the moment it opens.
`hidden` is whether the entry is off the site, and `redirects` — present only when it is — maps
each language to the address its readers are sent to meanwhile, absent for a language whose
answer was "nowhere". `titleField` is there when the collection declares one, and is the
field the editor's heading reads. `data` is `sourceLocale`'s file and `translations` the other
languages the entry has a file in, keyed by locale — what the editor's second column draws.
`locales` is the languages the site declares, in config order, `defaultLocale` the site's own —
which is what says whose URLs carry a language segment — and `sourceLocale` the language **this
entry** is written in: the `_source` its files record, or for an older entry that records none,
the site default where the entry has that file, otherwise the first language it does
([Languages](i18n.md#which-language-an-entry-is-written-in)). `offered` is the languages
this entry is offered in — the rest are turned off for it. `drift` is the blocks the entry's
languages disagree about, `[{ "path": "blocks[_id=z9y8x7w6]", "type": "quote", "in": ["de"],
"expected": ["en", "de"], "values": { "de": ["Ein seltener Fund."] } }]`, and `stale` the
languages whose translation was made from a source language that has moved on since
([Translating](machine-translation.md#when-the-source-language-moves-on)). Both are empty on a site with
one language, which reads nothing for them. `translator` is whether the site has anything to
machine-translate with: false, and none of the buttons that offer it is drawn. `route`, `index`
and `prefixDefaultLocale` are where the site serves the collection, which is what the editor
builds a URL out of: the address row, and the URL it names when a language is turned off. A
collection with no `route` has neither, and both are absent from the response.

### Which language an entry is written in

When an entry's files disagree about their `_source`, this route, the draft writes, **Create
from English**, machine translation, turning a language off, a web address, the hold, hiding and
showing, answering drift, rename and duplicate answer
`409` with an `x-handover-error-code` header and
`{ "code", "error", "marks", "files", "offered" }`, and write nothing. `marks` is what each file
says, by locale, `files` the languages the entry has a file in, and `offered` the languages it is
offered in, as the first of those files names them. Deleting the entry, discarding its
unpublished changes and [choosing a source](#changing-the-language-an-entry-is-written-in) stay
open, since each can be the way out.

| `code` | The files |
|---|---|
| `ENTRY_SOURCE_CONFLICT` | name two or more different languages |
| `ENTRY_SOURCE_UNDECLARED` | name a language the site does not declare |
| `ENTRY_SOURCE_MISSING` | name a language the entry has no file in |

Make the files agree in the repository and reopen the entry, or
[choose a source](#changing-the-language-an-entry-is-written-in). The editor shows what each file
says in place of the form ([The source language](source-language.md#when-the-files-disagree-about-the-source-language)),
and the pre-publish checks hold the entry back with the error `source-unresolved`.

### Changing the language an entry is written in

```
POST /admin/api/entries/:collection/:slug/source   { "locale": "de", "tab": "…", "revisions": { "en": "…", "de": "…" } }  →  { "source": "de" }
```

Makes `locale` the language the entry is written in. `revisions` is the map the entry's `GET`
answered and `tab` the one the lock was taken with. Every file of the entry is written as a
draft in one step: each gets `_source: de`, German takes English's shared and source-only values
row by row and loses its `_i18n`, and English keeps every word, its source-only values included.
Nothing is committed: the site and the build keep English until the entry is published, and it
publishes whole. Discarding the entry's unpublished changes undoes it. What happens to the
translations' marks is on [Machine translation](machine-translation.md#when-the-source-language-changes).
The activity log records `entry-source` with `{ "from", "to" }`.

A refusal writes nothing. Those with a `code` carry it in `x-handover-error-code` too, as
`{ "code", "error" }`:

| Status | `code` | When |
|---|---|---|
| `401` | | Nobody is signed in |
| `409` | | Somebody else holds the entry's lock; the body is a save's `held_by` |
| `404` | | There is no such entry |
| `400` | `ENTRY_SOURCE_TARGET_UNDECLARED` | The site does not declare `locale` |
| `409` | `ENTRY_SOURCE_UNCHANGED` | The entry is already written in it |
| `409` | `ENTRY_SOURCE_TARGET_OFF` | The entry is not offered in it |
| `409` | `ENTRY_SOURCE_TARGET_MISSING` | The entry has no file in it yet |
| `409` | `ENTRY_SOURCE_REVISION` | A file changed since `revisions` was read; reopen the entry |
| `409` | `ENTRY_SOURCE_DRIFT` | The languages disagree about the blocks; answer the drift first |
| `409` | `ENTRY_SOURCE_ONLY_CONFLICT` | The language has its own value in a field only the source keeps, and `paths` names them |
| `422` | `ENTRY_SOURCE_TARGET_INVALID` | With the source's values it would fail the schema; `problems` is a save's |

On an entry whose files disagree about `_source` the same route is how a source is chosen: any
declared language the entry is offered in and has a file in. `revisions` can be left out, since
the entry never opened; drift and the schema are not checked, nothing is taken from another file
and no mark moves.

```
GET /admin/api/globals  →  { "globals": [{ "key", "label", "description", "locales", "pending" }], "locales": ["en", "de"] }
```

The Site settings list: one card per global `cms.config.ts` declares, in that order. `label`
and `description` come from the schema's own `.meta()` and fall back to the key; `locales` is
the languages this global has a file in — drafted counts — and `pending` says whether any of
them is ahead of the repository. The response's `locales` is the languages the site declares.
Like the entry list it reads the content index and the draft rows, and nothing from GitHub.

A global itself is read and written through the entry routes above: `GET
/admin/api/entries/globals/site` answers the same body with `singleton: true` and the `label`
on it, and with no `route`, `index` or `localizedSlugs` — there is no page of its own to link
to. The drafts, translation, lock, hold and publish routes take it unchanged. What it is
refused is what a collection's routes are for: create, rename, delete, address and turning a
language off ([entry lifecycle](admin-api-lifecycle.md)) all answer `404`.

```
POST /admin/api/entries/:collection         { "title": "…", "template": "house", "locale": "de" }  →  { "slug" }
```

Creates an entry as a draft. `slug` is the derived filename, which is what the admin opens
next. Nothing is committed. `404` if the collection is not configured.

`locale` is optional and names the language to write the entry in: its file goes in that
language's folder and, on a site with two or more languages, records it as the entry's
[`_source`](i18n.md#which-language-an-entry-is-written-in). Left out, the entry starts in the
site's default language. `400`, with nothing written, when it names a language the site does not
declare.

`template` is optional and names one of the collection's [starters](site-files.md#templates);
without it the entry starts empty apart from its title. The starter's values are copied in, its
blocks and array rows are given fresh `_id`s, and the title typed into the dialog wins over the
one the starter carries. `404` if the collection ships no starter under that name.

```
POST /admin/api/entries/:collection/:slug/address/:locale   { "address": "…" }  →  {}
```

The address one language serves the entry at, written into that language's draft. Empty takes
the key out and leaves the file name to serve it. `404` on a collection without
`localizedSlugs`, on a language the site does not declare, and on an entry with no file in
that language; `422` when the address is not one; `409` when another entry in the collection
already answers to it in that language, its file name counted.

## History

```
GET /admin/api/history/:collection/:slug?page=1  →  { "versions": [ … ], "more": false }
```

The entry's git log, merged across its language files: one entry of `{ "sha", "date",
"summary", "locales", "author", "name" }` per commit, newest first, with `locales` the languages
that commit touched and `summary` the commit's first line. `author` is the person the [activity
log](activity.md) recorded against that commit, falling back to git's own author and absent
where the commit is the GitHub App's — the App is what makes them, so git names it rather than
the editor. Nothing is stored: every open is a read of GitHub.

The log follows the entry back through a rename the admin made: the commit that started the
current file's log is that rename, and its message names the old file, so the list carries on
under it — up to three renames back. A version from before one carries `name`, the file name
the entry had then; a rename made by hand in the repository is not followed.

Paged at 30 per language file. `more` says GitHub still had older ones; the next page is read
from the top again rather than carried on, because the merge cuts the list where the shallowest
page ends — a commit that touched only the German file can sit between two pages of the English
one. `page` is capped at 10. `404` when the collection is not configured; `503` when the
repository is out of reach.

```
GET /admin/api/history/:collection/:slug/diff?to=<sha>&from=<sha>  →  { "groups": [ … ] }
```

What the version named by `to` says that the one named by `from` does not, in the same
[per-field diff](pending-changes.md) the drawer draws. Without `from` the other side is the
branch as it is now, so what is marked is what restoring `to` would change. A version from
before a rename is read under the `name` the list gave it — `&name=` for `to`, `&fromName=`
for `from`. `400` when either is not a commit, or a name is not one.

```
POST /admin/api/history/:collection/:slug/restore   { "commit_sha", "name" }  →  { "paths": [ … ] }
```

That version back as unpublished changes, one draft row per language it has a file in. **Git is
never rewritten**: the rows go into the editor and publishing them is the ordinary forward
commit, so the version being restored — and everything after it — stays in the list. `name` is
the version's from the list, where it has one: the files are read under it and written under
the name the entry has now, so a restore never moves the entry back.

Three keys are the entry's as it stands now rather than the version's: `slug`, `_status` and
`_locales`. Each of them is set by a route that commits redirect rules beside it, so an old
value here would move the page's address, take it off the site or put a language back with none
of the rules that owes. A language the version has no file for is left alone, and one whose file
has gone since is not brought back. A restored version whose `_version` is older than this
package's is migrated in memory on the way.

`400` when `commit_sha` is not a commit; `409` when that version has no file of the entry, when
somebody else has the entry open, or when the file was written by a newer package than this one;
`404` when the collection is not configured.

Opening an entry also returns `revisions`, a locale-to-opaque-version map. GET seeds the displayed
file and its immutable Git base atomically when no draft exists. Send the corresponding revision
on each autosave and use the versions returned by that save for subsequent requests.
