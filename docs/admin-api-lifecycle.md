# The admin API — entry lifecycle

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Changes that commit

A rename, a delete, a copy, a language turned off and an entry taken off the site, and reading
back what was deleted. Reading an entry is [entries](admin-api-entries.md).

```
POST /admin/api/entries/:collection/:slug/rename   { "to": "…" }  →  { "slug", "commit_sha" }
```

One commit moving every locale file, plus one redirect per language whose URL moved. `to`
goes through the same derivation as a new entry's title, so `slug` in the answer is the name
that was actually used. `409` if the entry has never been published, and `409` naming the
colleague if somebody else holds its lock.

```
DELETE /admin/api/entries/:collection/:slug   { "redirect": { "kind": "index" } }  →  { "commit_sha" }
```

One commit removing every locale file, with the entry's draft dropped and its lock let go. The
answer is `{}` when nothing was committed — the entry existed only as a draft, or not at all.
`409` naming the colleague if somebody else holds its lock.

`redirect` is the answer to the same question a hide asks, in the same four shapes as the
status route below it, and it becomes one `reason: "deleted"` rule per language **in this commit**
— a delete does not wait for a publish. No body at all is `{ "kind": "index" }`, the
collection's own page above it.

```
POST /admin/api/entries/:collection/:slug/duplicate   { "to": "…", "drafts": true }  →  { "slug" }
```

Copies every locale file of the entry under a new name, as drafts — nothing is committed, so
the copy can be abandoned the way a new entry can. Every `_id` is regenerated with one map
shared across the languages, so the copy is still one entry with a matching skeleton; the
staleness marks are dropped and the copy is written `_status: "hidden"`, so it cannot go live
by accident. The address stays with the original, and the copy answers at its own filename.

`to` is optional and defaults to `<slug>-copy`; it goes through the same derivation as a new
entry's title, so `slug` in the answer is the name that was actually used. `drafts: true` copies
the unpublished bytes of every language that has them instead of the committed file. `409` if
the entry has never been published — there is nothing in the repository to copy.

```
POST /admin/api/entries/:collection/:slug/locales  { "locales": ["en"], "redirect": { "kind": "index" } }  →  {}
```

The languages the entry is offered in, written as `_locales` into every file it has — or taken
out again when they are all of them. No file is written for a language left out, which is the
point of it.

Leaving out a language that **has** a file deletes that file, so this one commits where the rest
of the editor drafts: one commit removes it, writes the mark into the files that stay and appends
the redirect its URL owes, to where `redirect` says — the same four shapes a hide takes, resolved
per language the same way. Without a `redirect` its readers go to the collection's `index` under
that language's own segment, and nowhere when the collection has none. An `_i18n` naming a language that went is dropped from the
files that carry it, and unpublished changes to a language that goes are dropped with its file.
A language whose file is only a draft is not in the repository, so it makes no commit and no
redirect: the draft is thrown away and the mark is drafted like any other.

`409` when the entry would be left with no published file — that is deleting the entry, which is
what `DELETE` is for, and a language whose file is only a draft does not stand in for one that is
published; `404` when the entry has no file at all.

```
POST /admin/api/status/:collection   { "entries": ["mill-house"], "hidden": true, "redirect": { "kind": "index" } }  →  {}
```

On the site or off it, for one entry or for a batch. `_status: hidden` is written into every
file the entry has — it is the entry's and not one language's — and every entry named takes the
same answer, which is what a bulk hide is. `409` naming the colleague if somebody else holds
the lock on any of them, before anything is written.

`redirect` says where the readers of a page coming off the site go, and the rules it produces
are **one per language**, from the address that language served: `{ "kind": "index" }` is the
collection's own page above it, `{ "kind": "entry", "value": "listings/harbour-flat" }` another
entry — a language that entry has no page in falls back to *its* collection's `index` and then
to `/` — `{ "kind": "url", "value": "https://…" }` one address for every language, and
`{ "kind": "none" }` nothing at all. A language with no file in the repository owes nothing:
nobody has followed an address it never served.

Nothing is committed. The rules wait on the draft rows with the `_status` that made them owed,
and the publish that takes the entry off the site carries both — so a client who hides and then
shows an entry again before publishing owes nothing. Showing an entry that was **published**
hidden takes those rules out of `redirects.yaml` in the commit that puts the page back.
`hidden: false` needs no `redirect` and ignores one. `400` with no entries named; `404` if the
collection is not configured.

```
GET /admin/api/deleted/:collection  →  { "deleted": [ … ] }
```

What the admin removed from that collection, newest first — the **Deleted** tab's rows, read
from the activity log rather than from the content index, since a deleted entry is in neither
the index nor the draft rows. Each is `{ "id", "at", "by", "slug", "locales", "whole",
"commit_sha" }`: `whole` is `false` for a language turned off, `locales` the languages that
went, `by` the person's name or `null` for the system. A row that cannot be put back also
carries `blocked`, a sentence naming the path that is occupied again. Only rows with a commit
behind them are listed — an entry deleted before it was ever published made none. `404` when
the collection is not configured.

## Redirects

The table over `src/content/redirects.yaml` ([Redirects](redirects.md)). These
three **commit as they are called**: the file is assembled at publish out of the rules of the
selected entries, so a rule belonging to no entry has nowhere to wait.

```
GET /admin/api/redirects  →  { "rules": [{ "_id", "from", "to", "status", "reason", "entry", "createdAt", "was", "title", "pending" }] }
```

The file's rules in the order it holds them — which is the order `_redirects` serves them in —
and after them the rules waiting on an entry's draft, each with `pending: true`. `title` is what
the entry named by `entry` is called, resolved here because a title comes from the build's
content index; `was`, on a rule a hide re-pointed, is where it pointed before
([Redirects](redirects.md#the-file)). `503` when the repository is out of reach.

```
POST   /admin/api/redirects        { "from", "to", "status" }  →  { "rule" }
PUT    /admin/api/redirects/:id    { "from", "to", "status" }  →  {}
DELETE /admin/api/redirects/:id                                →  { "deleted": "<id>" }
```

`status` is `301` unless the body says `302`. `422` with `{ "field", "message" }` — the box the
sentence belongs under — when `from` is not a path, when it is a page the site already serves,
when `to` is neither a path nor an absolute URL, when the two are the same, or when another rule
already forwards that address. A rule whose `reason` is `hidden` belongs to the entry that is
hidden: `409` on both the edit and the delete. `404` when the file holds no rule with that id.
Adding a rule re-points any existing rule that pointed at its `from`, so a visitor never hops
twice, and drops one that would then send an address to itself.
