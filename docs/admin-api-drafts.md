# The admin API — drafts

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Drafts

Everything an editor types goes through these, and none of them commits — see
[Publishing](admin-api-publishing.md) for that. What a draft holds, and why it holds the file rather
than the form, is [Drafts and publishing](publishing.md#what-autosave-stores).

```
PUT /admin/api/drafts/:collection/:slug  { "data": { … }, "tab": "…" }  →  { "updated_at", "pending", "problems" }
```

Merges `data` into the entry and stores the result. `tab` is the token the tab beats the
lock with ([Locks](admin-api.md#locks)); a save without the holder's token is refused. `pending` is false when the stored
bytes are identical to the file in git — an autosave that changed nothing. `problems` is
what the collection schema will not accept, `[{ "path": "body.1.heading", "message":
"Required" }]`, empty when it accepts all of it; the draft is stored either way. Keys
beginning with `_` are ignored: they belong to the file, not to the form. `400` if `data`
is not an object or holds a shape the serialiser cannot write back (a nested array), with
the reason as the body; `404` if the collection or the file does not exist. `409` with
`{ "held_by", "mine", "expires_at" }` when another tab holds the entry — somebody else's, or
the same person's ([Working together](working-together.md#take-over)).

```
PUT /admin/api/drafts/:collection/:slug/:locale  { "data": { … }, "tab": "…" }  →  { "updated_at", "pending", "problems" }
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
GET /admin/api/source/:collection/:slug/:locale  →  { "from", "translatedAt", "changed": { "<field>": [{ "text", "mark" }] } }
```

What that language's source has said since somebody translated it, field by field — the marker a
target-language field carries beside its label in side-by-side editing
([Translating](translating.md#translation-staleness)). The entry response's `stale` says *which*
languages are behind, off one hash over the whole file; this says which of their fields. The older
source is fetched by the blob id the translation itself wrote down, so it survives however many
commits later somebody asks.

Keys are the address `_machine` uses (`blocks[_id=k3nf9a2p].heading`), and each value is the same
word diff the drawer draws: `mark` is `del` for what went, `ins` for what arrived, absent for what
stayed. `{ "changed": {} }` and no `from` wherever there is nothing to compare — the language has
no translation mark, or git no longer holds those bytes. `404` for an entry no collection has.

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
`groups` is the [per-field diff](pending-changes.md#the-drawer) — one group per language of the
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
