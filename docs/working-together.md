# Working together

Two people editing different entries never meet: a draft is one row per file, and each
one is written on its own. The same entry is where it matters, and two things stand in
the way of a lost afternoon — a **soft lock** while somebody is typing, and a check
against the repository when anybody publishes.

## Being edited by…

Opening an entry takes a lock on it — every language at once, since the languages of one
entry share a structure and a block added in English is added to the German file in the
same write.

The lock is held by a heartbeat, and the heartbeat is typing: the admin extends it while
somebody is editing and it frees itself about **two minutes after the last keystroke**.
A tab left open on a train gives the entry back on its own; nobody has to remember to
close anything.

The second person to open that entry gets it read-only, under a banner:

```
Being edited by Anna Berg — active a few seconds ago
Being edited by Anna Berg — nothing typed for a minute; the lock frees itself after two
```

The second half is the useful half. Waiting on somebody mid-sentence and waiting on a tab
that has gone home are different decisions, and the banner is where the difference is.

What the lock takes away is everything that writes to any of the entry's files: the form,
the second language's column, the web address, **Publish…**, and the two answers to a
language with no file yet. Reading it, switching language and opening it side by side are
not edits and still work.

When the lock runs out while somebody is waiting on it, the banner says so and offers
**Reload**, which opens the entry with the lock theirs.

Two things worth knowing:

- **The lock is per person, not per tab.** The same person with one entry open twice is
  not two editors: both tabs write the same draft row and the later save wins, with no
  warning in either.
- **It is advisory.** It is what the admin draws, not something the draft endpoints
  enforce: a request made by hand still writes. It is there so two people do not type
  over each other, not as a permission.

**Removing a member** releases the locks they were holding, so the entries they had open
are free straight away rather than two minutes later. The remove dialog names them.

## A file that changed in the repository

The other half is git. Every draft row records the commit its file was loaded from and
that file's blob sha, and a publish compares the stored sha against the file at HEAD:

- **Nothing is written unless all of it can be.** If somebody changed one of those files
  in the repository since the editor loaded it, the publish is refused and no commit is
  made: the drawer marks that row *Changed in the repository since you opened it* — same
  for a branch that moves while the commit is being written
- **A refused file has one way out: Discard.** It throws that file's unpublished changes
  away and reads it from the repository again, so the entry is on their version and the
  next publish goes through. Reopening or editing the entry does not clear the refusal —
  the draft keeps the base it was loaded against until it is discarded

## The endpoints

```
POST /admin/api/locks/:collection/:slug  →  { "held_by", "mine", "expires_at", "base" }
```

The heartbeat. It takes the entry when nobody is editing it and pushes the caller's own
lock further out when they are, and it is what the editor sends as it opens and again
while somebody types in it. `held_by` is `{ "id", "name" }` for the person editing it and
`null` when nobody is, `mine` says whether that is the caller, and `expires_at` is when
the lock lapses — epoch milliseconds, about two minutes out. `base` is what each of the
entry's files was loaded against, `{ "src/content/listings/en/seaview-cottage.yaml":
{ "sha", "blob" } }`, so a tab open across somebody else's publish knows its diff base;
a language with no draft is not in it. `404` if the collection is not configured.

```
GET /admin/api/locks/:collection/:slug   →  { "held_by", "mine", "expires_at", "base" }
```

The same answer, taking nothing. This is what the person waiting polls: an entry changes
hands when somebody asks for it, never because their tab was watching when the last beat
lapsed.

## Not yet

Publishing is all-or-nothing: no checkboxes, no holding an entry back and no build
status. A lock cannot be taken over — the way past one is to wait for it. A file someone
changed in the repository can only be taken whole, by discarding yours; there is no
three-way merge and no way to keep your version over theirs. Those arrive in later
releases.
