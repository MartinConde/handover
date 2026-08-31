# Drafts and publishing

Editing an entry does not touch git. Two seconds after the last keystroke the admin saves
what you typed into the site's D1 database; the entry stays there, unpublished, until
someone publishes. Close the tab, switch machine, crash the browser — the edit is still
there when the entry is opened again. D1 has to be set up first: create the database, bind it
as `DB` and apply the migrations, all three in [Deploy](deploy.md#the-database).

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
including on a fresh page load with a draft already stored — a translation drafted on its own
counts, whether or not its column is open.

## Fields the schema is not happy with

A draft holds what you typed, whether the schema accepts it yet or not: refusing a save for
a `positive()` number you have not reached yet would throw away everything typed after it.

What is missing is named instead. The field is marked and carries the reason under it, and
the header counts them — "2 problems", which jumps to the first one. The count comes back
with every autosave, so it clears as you fill things in.

**The schema decides at the publish.** *Publish…* on an entry with problems is disabled,
and a publish from the drawer is refused whole while any file in the set is missing
something: nothing is committed, and those rows are marked *Not ready to publish*. Finish
the entry and press Publish again. This is what keeps a blank new entry from committing a
file your own `content.config.ts` would reject and breaking the build behind it.

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
lists them with a checkbox each and commits the checked ones. What the drawer shows, what it
refuses, holding an entry back, and what happens after the commit — build status and revert —
are on [Pending changes and build status](pending-changes.md).

## Creating, renaming and deleting

**New entry** writes a draft and nothing else: the file appears in the repository at its
first publish, so an entry you started and abandoned never reaches git. The filename comes
from the name you type ([Configuration](configuration.md#entry-filenames)) and counts
names that exist only as drafts, so two unpublished entries cannot claim the same file.
The draft holds that name and nothing else: a required field is left out rather than
guessed at, and the editor shows every one of them as a problem until it is filled in.

**Rename** and **delete** are commits of their own, not drafts, because they move files
rather than change them ([Entry lifecycle](entry-lifecycle.md#renaming-and-deleting-an-entry)).
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

## Version history

Every entry has a **History** tab (`/admin/c/<collection>/<entry>/history`) — the git log of
that entry, read from GitHub when the tab is opened and stored nowhere. A commit that wrote
several of the entry's language files is **one version**: the entry is one thing, and the row
wears a chip per language it touched. A site with more than one language can narrow the list to
one of them.

- **Who made a version** is the person who pressed the button, taken from the [activity
  log](activity.md) row that carries the same commit. Commits the admin makes are the GitHub
  App's, so git records the App and not them; a commit somebody pushed themselves keeps the
  name git has. Past the log's 180-day window a version simply has no name against it.
- **Choosing a version** shows what it says that the live site does not, field by field, in the
  same per-field diff the [pending-changes drawer](pending-changes.md) uses — so what is marked
  is what restoring that version would change. **Ticking two** compares them with each other
  instead; a third is not offered.
- The list is paged at 30 versions; **Show older versions** reads the next page.
- An entry that has never been published has no history, and the tab says so.

**Restore this version** puts that version back as unpublished changes — the entry opens on it,
and publishing is the ordinary forward commit every other edit makes. Git is never rewritten:
the version you restored stays in the list, and so does everything after it. With unpublished
changes already on the entry, the confirmation says so — they are what the restore replaces.

Three things are the entry's as it stands rather than the version's: its **web address**,
whether it is **on the site**, and the **languages it is offered in**. Each of those is changed
from its own control, which writes the redirects that go with it; an old value coming back here
would move the page or take it away with nothing forwarding visitors. A language the version has
no file for is left where it stands — which, if the structure has changed since, is the
languages disagreeing, and the editor asks about it before the publish goes out.

## The endpoints

The routes behind all of this — the draft writes, the publish, the build status and the
revert — are in [The admin API](admin-api.md), with every entry route beside them.

## The content index

Git is the source of truth but slow to list: reading a collection through the GitHub
contents API is one request per file. So the titles are read at build time instead — the
build walks `src/content/`, collects every entry's title and `_status`, and puts the result
into the Worker, where only `/admin` can reach it. It is never served as a file, so a list
of your entries — hidden ones included — is not public.

It is derived, not authoritative: the site itself never reads it and the next build makes
it again. `astro dev` rebuilds it whenever a content file changes, so the list is current
without a restart.

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

The build pill has no **quota** state and none is planned: the Builds API carries no usage
against the free plan's monthly build minutes, so a build that fails for want of them reads as
an ordinary failure. The publish rows in the [activity log](activity.md) do not expand into
what the commit changed, though the drawer shows the same diff before it goes out. History cannot follow an entry through a rename — the addresses it
reads are the ones the entry has now. The drawer
runs no pre-publish checks, and **Publish this entry** does not name the redirect rules riding
along with it the way the drawer does.
