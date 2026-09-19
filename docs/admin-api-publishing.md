# The admin API — publishing

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Publishing

What is waiting, committing it, and what the host has done with the commit since. The
flow these serve is [Drafts and publishing](publishing.md#publishing).

```
GET /admin/api/drafts  →  { "entries": [{ "key", "title", "collection", "locales", "files", "redirects", "updated_at", "held_by" }], "defaultLocale" }
```

What is waiting to be published — the drawer's list, **one row per entry** and never per
file, newest first. `key` is `collection/name`, the same key `POST /admin/api/publish`
takes. `title` is the entry's, read the way the entry list reads it: the first language
that has one, falling back to the file name. `locales` is the languages of it that are
waiting, in config order, and `files` their paths — which is what matches a refusal's
`paths` back to a row. `redirects` is how many redirect rules the entry owes and is absent
when it owes none; `redirects.yaml` itself is assembled at publish and is never a row.
`held_by` is `{ "id", "name", "since" }` when somebody marked the entry *Not ready yet* —
`since` the moment they did, epoch milliseconds, which the drawer reads as *· 2 days* — and it
is read once per entry rather than per file, since the hold is the entry's.

Grouping happens here rather than in the browser because a title comes from the build's
[content index](publishing.md#the-content-index), which nothing outside the Worker can read.

```
GET /admin/api/dashboard  →  { "recent": [...], "published": { "at", "by" } | null, "translations": {...} | null }
```

Everything the [dashboard](dashboard.md) draws that no other route answers. The unpublished
count and the build pill are not in it: the shell has already loaded both, and a second
answer about the same drafts is how a count and a drawer come to disagree.

`recent` is up to eight entries, newest first —
`{ "key", "title", "collection", "href", "at", "by", "kind", "editing" }`. `kind` is
`"edit"` for an entry with a draft row and `"publish"` for one whose last change is already
out; `by` is a name or `null`, never an address; `editing` is the lock holder where there is
one. `href` is where that entry is edited, which for a global is `/admin/site/<name>`.

`published` is the newest commit the admin made, when it was a publish and not a rename or a
redirect. `translations` is `null` on a one-language site; otherwise it is
`{ "defaultLocale", "locales": [{ "locale", "missing", "stale", "unfinished", "machine", "where" }] }`
— `missing` from the content index with the drafts over it, `stale` from the map the build
wrote, which is why it lags a publish, `unfinished` and `machine` the entries whose file in that
language is partly written or still holds machine-translated text, counted like the entry list's
`partial` and `machine` with the drafts over the build, and `where` the collections where an
entry is missing that language, partly written in it or stale in it, in config order and without
the globals, which have no list to be shown in. Globals count in every number. An entry can count as both stale and unfinished, so the numbers do not
add up to a count of entries.

```
POST /admin/api/publish   { "entries": ["listings/mill-house"], "without": ["listings/mill-house:de"] }  →  { "commit_sha", "paths", "released" }
```

Publishes the entries the body names, or everything pending that is not on hold when there
is no body. Malformed JSON, a missing or non-array `entries` property, unknown properties, and invalid array elements return `400` with `{ "code": "PUBLISH_SELECTION_INVALID", "error" }` before draft selection. An empty array selects nothing; it never means all. An entry is `collection/name` — the same key for every language, since the
languages of one entry are published together, apart from a new translation left out with
`without` — and an entry that is **on hold** goes out
when it is named, which releases the hold. Naming an entry with nothing pending, or passing
an empty list, publishes nothing and is not an error.

`without` is optional and leaves files of the named entries out of the commit, as
`collection/name:locale`. Only a language with unpublished changes whose file the repository
does not have yet can wait — a new translation nobody has finished. The files the repository
already has publish together, and so does the language the entry is written in, even when it
is new. A left-out draft keeps its words, its revision and its hold, and stays pending for the
next publish; if it was held, the entry stays on hold and `released` does not name it. The
eligibility is read at one commit and the publish is made on that commit, so a file somebody
commits in between is `PUBLISH_REF_MOVED`, never published past. Refusals, each before anything
is written:

| Status | `code` | When |
|---|---|---|
| `400` | `PUBLISH_SELECTION_INVALID` | `without` is not a list, has an item that is not `collection/name:locale`, names an entry `entries` does not, or a language the site does not declare; or `without` comes with no `entries` |
| `400` | `PUBLISH_EXCLUDE_NOT_PENDING` | a left-out file has no unpublished changes (`paths` names them) |
| `400` | `PUBLISH_EXCLUDE_ALL` | leaving the files out leaves nothing to publish |
| `422` | `PUBLISH_EXCLUDE_PUBLISHED` | the repository already has the file (`paths`) |
| `422` | `PUBLISH_EXCLUDE_SOURCE` | the file is the language the entry is written in (`paths`) |

The body never carries content: what is committed is what the server has stored, and this
says only which of it. `paths` is what went into the commit, empty when there was nothing to
publish, and `released` names the entries whose hold this publish took off. `409` when a file changed in the
repository since its draft was loaded — the body is `{ "error", "paths" }`, naming those
files so the drawer can mark them and offer the way out — or when the branch moved while
the commit was being written, which answers with a plain sentence and no paths. `422`
when a stored draft is not everything its collection schema needs, with the same
`{ "error", "paths" }` body, and `409` with `{ "error", "paths", "reason": "drift" }` when a
pending file belongs to an entry whose languages have
[drifted apart](i18n.md#a-block-one-language-only-has) — `reason` is what tells that from a
file somebody else changed, since the three-way view or Discard is the way out of one and
the entry's own drift panel is the way out of the other. `409` with
`{ "code": "PUBLISH_SOURCE_UNRESOLVED", "error", "paths" }` when a pending file belongs to an
entry whose files disagree about the language it is written in
([The source language](source-language.md#when-the-files-disagree-about-the-source-language)); the drawer's own check
normally holds such an entry back before the request is made. In all
of those cases nothing was written and no row was cleared. A path no collection owns —
`redirects.yaml`, a global — has no schema to be held to and is never the reason for a `422`.

Publish failures retain `error` as diagnostic compatibility text and add a stable `code` for UI
presentation: `PUBLISH_INCOMPLETE` (`422`), `PUBLISH_DRIFT` (`409`), `PUBLISH_SOURCE_UNRESOLVED` (`409`), `PUBLISH_CONFLICT` (`409`),
`PUBLISH_REF_MOVED` (`409`), `PUBLISH_REPOSITORY_UNAVAILABLE` (`503`) or
`PUBLISH_FINALIZATION_PENDING` (`503`), plus the selection codes in the table above. Path-bearing answers keep `paths`; drift keeps
`reason: "drift"`; an unfinished finalization keeps its operation and commit identifiers. Clients
must continue to use status, `paths`, `reason` and the request uncertainty signal for control flow,
not translated text or the descriptor alone.

```
POST /admin/api/publish/checks   { "entries": ["listings/mill-house"], "without": [] }  →  { "results": [{ "check", "entry", "path", "fieldPath", "severity", "message" }], "readiness" }
```

The [pre-publish checks](pending-changes.md#checks-before-a-publish) over the entries the body
names — the same body `POST /admin/api/publish` takes, refused the same way, and the same set it
would commit. What a link resolves against is the built content index with **those** drafts
laid over it and no others, so a link to a page that only an unselected or left-out draft would
create is reported, and a left-out file is not checked at all. `severity`
is `error`, `warn` or `info`; `entry` is the key the drawer groups under and `fieldPath`
addresses the field the way `_machine` does (`blocks[_id=b1x2y3z4].link.ref`), so it survives a
block being moved.

With `entries`, the answer also carries `readiness`: per entry, per language with unpublished
changes — a translation nobody has typed into included, and a left-out one too — what its
stored draft lacks for the collection schema, and whether it could be left out:

```json
{ "listings/mill-house": {
    "en": { "revision": "…", "problems": [], "excludable": false, "reason": "published" },
    "de": { "revision": "…", "problems": [{ "path": "rooms", "message": "…" }], "excludable": true } } }
```

`reason` is `published` or `source` — the source also covers an entry whose files disagree
about it. `problems` is what `POST /admin/api/publish` answers `422 PUBLISH_INCOMPLETE` over.

**Past a selection it would refuse to publish, it refuses nothing, and nothing refuses because of it.** The lint is a request of its own so
that it has its own CPU: a publish too heavily cross-linked to read in one pass costs a check
result rather than the commit. `POST /admin/api/publish` does not run it, and an error is only
a stop in the drawer, whose Publish button is disabled while one stands.

If the repository cannot be read, the check request returns `503` with
`{ "code": "PUBLISH_CHECKS_FAILED", "error": "…" }`. The drawer still treats an unavailable
lint as non-blocking and says that nothing was checked; this code localizes that explanation
without changing the lint's advisory semantics.

```
POST /admin/api/checks/conflict  →  { "entry", "path", "commit_sha" }
```

Makes a conflict to look at, on a scratch entry, so the three-way view can be exercised on a
live site without hand-crafting commits. **Owner only, and it writes to the repository**: it
publishes a scratch entry — named after the commit it is made against — in the first collection
whose required fields can be filled in from their types alone, edits its draft, and then commits a different edit to the same file — which
is what a developer's push does to somebody's open draft. The answer names the entry it made;
delete that entry when you are done with it. `422` when no collection on the site can be
filled in that way — a file the site's own content schema rejects would break the next build.

```
GET /admin/api/build  →  { "commit_sha", "state", "started_at", "live_at", "committed_at" }
```

Where the last commit the admin made has got to. `state` is `"building"`, `"live"` or
`"failed"`; `started_at` is when the host started building it, `live_at` when the build that
carried it finished and `committed_at` when the admin committed it, all epoch milliseconds.
**A commit no build names yet is `"building"`**, since there is a window between the push and
the build appearing and saying `"live"` in it would be a minute ahead of the site.

**`commit_sha` and `committed_at` are absent where the answer is about no commit of yours**, and
the rest of it is the worker's newest build — what the site is serving. That happens on a site
nobody has published on yet, and once ten minutes have gone by without a build naming the commit:
the host's build list takes no commit filter, so a commit older than the builds on it can no
longer be asked about.

`{}` — an empty object, not an error — when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_WORKER` are
not both set, or when the Cloudflare API cannot be reached; the admin draws no build status at
all rather than an unknown one.

Answering `"live"` clears unchanged draft rows only when `commit_sha` identifies the last CMS commit and nobody is editing the entry. An unrelated successful build clears nothing.

```
POST /admin/api/revert   { "commit_sha": "…" }  →  { "commit_sha", "paths" }
```

Undoes that commit with a commit of its own, [Reverting a publish](build-status.md#reverting-a-publish). It works over any
eligible commit recorded in the server activity log, not only the last one. Every changed path must belong to that operation and to a configured editable content file; otherwise the whole request is `403`. Redirect-only operations additionally require an owner. The answer's `commit_sha` is the new commit and
`paths` what it wrote. `400` without a `commit_sha`; `409` with `{ "error", "paths" }` when one of
the files has changed since — nothing is written and the paths are named.

```
POST /admin/api/restore  { "commit_sha": "…" }  →  { "commit_sha", "paths" }
```

The same inverse, over the commit an `entry-delete` or a `locale-off` row names
([Entry lifecycle](entry-lifecycle.md#putting-a-deleted-entry-back)). It does what a revert
cannot: the marks a turn-off wrote into the open drafts of the files that stayed go back to
what the restored files say, and the rows that were keeping the restored paths off the entry
list are dropped. Same answer, same `400`, same `409` — and the `409` is the ordinary case of
somebody having taken the freed name, or naming the colleague who has the entry open again.
