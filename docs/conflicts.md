# Publish conflicts

The check against the repository when anybody publishes, and the way out when it refuses.
The soft lock that keeps two people from typing over each other is
[Working together](working-together.md).

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

The `409` a publish gets, and the answer that settles it, are in
[The admin API](admin-api-drafts.md#resolving-a-conflict).

## Not yet

A conflict is resolved field by field, but a **block that moved** is not one of the
questions: where both sides reordered the same blocks, yours is the order that survives and
the repository's move is reported as merged rather than asked about. A block the repository
removed goes even where you edited something inside it.
