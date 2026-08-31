# Pending changes and build status

The top bar counts the entries with unpublished changes; its button opens the
**pending-changes drawer**, which lists them with a checkbox each and commits the checked
ones. What autosave stores and how an entry is published on its own are on
[Drafts and publishing](publishing.md).

## The drawer

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

## Checks before a publish

Above the list, the drawer runs a lint over the entries that are **selected** — the things
that build fine and look broken — and lists what it found grouped under the entry it is
about, worst first:

| | |
|---|---|
| **Error** | the visitor sees the page broken. One check is an error: a picture or a download whose bytes are not in the bucket and not in the library any more |
| **Warning** | the page says something nobody meant — a link to a page this site has none of, a link to a page that has no file in this language, a picture that has been archived, alt text left empty, a required translation standing blank, a menu item pointing at a page that is gone |
| **Note** | worth reading before the words go out — a translation made from a version somebody has changed since, a value machine translation filled in that nobody has read, a search title over the length Google shows, no search description, no sharing image |

**Only an error stops a publish.** With one in the list the button is disabled and reads
*Fix 1 error to publish*; with warnings it reads *Publish anyway (2 warnings)* and commits
exactly as it always did. The other two things that stop a publish are not checks: a draft
the collection schema is not done with, and languages that have drifted apart.

- **The set is what is selected.** Unchecking an entry takes its checks with it, and what a
  link is checked against is the site as *this* publish would leave it — so a link to a page
  that only an unselected draft would create is reported, and one to a page a selected draft
  creates is not
- The pass runs again when Publish is pressed, since the drawer may have been open a while
- Every item but the machine-translation note carries **Go to field**, which opens the entry
  where that field is edited
- A pass that could not be run says so and holds nothing back: a lint nobody could run is not
  a reason to stop you publishing your own site
- A rule that is noise on a particular site is turned off in `cms.config.ts` —
  `checks: { ignore: ['seo-description'] }` ([Configuration](configuration.md#checks))

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
`CLOUDFLARE_WORKER` ([Secrets](secrets.md)). Without them nothing is drawn and everything
else works as before.

In two cases the pill reports **your worker's newest deploy** rather than a commit, and offers to
revert neither: on a site nobody has published on yet, where there is no commit of the admin's to
ask about but the site is serving something all the same; and once ten minutes have gone by
without a build naming the commit, since the host's build list takes no commit filter and a
commit older than the builds on it can no longer be asked about. So an admin left open overnight
reads *Live since 08:04* rather than counting the hours since yesterday's publish.

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
