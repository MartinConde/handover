# Working together

Two people editing different entries never meet: a draft is one row per file, and each
one is written on its own. The same entry is where it matters, and two things stand in
the way of a lost afternoon — a **soft lock** while somebody is typing, and a check
against the repository when anybody publishes ([Publish conflicts](conflicts.md)).

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

## The endpoints

The lock heartbeat, the take-over and the `409` a save gets while somebody else holds the
entry are in [The admin API](admin-api.md#locks).

## Not yet

What happens to a commit after it lands *is* reported — the top bar carries the build and
one-tap revert ([Build status](build-status.md)) — but a
build that fails names no entry, so which of a batch broke it is read in the build log.
