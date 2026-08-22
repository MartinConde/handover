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
  in the repository since the editor loaded it, the publish is refused with a message
  naming the file and no commit is made — same for a branch that moves while the commit is
  being written. Reload the entry to pick up their version and edit again
- A commit is not a live site: the site rebuilds afterwards, which takes a minute or two,
  and the admin itself is redeployed with it

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
GET /admin/api/drafts                       →  { "files": [{ "path", "updated_at" }] }
```

The files waiting to be published, newest first — the drawer's list.

```
POST /admin/api/publish                     →  { "commit_sha", "paths" }
```

No body: the server publishes what it has stored. `paths` is what went into the commit,
and is empty when there was nothing to publish. `409` when a file changed in the
repository since its draft was loaded, or when the branch moved while the commit was being
written; in both cases nothing was written and no row was cleared.

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

- Between a publish and the build that follows it the index is one commit behind. The entry
  list is still right, because the draft rows are laid over it
- **The build fails on a content file that is not `src/content/<collection>/<locale>/<name>.yaml`**,
  naming it. An entry is one file per locale and nothing below the locale folder — a file
  in a sub-folder is not addressable as `collection/slug`, so rather than leave it out of
  the list silently the build stops:
  `src/content/listings/en/devon/seaview.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it`

## Not yet

Publishing is all-or-nothing: no checkboxes, no holding an entry back, no three-way merge
when a file has changed in code — you get the refusal, not a way to resolve it — and no
build status. Those arrive in later releases.
