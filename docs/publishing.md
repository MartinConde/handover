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
([Structured fields](structured-fields.md#in-the-admin)). Deleting the entry is the only
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
- **A row opens into what it would put in the commit**, field by field: the draft against
  the file in the repository as it is now, grouped by language, with the values every
  language shares in a group of their own and blocks addressed by `_id` so a block that
  moved says *moved*. The redirect rules riding along are in there too, under *Riding
  along*, since they are a consequence of the entry rather than a file anybody chose
- The rows are kept once the commit succeeds and re-seeded on it, which is what makes the
  next publish of an entry somebody is still editing not look like a conflict with this one
  ([Working together](working-together.md#your-own-publish-is-not-a-conflict)). They are
  cleared later, when the build carrying them is live
- **An entry the schema is not done with is refused the same way**, marked *Not ready to
  publish*, and likewise takes itself out. It has no button in the drawer: open the entry
  and fill in what is marked
- **An entry somebody changed in the repository is refused**, and the whole publish with
  it. That entry then takes itself out of the set — its checkbox goes off and cannot go back
  on — so pressing Publish again sends the rest. **Resolve** on that row answers it field by
  field and keeps what you wrote; Discard gives the entry up whole
  ([Working together](working-together.md#a-file-that-changed-in-the-repository))
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
else works as before. On a site nobody has published on yet the pill reports **your own last
deploy** — there is no commit of the admin's to ask about, but the site is serving something and
a blank top bar would be the wrong reading of it. Nothing offers to revert that one.

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

## The endpoints

The routes behind all of this — the draft writes, the publish, the build status and the
revert — are in [The admin API](admin-api.md), with every collection and entry route
beside them.

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
[activity log](activity.md) do not expand into what the commit changed, though the drawer
shows the same diff before it goes out. The drawer runs no pre-publish checks, and
**Publish this entry** does not name the redirect rules riding along with it the way the
drawer does.
