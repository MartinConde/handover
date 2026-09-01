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

## Across a rename

Renaming an entry from the ⋯ menu moves its files, and history follows: the list carries on
under the old name, and a version from before the rename says which name it is under — *2 weeks
ago · Anna · as old-mill*. Restoring one writes it under the name the entry has now; the entry
never moves back. A rename made by hand in the repository, without the admin, is not followed.

## What a version shows

A replaced picture is both pictures, *Before* and *After* with their file names, since a picture
has no history of its own — the drawer's diff draws it the same way. After a restore the entry
opens on the Content tab with a banner, *Restored the version from 2 weeks ago*, that stays
until those changes are published.
