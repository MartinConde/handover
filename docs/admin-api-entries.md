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
GET /admin/api/entries/:collection          →  { "entries": [{ "id", "locales", "pending", "edited", "stale" }], "locales": ["en", "de"], "index": "/listings", "templates": ["house"] }
```

The collection's entries for the list screen: one row per entry, `id` is the filename and
`locales` maps each locale to `{ title, path }` plus `status: "hidden"` when it is hidden, and
`offered` is there when the entry is not offered in every language. The response's own
`locales` is the languages the site declares, in config order, and `index` the collection's
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
entry** is written in: the site default where the entry has that file, otherwise the first
language it does ([Translating](translating.md#choosing-a-language)). `offered` is the languages
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
POST /admin/api/entries/:collection         { "title": "…", "template": "house" }  →  { "slug" }
```

Creates an entry as a draft. `slug` is the derived filename, which is what the admin opens
next. Nothing is committed. `404` if the collection is not configured.

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
