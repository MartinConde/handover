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
not edits and still work. The same rule holds outside the editor — **an open entry is
blocked for everyone else**: Rename, Delete, Hide and Show on the list, and Restore from
the Deleted view or the Activity log, all answer *Anna Berg is editing this entry — it can
be renamed once they are done* rather than writing under her.

When the lock runs out while somebody is waiting on it, the banner says so and offers
**Reload**, which opens the entry with the lock theirs.

## Take over

Waiting is not always the answer — the holder may be at lunch with the tab open, and the
entry frees itself two minutes after their last keystroke rather than the moment they walk
away. So the banner carries **Take over**, and it confirms before it does anything: it is
the one action that takes somebody else's work away.

```
Take over editing from Anna Berg?
Nothing Anna Berg has written is lost — there is one shared draft and you carry on from
where they left off. Their next save is refused and they are told you took over.
```

Both halves of that are true because there is only ever **one draft row per file**. Taking
over transfers the lock and re-reads the entry, so the form opens on what the other person
had typed, down to their last autosave. Nothing is copied, merged or thrown away.

The person it was taken from finds out **within about fifteen seconds**: their tab asks about
its lock every fifteen seconds while the entry is open and again the moment it comes back to the
front, and a save it makes in between is refused on the spot:

```
Anna Berg took over this entry. Everything you wrote is in the shared draft —
Anna Berg is carrying on from it.                                        [ Reload ]
```

The inputs go quiet at that moment and **Reload** opens the entry the way anybody else
waiting on it sees it. The words inside the last two seconds — whatever was still in the
autosave's wait — are the one thing that does not reach the draft; everything saved before
the take-over is what the new holder is now editing.

A take-over is logged as `lock-takeover`, with the name it was taken from
([Activity log](activity.md)).

Two things worth knowing:

- **The lock is per tab, not per person.** The same person with one entry open twice is
  two tabs on one draft row, so the second is refused like anybody else's and told *You have
  this open in another tab*; **Edit here instead** moves the lock, and the first tab's next
  save is refused with a note saying where the work went. A tab keeps its token while it
  moves between entries, so coming back to an entry in the same tab is not a second tab.
- **The saves are the half the server enforces.** `PUT /admin/api/drafts/...` refuses a
  write from anybody who does not hold the lock — that is what makes a take-over safe to
  lose, since the tab that lost the entry is typing into a form nobody told yet. The rest
  of it is what the admin draws: a rename, a web address or a language turned off is behind
  a control the lock disables, and a request made by hand still writes. It is there so two people do not type
  over each other, not as a permission.

**Removing a member** releases the locks they were holding, so the entries they had open
are free straight away rather than two minutes later. The remove dialog names them.

## A file that changed in the repository

The other half is git. Every draft row records the commit its file was loaded from and
that file's blob sha, and a publish compares the stored sha against the file **at the commit
it is being made against** — one commit, not "whatever the branch says at each read", so a
change pushed a moment earlier is caught rather than read as no change at all:

- **Nothing is written unless all of it can be.** If somebody changed one of those files
  in the repository since the editor loaded it, the publish is refused and no commit is
  made: the drawer marks that entry *Changed in the repository since you opened it* — same
  for a branch that moves while the commit is being written
- **The refusal is about that entry, not about the batch.** A refused entry takes itself
  out of the set — its checkbox goes off and cannot go back on — so pressing Publish again
  sends the rest. **Publish this entry** in the header has no rest to send, so it puts the
  same badge on the entry header and points at the drawer
- **A refused entry has two ways out: Resolve and Discard.** *Resolve* opens the
  three-way view [below](#resolving-it-field-by-field) and keeps what you wrote; *Discard*
  throws that entry's unpublished changes away and reads it from the repository again, so
  the entry is on their version. Reopening or editing the entry does not clear the refusal
  — the draft keeps the base it was loaded against until one of the two settles it
- A refusal is recorded: `publish-conflict` for a file that changed, `publish-failed` for
  the repository turning the commit itself down. Both rows expand to say which it was
  ([Activity log](activity.md)). Nothing else about a publish is logged as a failure —
  a file the schema is not done with is answered to whoever pressed the button

### Resolving it field by field

**Resolve** in the drawer opens the entry as two questions rather than as two versions.
Both sides are compared against the file as the draft was loaded — yours, and the
repository's — and the answer is per field:

- **A field only one of you changed is merged**, whichever side moved it, and reported as a
  fact rather than as a question: *Merged for you 3* opens into a line per field saying
  which side changed it. Blocks are matched by their `_id`, so a block added in the code and
  a block edited in the draft are two facts and not a disagreement
- **A field both of you changed is one question**, and it names what you both started from
  before it offers the two answers — *€ 435,000 or € 440,000* is unanswerable without the
  € 450,000 it came from. A `.md` body is answered whole: it says *rewritten* and offers the
  two sides, because there is no readable way to pick halves of one
- **Keep all mine** and **Take all theirs** answer every question at once. Neither touches
  what is already merged, and both say so on the button rather than behind a confirmation
- **Nothing publishes while a resolver is open**: the other entries would go out in the same
  commit, and this one is not ready to be in it. A conflicted entry nobody is resolving is
  only held back on its own row, and the rest still publish

Answering writes a new draft over the repository's version of the file, with the base moved
to what the repository has now. Nothing is committed: the entry is ordinary again and the
next Publish sends it. A conflict somebody else settled in the meantime says so rather than
being answered twice.

Every language of the entry is read, so a value the languages share is one question and not
one per file. A language the repository did not touch is not rewritten at all.

### Your own publish is not a conflict

The comparison is against the file as *that draft* was loaded, so a publish somebody else
made while you were typing is caught — but the one **you** just made is not. A publish
re-seeds the rows it committed on its own commit rather than throwing them away, so an
entry you carry on editing afterwards is measured against what was published, and the next
publish goes through. It is checked deliberately, because it will not happen by accident in
development: publish, type, publish again, and the second commit sits on the first.

## The endpoints

The lock heartbeat, the take-over and the `409` a save gets while somebody else holds the
entry are in [The admin API](admin-api.md#locks).

## Not yet

A conflict is resolved field by field, but a **block that moved** is not one of the
questions: where both sides reordered the same blocks, yours is the order that survives and
the repository's move is reported as merged rather than asked about. A block the repository
removed goes even where you edited something inside it.

What happens to a commit after it lands *is* reported — the top bar carries the build and
one-tap revert ([Pending changes](pending-changes.md#when-a-commit-goes-live)) — but a
build that fails names no entry, so which of a batch broke it is read in the build log.
