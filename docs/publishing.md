# Drafts and publishing

Editing an entry does not touch git. Two seconds after the last keystroke the admin saves
what you typed into the site's D1 database; the entry stays there, unpublished, until
someone clicks **Publish this entry**. Close the tab, switch machine, crash the browser —
the edit is still there when the entry is opened again.

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

**Publish this entry** is enabled whenever the entry differs from the file in git,
including on a fresh page load with a draft already stored.

## The endpoints

Both are behind the admin password and take JSON.

```
PUT /admin/api/drafts/:collection/:slug     { "data": { … } }  →  { "updated_at", "pending" }
```

Validates `data` against the collection schema, merges it into the entry and stores the
result. `pending` is false when the stored bytes are identical to the file in git — an
autosave that changed nothing. `400` if the data fails the schema, `404` if the collection
or the file does not exist.

```
GET /admin/api/entries/:collection/:slug    →  { fields, blocks, data, pending, blob_sha, head_sha }
```

`data` is the draft when there is one, otherwise the file. `pending` says which.

## Not yet

Publish still commits what the form holds rather than the stored draft, one entry at a
time, and leaves the row behind. There is no pending-changes list, no publishing several
entries in one commit, and no conflict resolution beyond the refusal you already get when
someone else published first. Those arrive in later releases.
