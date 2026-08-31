# Version history

Every entry keeps its git log, and a version can be read, compared and restored without
rewriting anything. Publishing is [Drafts and publishing](publishing.md); the diff a version
shows is the drawer's ([Pending changes](pending-changes.md)).

## The History tab

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

## Not yet

History cannot follow an entry through a rename — the addresses it reads are the ones the
entry has now.
