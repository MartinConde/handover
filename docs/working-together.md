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

The person it was taken from finds out **when the save their tab makes next is refused** —
not from a poll, so a tab nobody is typing in keeps its banner and changes nothing else:

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

- **The lock is per person, not per tab.** The same person with one entry open twice is
  not two editors: both tabs write the same draft row and the later save wins, with no
  warning in either.
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
- **A refused entry has one way out: Discard.** It throws that entry's unpublished changes
  away and reads it from the repository again, so the entry is on their version and the
  next publish goes through. Reopening or editing the entry does not clear the refusal —
  the draft keeps the base it was loaded against until it is discarded
- A refusal is recorded: `publish-conflict` for a file that changed, `publish-failed` for
  the repository turning the commit itself down. Both rows expand to say which it was
  ([Activity log](activity.md)). Nothing else about a publish is logged as a failure —
  a file the schema is not done with is answered to whoever pressed the button

### Your own publish is not a conflict

The comparison is against the file as *that draft* was loaded, so a publish somebody else
made while you were typing is caught — but the one **you** just made is not. A publish
re-seeds the rows it committed on its own commit rather than throwing them away, so an
entry you carry on editing afterwards is measured against what was published, and the next
publish goes through. It is checked deliberately, because it will not happen by accident in
development: publish, type, publish again, and the second commit sits on the first.

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

```
POST /admin/api/locks/:collection/:slug  { "take": true }
```

Take over. The lock moves whatever it says, and the answer is the same shape with
`"mine": true`. Without the body it is an ordinary beat, so a tab that asks first is still
not a way to take an entry off somebody.

```
PUT /admin/api/drafts/:collection/:slug  →  409  { "held_by", "mine", "expires_at" }
```

What a save looks like once somebody else holds the lock: nothing is written, and the
answer names them so the screen can say who. Both draft endpoints answer this way — the
entry's own language and a translation ([Drafts and publishing](publishing.md#the-endpoints)).

## Not yet

An entry someone changed in the repository can only be taken whole, by discarding yours:
there is no three-way merge, no per-field *Keep mine* / *Take theirs*, and no way to keep
your version over theirs. Nor is there any way to see what they changed from inside the
admin — the refusal names the entry, and the repository is where the change is read.
Publishing shows no build status either, so what happens to a commit after it lands is not
reported anywhere.
