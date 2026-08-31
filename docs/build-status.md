# Build status and revert

A commit is not a live site: what the top bar says while the host builds it, and the one
commit that undoes a publish. The drawer that makes the commits is
[Pending changes](pending-changes.md).

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
([Publish conflicts](conflicts.md#your-own-publish-is-not-a-conflict)).

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
