# Drafts and publishing

Editing an entry does not touch git. Two seconds after the last keystroke the admin saves
what you typed into the site's D1 database; the entry stays there, unpublished, until
someone publishes. Close the tab, switch machine, crash the browser — the edit is still
there when the entry is opened again.

D1 has to be set up before this works: create the database, bind it as `DB` and apply the
migrations, all three in [Deploy](deploy.md#the-database).

## What autosave stores

One row per file, keyed by the site and the content path
(`src/content/listings/en/seaview-cottage.yaml`). The row holds the **file**, not the form
— the exact bytes a publish would commit, written through the same serialiser as a
publish:

```yaml
_version: 1
title: "Seaview Cottage"
price: "£1,200 per week"
```

Two consequences worth knowing:

- **Reserved keys survive.** The browser sends the fields your schema declares; keys like
  `_version` and `_status` are not in the schema, so they are read back from the entry and
  written again. Publishing merges them the same way, so neither ever drops them.
- **Reopening an entry shows the draft, not the file.** The file in git is what the site
  still serves; the admin shows what you were last typing.
- **One save can write more than one row.** An entry's languages share their structure, so a
  block added, removed or moved writes a row for every language of that entry in the same
  write ([Languages](i18n.md#the-structure-is-shared)).

Each row also records where it came from: the commit the file was loaded from and that
file's git blob sha. Those are read from GitHub by the server on the first save of an
entry and are never sent by the browser, so a tab left open for a day cannot save against
a base that has moved on.

## What the editor shows

The state next to the breadcrumb is the autosave, not the publish:

| | |
|---|---|
| `Unsaved changes` | typed, the two seconds have not elapsed |
| `Saving…` | the draft write is in flight |
| `Saved` | the draft matches what you typed |
| `Not saved` | the write failed — the edit is only in this tab, do not close it |

**Publish…** is enabled whenever any language of the entry differs from the file in git,
including on a fresh page load with a draft already stored — a translation drafted on its
own counts, whether or not its column is open. It stores what you have typed and opens the
pending-changes drawer.

## Fields the schema is not happy with

A draft holds what you typed, whether the schema accepts it yet or not. Nothing is refused
while you are working: a new entry whose required `reference` has no picker yet, or a
required `positive()` number you have not reached, would otherwise throw away everything
typed after it.

What is missing is named instead. The field is marked and carries the reason under it, and
the header counts them — "2 problems", which jumps to the first one. The count comes back
with every autosave, so it clears as you fill things in.

**The schema decides at the publish.** *Publish…* on an entry with problems is disabled,
and a publish from the drawer is refused whole while any file in the set is missing
something: nothing is committed, and those rows are marked *Not ready to publish*. Finish
the entry and press Publish again. This is what keeps a blank new entry from committing a
file your own `content.config.ts` would reject and breaking the build behind it.

One case an editor cannot get out of on their own: a **required** `image`, `file`, `embed`,
`seo` or `reference`, whose widgets are read-only until their pickers ship
([Field types](field-types.md#in-the-admin)). Deleting the entry is the only
exit from the admin; the fix is `.optional()` in your schema until the editor for it
arrives.

A draft also keeps keys your schema no longer declares. Rename a field in `schemas.ts` and
the old key is still written back on the next save, so the value is there for
`handover migrate` to move rather than gone on the first edit.

## Publishing

There are two ways to publish, and both are one click.

**"I changed one thing."** The entry header has **Publish this entry**. It confirms first,
naming every language file that goes with the entry, and then commits that entry and
nothing else — whatever else you or anybody else has been working on stays unpublished.

**"I have been working through a dozen pages."** The top bar says how many entries are
waiting ("3 unpublished changes"); the button opens the **pending-changes drawer**, which
lists them with a checkbox each and commits the checked ones:

- **Everything is checked to begin with, except entries on hold.** So "publish all of it"
  is still one press. Unchecking is per publish and is not remembered: reopening the drawer
  starts from the defaults again, because the durable "leave this out" is the hold
- **The unit is the entry, never the file.** Checking an entry publishes every language of
  it: a block added in English is added to the German file in the same write, and the two
  have to land together. The redirect rules an entry owes travel with it, and the entries
  left out keep theirs until they are published themselves — `redirects.yaml` is assembled
  at publish out of the entries going out, so it is never a row of its own. An entry that
  owes one says so, `+1 redirect`
- The commit is the stored bytes, not the form: whatever the drawer lists is exactly what
  lands in the repository
- The rows are kept once the commit succeeds and re-seeded on it, which is what makes the
  next publish of an entry somebody is still editing not look like a conflict with this one
  ([Working together](working-together.md#your-own-publish-is-not-a-conflict)). They are
  cleared later, when the build carrying them is live
- **An entry the schema is not done with is refused the same way**, marked *Not ready to
  publish*, and likewise takes itself out. It has no button in the drawer: open the entry
  and fill in what is marked
- **An entry somebody changed in the repository is refused**, and the whole publish with
  it. That entry then takes itself out of the set — its checkbox goes off and cannot go back
  on — so pressing Publish again sends the rest. Discard is the way out of the refusal
  itself ([Working together](working-together.md#a-file-that-changed-in-the-repository))
- **An entry whose languages have drifted apart is refused too**, marked *Languages
  disagree*. Which blocks an entry has is the same in every language
  ([Languages](i18n.md#a-block-one-language-only-has)), so a file that disagrees with its
  siblings is a hand edit or a bad merge and committing it would bake the difference into
  git. Discard is not the way out of this one: open the entry and answer the panel it shows,
  which is where the files are made to agree
- A commit is not a live site: the site rebuilds afterwards, which takes a minute or two,
  and the admin itself is redeployed with it — see below

## When a commit goes live

**A commit is not a live site.** Publishing pushes to `main`, and the host builds and deploys
from that push; the pages your client just changed are live one to three minutes later. Without
something saying so, a client presses Publish four times.

So the top bar carries the state of the last commit the admin made:

| | |
|---|---|
| `Building… 1m 20s` | the commit is pushed and the host is building it |
| `Live since 14:02` | the build carrying it is deployed, and when it landed |
| `Build failed` | it is not going live, and *Revert last publish* sits in the pill |

It reads [Workers Builds](deploy.md#building-on-push) and needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_WORKER` ([Secrets](deploy.md#secrets)). Without them nothing is drawn and everything
else works as before.

Two things worth knowing:

- **The state is the server's, not the tab's.** Publishing rebuilds and redeploys the Worker
  that serves `/admin`, so the tab that pressed Publish may reload mid-deploy. The commit is read
  back out of the [activity log](activity.md), which is why the pill is right after a reload and
  why a colleague's window shows the same thing yours does. While a build is running the shell
  says so in a banner: *the admin may reload briefly while the site deploys.*
- **Every publish spends build minutes**, which are a monthly budget on the Workers free plan.
  A client publishing thirty times a day at two or three minutes each is at the ceiling — the
  unpublished-changes indicator and the drawer exist partly to encourage batching.

Once the build carrying a publish is live, its draft rows are cleared — but only for entries
nobody is editing. A row is also what an open tab publishes against, so an entry somebody has
had open across the whole cycle keeps its row until their lock runs out
([Working together](working-together.md#your-own-publish-is-not-a-conflict)).

### Reverting a publish

**Revert this publish** is in the drawer beside the result of a publish, and **Revert last
publish** in the build pill when a build has failed. Either makes one new commit that undoes the
one it names, and the changes that commit carried come back as unpublished changes, so they can
be fixed and published again.

It is **not `git revert`**. The GitHub trees API has no three-way merge to run, so the inverse is
composed:

- Every file the commit touched goes back to the bytes it had at the commit before it. A file the
  commit **created** is removed; a **rename** counts as both of its names, so the old one comes
  back as the new one goes
- A file somebody has **changed since** is refused rather than overwritten — putting it back
  would undo their work too. The whole revert is refused and it names the file, the same way a
  publish conflict does
- `redirects.yaml` is **recomputed, not restored**: it is the file as it stands now minus the
  rules that commit added, so rules written since are kept. A `to` the commit rewrote on an older
  rule stays rewritten — that URL is the live one

Reverting makes a commit, so it starts a build of its own.

## Holding an entry back

Drafts are shared, so publishing everything pending means publishing everybody's pending —
including the page somebody is halfway through rewriting. The person who knows it is
halfway is the one editing it, so that is where the flag lives: **Not ready yet**, next to
the status in the entry header.

- It is the **whole entry**, every language, the way a lock is. The header tints and says
  *On hold — won't be included when others publish*
- The pending-changes drawer lists held entries under **On hold**, tinted, badged *On hold
  · Martin Vale* and with their checkbox off, so a publish never quietly leaves something
  out: the count line reads *5 changes · 4 selected · 1 on hold* and the button counts what
  is going, `Publish 4 changes`
- Anybody can check one anyway — it is a courtesy flag, not a permission — and the drawer
  says what that does before the button is pressed: publishing it releases the hold, logged
- A held entry's draft is **not held to the schema** either, until somebody includes it: a
  half-written draft somebody is holding back does not refuse anybody else's publish for
  what it is still missing
- The flag is stored on the entry's draft rows, so **discarding or publishing the entry
  clears it**: an entry named in a publish goes out whether it is held or not, and the hold
  comes off with it, logged as `hold-released` against whoever set it. That is what makes
  the hold a courtesy rather than a lock — see below
- It is a courtesy, not a permission: anybody who can open the entry can turn it off, and
  that is logged as `hold-released` ([Activity log](activity.md)). A
  [take-over](working-together.md#take-over) does not touch it — the new holder inherits
  the hold and sees the toggle pressed

## Creating, renaming and deleting

**New entry** writes a draft and nothing else: the file appears in the repository at its
first publish, so an entry you started and abandoned never reaches git. The filename comes
from the name you type ([Configuration](configuration.md#entry-filenames)) and counts
names that exist only as drafts, so two unpublished entries cannot claim the same file.
The draft holds that name and nothing else: a required field is left out rather than
guessed at, and the editor shows every one of them as a problem until it is filled in.

**Rename** and **delete** are commits of their own, not drafts, because they move files
rather than change them ([Content format](content-format.md#renaming-and-deleting-an-entry)).
A rename carries the entry's unpublished edits over to the new path; a delete throws them
away. Both need the entry to exist in the repository: renaming one that has never been
published is refused with "publish this entry before renaming it", and deleting one just
drops the draft, with no commit and no redirect. **Turning off a language that has a file**
is the third, for the same reason: it removes that one file
([Translating](translating.md#turning-a-language-off)).

**Changing the web address** of an entry in a collection with
[`localizedSlugs`](configuration.md#localizedslugs) is a draft like an edit, not a commit like
a rename: the old address is the live one until the change is published. The publish that
carries it writes one `slug-change` redirect into `redirects.yaml` in the same commit, from
where that language served the entry to where it serves it now — and one only, however many
times the address was changed before publishing. The other languages' URLs did not move, so
nothing is written for them, and an entry that has never been published owes nothing at all.

## The endpoints

All of them are behind the admin password.

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
POST /admin/api/hold/:collection/:slug  { "hold": true }  →  { "held" }
```

Marks the entry *Not ready yet*, or takes the mark off with `false`. It writes the flag to
every language's draft row, so it holds back files the caller has not touched; an entry
with nothing pending has no row to write and nothing to hold back. `404` if the collection
is not configured.

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
POST /admin/api/entries/:collection         { "title": "…" }  →  { "slug" }
```

Creates an entry as a draft. `slug` is the derived filename, which is what the admin opens
next. Nothing is committed. `404` if the collection is not configured.

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
POST /admin/api/drift/:collection/:slug     →  {}
```

The answers to an entry's structural drift: `{ "choices": [{ "path", "locales" }] }`, one
per block the report named, `path` being that block's `path` and `locales` the languages it
should end up in — empty removes it everywhere. Every language of the entry that the answers
change is written in the same batch, and the entry is read again afterwards: nothing is marked
resolved, the drift is simply no longer reported. `409` when a `path` is not one the languages
currently disagree about, which is the report having moved on since the screen was drawn.

```
GET /admin/api/build  →  { "commit_sha", "state", "started_at", "live_at", "committed_at" }
```

Where the last commit the admin made has got to. `state` is `"building"`, `"live"` or
`"failed"`; `started_at` is when the host started building it, `live_at` when the build that
carried it finished and `committed_at` when the admin committed it, all epoch milliseconds. `{}` — an empty object, not an error — when the site has
committed nothing yet, when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_WORKER` are not both set, or
when the Cloudflare API cannot be reached; the admin draws no build status at all rather than an
unknown one. **A commit no build names yet is `"building"`**, since there is a window between the
push and the build appearing and saying `"live"` in it would be a minute ahead of the site.

Answering `"live"` is also what clears the draft rows that commit published, for the entries
nobody is editing.

```
POST /admin/api/revert   { "commit_sha": "…" }  →  { "commit_sha", "paths" }
```

Undoes that commit with a commit of its own, [as above](#reverting-a-publish). It works over any
commit the admin made, not only the last one. The answer's `commit_sha` is the new commit and
`paths` what it wrote. `400` without a `commit_sha`; `409` with `{ "error", "paths" }` when one of
the files has changed since — nothing is written and the paths are named.

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
file somebody else changed, since Discard is the way out of one and the entry's own panel is
the way out of the other. In all
of those cases nothing was written and no row was cleared. A path no collection owns —
`redirects.yaml`, a global — has no schema to be held to and is never the reason for a `422`.

## The content index

Git is the source of truth but slow to list: reading a collection through the GitHub
contents API is one request per file. So the titles are read at build time instead — the
build walks `src/content/`, collects every entry's title and `_status`, and puts the result
into the Worker, where only `/admin` can reach it. It is never served as a file, so a list
of your entries — hidden ones included — is not public.

It is derived, not authoritative: the site itself never reads it and the next build makes
it again. `astro dev` rebuilds it whenever a content file changes, so the list is current
without a restart.

Two consequences worth knowing:

- Between a commit and the build that follows it the index is one commit behind, and the
  draft rows are what covers the gap: a rename, a delete and a publish all leave a row
  saying what the commit did, so the list reads right straight away. A row that says a path
  has **gone** is dropped by the first list after the build has caught up; the rest are kept
  until the build carrying them is live, since a row is also what an editor's open tab
  publishes against
- **The build fails on a content file that is not `src/content/<collection>/<locale>/<name>.yaml`**,
  naming it. An entry is one file per locale and nothing below the locale folder — a file
  in a sub-folder is not addressable as `collection/slug`, so rather than leave it out of
  the list silently the build stops:
  `src/content/listings/en/devon/seaview.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it`

## Not yet

The build pill has no **quota** state: the free plan's monthly build minutes run out, and until
a site actually hits the ceiling there is nothing to read the Builds API's answer for it against,
so a build that fails for want of minutes reads as an ordinary failure. The publish rows in the
[activity log](activity.md) do not expand into what the commit changed — that waits for the
per-field diff. The drawer
runs no pre-publish checks and shows no per-field diff of what is about to go out. An entry
somebody changed in the repository can only be taken whole
([Working together](working-together.md#not-yet)), and **Publish this entry** does not name
the redirect rules riding along with it the way the drawer does.
