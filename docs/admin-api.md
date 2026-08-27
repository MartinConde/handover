# The admin API

Every route under `/admin/api` is behind the admin session: without one they answer `401`,
and there is no other way in. They are the package's own surface — the admin talks to
itself through them — so they are here to be *debugged*, not to be built against from
outside. They can change between versions, and `CHANGELOG.md` says when they do.

Conventions across all of them:

- **`:collection` is a key from `cms.config.ts` and `:slug` is an entry's file name.**
  `404` whenever the collection is not configured, and generally when the entry has no
  file at all. A [global](site-files.md#globals) is addressed the same way, with `globals`
  as the collection and its file name as the slug
- **The browser never sends file contents to a publish.** What is committed is what the
  server has stored; a body says only *which* of it
- **`409` is somebody else's work in the way** — a lock, a file that moved in the
  repository, a name already taken. Where more than one kind of `409` is possible the body
  carries a `reason`, so they can be told apart
- Times are epoch milliseconds

Accounts, members and the mailer check are not here: they are Better Auth's, and what a site
has to set up for them is [Accounts and signing in](auth.md). Nor is the activity log's read,
which is the one route meant to be called from your own code and is documented as such in
[Activity log](activity.md#reading-it-from-your-own-code).

## Entries

Reading a collection and an entry, and the changes that commit rather than draft — a
rename, a delete, and turning a language off.

```
GET /admin/api/entries                      →  { "entries": [{ "collection", "path", "title", "locales", "urls" }], "locales": ["en", "de"] }
```

Everything an editor can point at, across every collection the site declares, in config
order. `path` is `collection/slug` — what a `reference` and an entry `link` store — `locales`
is the languages that entry has a file in, and `urls` is the address each of them serves it
at, empty for a collection with no `route`. It is what the page picker lists, wherever the
picker appears.

```
GET /admin/api/entries/:collection          →  { "entries": [{ "id", "locales" }], "locales": ["en", "de"] }
```

The collection's entries for the list screen: one row per entry, `id` is the filename and
`locales` maps each locale to `{ title, path }` plus `status: "hidden"` when it is hidden, and
`offered` is there when the entry is not offered in every language. The response's own
`locales` is the languages the site declares, in config order.
Titles come from the field the collection is keyed on — `title`, or its
[`titleField`](configuration.md#collections); an entry that has not filled it in lists by
filename. The list is the build's [content index](#the-content-index) with the pending
drafts laid over it, so an entry you have edited but not published shows what you typed.
It reads nothing from GitHub.

```
GET /admin/api/entries/:collection/:slug  →  { fields, blocks, data, translations, pending, problems, titleField, locales, defaultLocale, sourceLocale, offered, drift, stale, translator, route, index, prefixDefaultLocale }
```

`data` is the draft when there is one, otherwise the file. `pending` is the entry's languages
whose draft is ahead of the repository, in config order: `[]` when nothing of it is waiting,
`["en"]` when `data` is a draft, `["de"]` when a translation is drafted and the default
language is not — the editor offers **Publish…** whenever it is not empty. It is a list of
locales here and the `true`/`false` of one file in the draft writes above. `problems` is the
same list the autosave answers with, so an entry names what is missing the moment it opens. `titleField` is there when the collection declares one, and is the
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
([Translating](translating.md#when-the-source-language-moves-on)). Both are empty on a site with
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
to. The drafts, translation, lock, hold and publish routes below take it unchanged. What it is
refused is what a collection's routes are for: create, rename, delete, address and turning a
language off all answer `404`.

```
POST /admin/api/entries/:collection         { "title": "…" }  →  { "slug" }
```

Creates an entry as a draft. `slug` is the derived filename, which is what the admin opens
next. Nothing is committed. `404` if the collection is not configured.

```
POST /admin/api/entries/:collection/:slug/rename   { "to": "…" }  →  { "slug", "commit_sha" }
```

One commit moving every locale file, plus one redirect per language whose URL moved. `to`
goes through the same derivation as a new entry's title, so `slug` in the answer is the name
that was actually used. `409` if the entry has never been published.

```
DELETE /admin/api/entries/:collection/:slug        →  { "commit_sha" }
```

One commit removing every locale file, with a redirect per language to that language's copy
of the collection's `index` when it has one, and the entry's draft dropped. The answer is `{}`
when nothing was committed — the entry existed only as a draft, or not at all.

```
POST /admin/api/entries/:collection/:slug/locales  { "locales": ["en"] }  →  {}
```

The languages the entry is offered in, written as `_locales` into every file it has — or taken
out again when they are all of them. No file is written for a language left out, which is the
point of it.

Leaving out a language that **has** a file deletes that file, so this one commits where the rest
of the editor drafts: one commit removes it, writes the mark into the files that stay and appends
the redirect its URL owes to the collection's `index` under that language's own segment — none
where the collection has no `index`. An `_i18n` naming a language that went is dropped from the
files that carry it, and unpublished changes to a language that goes are dropped with its file.
A language whose file is only a draft is not in the repository, so it makes no commit and no
redirect: the draft is thrown away and the mark is drafted like any other.

`409` when the entry would be left with no published file — that is deleting the entry, which is
what `DELETE` is for, and a language whose file is only a draft does not stand in for one that is
published; `404` when the entry has no file at all.

```
POST /admin/api/entries/:collection/:slug/address/:locale   { "address": "…" }  →  {}
```

The address one language serves the entry at, written into that language's draft. Empty takes
the key out and leaves the file name to serve it. `404` on a collection without
`localizedSlugs`, on a language the site does not declare, and on an entry with no file in
that language; `422` when the address is not one; `409` when another entry in the collection
already answers to it in that language, its file name counted.

## Drafts

Everything an editor types goes through these, and none of them commits — see
[Publishing](#publishing) for that. What a draft holds, and why it holds the file rather
than the form, is [Drafts and publishing](publishing.md#what-autosave-stores).

```
PUT /admin/api/drafts/:collection/:slug  { "data": { … } }  →  { "updated_at", "pending", "problems" }
```

Merges `data` into the entry and stores the result. `pending` is false when the stored
bytes are identical to the file in git — an autosave that changed nothing. `problems` is
what the collection schema will not accept, `[{ "path": "body.1.heading", "message":
"Required" }]`, empty when it accepts all of it; the draft is stored either way. Keys
beginning with `_` are ignored: they belong to the file, not to the form. `400` if `data`
is not an object or holds a shape the serialiser cannot write back (a nested array), with
the reason as the body; `404` if the collection or the file does not exist. `409` with
`{ "held_by", "mine", "expires_at" }` when somebody else is editing the entry
([Working together](working-together.md#take-over)).

```
PUT /admin/api/drafts/:collection/:slug/:locale  { "data": { … } }  →  { "updated_at", "pending", "problems" }
```

The same, for a language the entry is translated into
([Translating](translating.md#what-a-save-of-a-translation-writes)). Only the values that
language owns are taken from `data`: the structure and the shared values come from the file, so
this write can never move a block or change what the languages share. `404` when the site does
not declare that locale.

```
POST /admin/api/drafts/:collection/:slug/:locale  →  {}
```

**Create from English**: writes that language's file for the entry as a draft — the structure
and the values the languages share, none of the words
([Translating](translating.md#a-language-with-no-file-yet)). It is made from the language the
entry is written in, which is the site's default only where the entry has a file in it, so this
is also how an entry written in one other language gets its default-language file. `409` when
the language already has a file or a draft, or when the entry is not offered in it; `404` for a
language the site does not declare, or an entry with no file in any of them.

```
POST /admin/api/translate/:collection/:slug/:locale  { "paths": ["title"] }  →  { "data", "pending" }
```

Machine-translates that language from the one the entry is written in and stores the answers in
its draft ([Translating](translating.md#a-machines-first-draft)). `paths` names the fields to translate
and is optional: without it, every field this language has nothing in yet is filled. Only prose
is sent. The paths a machine wrote go into the file's `_machine`; `data` is the file as the
fill leaves it, which is what the second column redraws from. `404` for the language the entry
is written in, or one the site does not declare. `409` when the site has nothing configured to translate with —
that one is about the site rather than the entry, so it comes before the entry is read at all,
and `404` for an entry with no file in either language comes after it.

```
DELETE /admin/api/drafts/:collection/:slug  →  {}
```

Throws the entry's stored draft away; the next open reads the file in the repository
instead. Nothing is committed and the published page is untouched. This is what the
drawer's **Discard** does with a file a publish was refused over
([Working together](working-together.md#a-file-that-changed-in-the-repository)). `404` if
the collection is not configured.

```
POST /admin/api/drift/:collection/:slug     →  {}
```

The answers to an entry's structural drift: `{ "choices": [{ "path", "locales" }] }`, one
per block the report named, `path` being that block's `path` and `locales` the languages it
should end up in — empty removes it everywhere. Every language of the entry that the answers
change is written in the same batch, and the entry is read again afterwards: nothing is marked
resolved, the drift is simply no longer reported. `409` when a `path` is not one the languages
currently disagree about, which is the report having moved on since the screen was drawn.

```
GET /admin/api/diff/:collection/:slug  →  { "groups", "redirects" }
```

What one entry would put in the next commit, field by field: the drawer's expanded row.
`groups` is the [per-field diff](publishing.md#publishing) — one group per language of the
entry plus one for the values they all share, each with the changes in it — of the draft
against the file **at HEAD**, not against the commit the draft was loaded from: the question
a row answers is what is about to go out. `redirects` is the address changes riding along in
the same commit, `{ "from", "to" }` each. A language with a file and no draft is in `groups`
with nothing in it, which is how the screen tells "unchanged" from "not loaded". `404` if the
collection is not configured.

```
GET  /admin/api/conflict/:collection/:slug  →  { "head", "questions", "merged", "files" }
POST /admin/api/conflict/:collection/:slug  { "answers": [{ "path", "locale", "side" }] }  →  {}
```

The three-way view of an entry the repository moved under, and the answers to it
([Working together](working-together.md#resolving-it-field-by-field)). Every language of the
entry is read at HEAD and at the commit each draft row was loaded from; `questions` are the
fields **both** sides changed — `path`, `label`, the `locale` it belongs to or none for a
value every language shares, the `base` both started from, and `ours` / `theirs` as the same
change shapes the diff uses — and `merged` are the ones only one side changed, each with the
`side` that changed it. `files` is the paths that moved, and `head` the commit they are being
answered against.

The `POST` takes one answer per question, `side` being `"ours"` or `"theirs"`, and `path` and
`locale` exactly as the question gave them. It writes the merge into the drafts of the files
that moved and rebases those rows on HEAD, so the next publish is measured against the file
the answers were given over. Nothing is committed. `409` when nothing of the entry has moved
— somebody has already settled it — and `409` when the answers are not one per question,
which is the report having moved on since the screen was drawn.

```
POST /admin/api/hold/:collection/:slug  { "hold": true }  →  { "held" }
```

Marks the entry *Not ready yet*, or takes the mark off with `false`. It writes the flag to
every language's draft row, so it holds back files the caller has not touched; an entry
with nothing pending has no row to write and nothing to hold back. `404` if the collection
is not configured.

## Publishing

What is waiting, committing it, and what the host has done with the commit since. The
flow these serve is [Drafts and publishing](publishing.md#publishing).

```
GET /admin/api/drafts  →  { "entries": [{ "key", "title", "collection", "locales", "files", "redirects", "updated_at", "held_by" }] }
```

What is waiting to be published — the drawer's list, **one row per entry** and never per
file, newest first. `key` is `collection/name`, the same key `POST /admin/api/publish`
takes. `title` is the entry's, read the way the entry list reads it: the first language
that has one, falling back to the file name. `locales` is the languages of it that are
waiting, in config order, and `files` their paths — which is what matches a refusal's
`paths` back to a row. `redirects` is how many redirect rules the entry owes and is absent
when it owes none; `redirects.yaml` itself is assembled at publish and is never a row.
`held_by` is `{ "id", "name" }` when somebody marked the entry *Not ready yet*, and it is
read once per entry rather than per file, since the hold is the entry's.

Grouping happens here rather than in the browser because a title comes from the build's
[content index](#the-content-index), which nothing outside the Worker can read.

```
POST /admin/api/publish   { "entries": ["listings/mill-house"] }  →  { "commit_sha", "paths", "released" }
```

Publishes the entries the body names, or everything pending that is not on hold when there
is no body. An entry is `collection/name` — the same key for every language, since the
languages of one entry are published together — and an entry that is **on hold** goes out
when it is named, which releases the hold. Naming an entry with nothing pending, or passing
an empty list, publishes nothing and is not an error.

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
the entry's own drift panel is the way out of the other. In all
of those cases nothing was written and no row was cleared. A path no collection owns —
`redirects.yaml`, a global — has no schema to be held to and is never the reason for a `422`.

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

Answering `"live"` is also what clears the draft rows that commit published, for the entries
nobody is editing.

```
POST /admin/api/revert   { "commit_sha": "…" }  →  { "commit_sha", "paths" }
```

Undoes that commit with a commit of its own, [as above](#reverting-a-publish). It works over any
commit the admin made, not only the last one. The answer's `commit_sha` is the new commit and
`paths` what it wrote. `400` without a `commit_sha`; `409` with `{ "error", "paths" }` when one of
the files has changed since — nothing is written and the paths are named.

## Locks

The soft lock on an entry, and what it does to a save. What it means for two people
working at once is [Working together](working-together.md).

```
POST /admin/api/locks/:collection/:slug  →  { "held_by", "mine", "expires_at", "base" }
```

The heartbeat. It takes the entry when nobody is editing it and pushes the caller's own
lock further out when they are, and it is what the editor sends as it opens and again
while somebody types in it. `held_by` is `{ "id", "name" }` for the person editing it and
`null` when nobody is, `mine` says whether that is the caller, and `expires_at` is when
the lock lapses — epoch milliseconds, about two minutes out. `base` is what each of the
entry's files was loaded against, `{ "src/content/listings/en/seaview-cottage.yaml":
{ "sha", "blob" } }`, so a tab open across somebody else's publish knows its diff base;
a language with no draft is not in it. `404` if the collection is not configured.

```
GET /admin/api/locks/:collection/:slug   →  { "held_by", "mine", "expires_at", "base" }
```

The same answer, taking nothing. This is what the person waiting polls: an entry changes
hands when somebody asks for it, never because their tab was watching when the last beat
lapsed.

```
POST /admin/api/locks/:collection/:slug  { "take": true }
```

Take over. The lock moves whatever it says, and the answer is the same shape with
`"mine": true`. Without the body it is an ordinary beat, so a tab that asks first is still
not a way to take an entry off somebody.

```
PUT /admin/api/drafts/:collection/:slug  →  409  { "held_by", "mine", "expires_at" }
```

What a save looks like once somebody else holds the lock: nothing is written, and the
answer names them so the screen can say who. Both draft endpoints answer this way — the
entry's own language and a translation ([above](#drafts)).

## Media

The upload pipeline, in two calls around a PUT the browser makes straight to the bucket,
and the library the picker reads. What has to be set up before any of them answers anything
is [Media](media.md).

```
GET /admin/api/media?kind=images|files  →  { "media": [ { "id", "src", "filename", "mime",
                                                          "bytes", "width", "height", "url?" } ] }
```

What the picker lists: newest first, archived left out, at most 100. `kind` is the field's —
`files` is everything that is not a picture, and anything else is the pictures.

```
POST /admin/api/media  { "hash", "bytes", "mime", "filename?", "width?", "height?" }
  →  { "media": { "id", "src", "filename", "mime", "bytes", "width", "height", "url?" } }
  →  { "upload": { "key", "url" } }
```

"Do you have these bytes?" `hash` is the SHA-256 of the file, hex. The first answer is the
asset the site already holds, and the upload is over before it started — the same picture
chosen twice is one object and one row. The second is a PUT URL signed for five minutes,
for a key the server chose: `media/<sha256>.<ext>`, or `files/<sha256>.<ext>` for anything
that is not a picture. `422` when the type is not one the bucket takes or the declared size
is over 10MB, `503` when the site has no bucket configured.

`src` is the key a content file stores; `url` is that key under
[`media.publicBase`](configuration.md#media) and is absent when the site has not set one.

```
PUT /admin/api/media/:hash  { "hash", "bytes", "mime", "filename?", "width?", "height?" }
  →  { "media": { … } }
```

The upload is over. The Worker reads the object back and holds it to the declaration: an
object whose size or content type is not what was declared is **deleted** and answered
`422`, and no row is written. A file is held to two more things: it must have been stored as
a download (`content-disposition: attachment`), and its first bytes must be the type it was
uploaded as — a renamed `.html` is deleted rather than served from the CDN domain. Bytes the site already had are answered from the row without
the bucket being touched at all, which is also what stops a made-up declaration deleting
somebody else's good object.

## Diagnostics

What the **Settings** screen reads. All of it is **owner only** — the payload names the sending
address and the media host, and a sidebar item an editor never sees is not a gate.
[Settings](diagnostics.md) is what the screen makes of it.

```
GET /admin/api/diagnostics
  →  { "collections", "locales", "defaultLocale", "mediaBase", "mailer", "preview", "dev" }
```

`cms.config.ts` as it came out: `collections` is `{ name, route? }` in declaration order,
`mailer` is `{ provider, from }` — or `{ "provider": "custom" }` where the site handed in a
function of its own, and `null` where it configured none — and `preview` says whether this
build has a `/_preview` route at all. `dev` is the build mode, and is what decides whether the
screen offers *Simulate a conflict*.

```
POST /admin/api/checks/github        →  { "ok": true, "detail" }
POST /admin/api/checks/storage       →  { "ok": true, "detail" }
POST /admin/api/checks/translation   →  { "ok": true, "detail" } | { "off": true, "detail" }
POST /admin/api/checks/build         →  { "ok": true, "detail" } | { "off": true, "detail" }
POST /admin/api/checks/database      →  { "ok": true, "detail" }
```

One connection, tried for real: an installation token and a read of the branch head; one small
object written to the bucket, read back and deleted again; one word translated; the worker asked
about without naming a commit; a read of the admin's own tables. `detail` is a sentence and not a
code, because this page is read by whoever forwards it.

`off` is a thing the site never configured and does not need — no DeepL key, no
`CLOUDFLARE_API_TOKEN` — which is not a failure. `503` is a thing it needs and was never told,
and the body's `error` is the sentence naming what to set; `502` is a thing that was told and
refused, and `error` is the refusal itself. `403` for an editor; `404` for a check name that is
not one of these.

The test email is [`POST /admin/api/checks/email`](email.md#prove-it-before-anything-depends-on-it), which sends
something and so is never run on its own, and *Simulate a conflict* is
[`POST /admin/api/checks/conflict`](#publishing) above.

## Integration keys

The keys the client owns rather than the developer ([Settings](diagnostics.md#integrations)).
Owner only, like the rest of that screen.

```
GET    /admin/api/settings          →  { "integrations": [ { "key", "source", "fallback",
                                                             "hint", "updatedAt", "by" } ] }
PUT    /admin/api/settings/:key        { "value": "…" }   →  { "ok": true, "detail"? }
DELETE /admin/api/settings/:key                           →  { "ok": true }
```

`key` is `deepl` or `assist` and nothing else — anything the admin needs to run itself stays in
the environment. `source` is where that key is **in force** — `settings`, `env`, `code` (the
site handed in its own `i18n.translate`) or `off` — and `fallback` is what would be in force
without the row, so *Remove* can say what happens before it is pressed. `hint` is the last four
characters of the key. **The key itself is never in an answer**: to check one, replace it.

A `PUT` of a DeepL key translates one word with it before storing anything, and answers `502`
with DeepL's own refusal if that fails; `detail` is what it translated when it worked. `400` for
an empty value, `404` for a key outside the two, `503` when `HANDOVER_SETTINGS_KEY` is not set —
the body names it. Every write is a `setting-changed` row in the [activity log](activity.md),
carrying the name of the key and never its value.
