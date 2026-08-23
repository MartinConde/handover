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

**Publish…** is enabled whenever the entry differs from the file in git, including on a
fresh page load with a draft already stored. It stores what you have typed and opens the
pending-changes drawer.

## Publishing

The top bar says how many files are waiting ("3 unpublished changes"); the button opens
the **pending-changes drawer**, which lists them and publishes them:

- **Everything pending goes out together**, in one commit. There is no per-file choice
  yet — picking what ships arrives with the checkboxes in a later release
- The commit is the stored bytes, not the form: whatever the drawer lists is exactly what
  lands in the repository
- The rows are deleted once the commit succeeds, so reopening an entry reads the file that
  was just written
- **Nothing is written unless all of it can be.** If somebody changed one of those files
  in the repository since the editor loaded it, the publish is refused and no commit is
  made: the drawer marks that row *Changed in the repository since you opened it* — same
  for a branch that moves while the commit is being written
- **A refused file has one way out: Discard.** It throws that file's unpublished changes
  away and reads it from the repository again, so the entry is on their version and the
  next publish goes through. Reopening or editing the entry does not clear the refusal —
  the draft keeps the base it was loaded against until it is discarded. Keeping your
  version over theirs, or choosing field by field, arrives with the three-way view in a
  later release
- A commit is not a live site: the site rebuilds afterwards, which takes a minute or two,
  and the admin itself is redeployed with it

## Creating, renaming and deleting

**New entry** writes a draft and nothing else: the file appears in the repository at its
first publish, so an entry you started and abandoned never reaches git. The filename comes
from the title ([Configuration](configuration.md#entry-filenames)) and counts names that
exist only as drafts, so two unpublished entries cannot claim the same file. The draft
starts with every required field present and empty — an autosave validates against the
collection schema, and a missing required field would refuse the save.

**Rename** and **delete** are commits of their own, not drafts, because they move files
rather than change them ([Content format](content-format.md#renaming-and-deleting-an-entry)).
A rename carries the entry's unpublished edits over to the new path; a delete throws them
away. Both need the entry to exist in the repository: renaming one that has never been
published is refused with "publish this entry before renaming it", and deleting one just
drops the draft, with no commit and no redirect.

## The endpoints

All of them are behind the admin password.

```
PUT /admin/api/drafts/:collection/:slug     { "data": { … } }  →  { "updated_at", "pending" }
```

Validates `data` against the collection schema, merges it into the entry and stores the
result. `pending` is false when the stored bytes are identical to the file in git — an
autosave that changed nothing. `400` if the data fails the schema, `404` if the collection
or the file does not exist.

```
DELETE /admin/api/drafts/:collection/:slug  →  {}
```

Throws the entry's stored draft away; the next open reads the file in the repository
instead. Nothing is committed and the published page is untouched. This is what the
drawer's **Discard** does with a file a publish was refused over. `404` if the collection
is not configured.

```
GET /admin/api/entries/:collection/:slug    →  { fields, blocks, data, pending }
```

`data` is the draft when there is one, otherwise the file. `pending` says which.

```
GET /admin/api/entries/:collection          →  { "entries": [{ "id", "locales" }] }
```

The collection's entries for the list screen: one row per entry, `id` is the filename and
`locales` maps each locale to `{ title, path }` plus `status: "hidden"` when it is hidden.
Titles come from the entry's `title` field; a collection without one lists by filename.
The list is the build's [content index](#the-content-index) with the pending drafts laid
over it, so an entry you have edited but not published shows what you typed. It reads
nothing from GitHub.

```
POST /admin/api/entries/:collection         { "title": "…" }  →  { "slug" }
```

Creates an entry as a draft. `slug` is the derived filename, which is what the admin opens
next. Nothing is committed. `404` if the collection is not configured.

```
POST /admin/api/entries/:collection/:slug/rename   { "to": "…" }  →  { "slug", "commit_sha" }
```

One commit moving every locale file, plus the redirect. `to` goes through the same
derivation as a new entry's title, so `slug` in the answer is the name that was actually
used. `409` if the entry has never been published.

```
DELETE /admin/api/entries/:collection/:slug        →  { "commit_sha" }
```

One commit removing every locale file, with a redirect to the collection's `index` when it
has one, and the entry's draft dropped. The answer is `{}` when nothing was committed —
the entry existed only as a draft, or not at all.

```
GET /admin/api/drafts                       →  { "files": [{ "path", "updated_at" }] }
```

The files waiting to be published, newest first — the drawer's list.

```
POST /admin/api/publish                     →  { "commit_sha", "paths" }
```

No body: the server publishes what it has stored. `paths` is what went into the commit,
and is empty when there was nothing to publish. `409` when a file changed in the
repository since its draft was loaded — the body is `{ "error", "paths" }`, naming those
files so the drawer can mark them and offer the way out — or when the branch moved while
the commit was being written, which answers with a plain sentence and no paths. In both
cases nothing was written and no row was cleared.

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

- Between a commit and the build that follows it the index is one commit behind. A rename
  or a delete is still right in the list straight away: both leave a row saying what the
  commit did to that file, and the row is dropped by the first list after the build has
  caught up. A **publish** is the one that waits — its rows are cleared with the commit, so
  until the site has rebuilt a title you published still reads as the old one, and an entry
  you have just created is not in the list at all
- **The build fails on a content file that is not `src/content/<collection>/<locale>/<name>.yaml`**,
  naming it. An entry is one file per locale and nothing below the locale folder — a file
  in a sub-folder is not addressable as `collection/slug`, so rather than leave it out of
  the list silently the build stops:
  `src/content/listings/en/devon/seaview.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it`

## Not yet

Publishing is all-or-nothing: no checkboxes, no holding an entry back and no build status.
A file someone changed in the repository can only be taken whole, by discarding yours;
there is no three-way merge and no way to keep your version over theirs. Those arrive in
later releases.
