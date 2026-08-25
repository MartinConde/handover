# Activity log

"Who changed the price on Seaview Cottage?" Half the answer is in git — every publish is a
commit with the editor's name on it. The other half never reaches git: who signed in, who was
invited, whose role changed, which message never went. That half is a table in the site's own
D1, and `/admin/activity` is the screen over it.

Nothing has to be turned on. The events are written by the routes that cause them, from the
first sign-in onwards.

## What is recorded, and what is deliberately not

| Group | What lands there |
|---|---|
| Accounts | `login` (by password, by emailed link or through GitHub) · `invite` · `role-change` · `member-removed` · `password-set` (a first one, a change or a reset) |
| Publishing | `publish`, with the commit it made and how many files were in it · `lock-takeover`, naming who the entry was taken from · `hold-released` |
| System | `mail-failed` — a message the provider would not take |

**Per-field edits are not logged.** Typing in the editor autosaves every couple of seconds; a
row per keystroke would tell an owner nothing and would spend a site's whole daily write budget
on one busy afternoon. What an entry used to say is git's job, and the pending-changes drawer
shows what a publish is about to change.

Two kinds cover a pair of events each, because what happened is the same write. `password-set`
says which in `detail.how` — `first`, `changed` or `reset`. `member-removed` says whether the
person had ever signed in through `detail.pending`, so *removed Anna* and *revoked Lea's invite*
read differently. A removal also carries the address, since the `user` row it names is deleted by
the time anybody reads the log.

**A one-time link is never in a row.** A sign-in link, an invite link and a reset link are all
working credentials for as long as they live, so an `invite` row names the address and the role
and stops there, and a `mail-failed` row names only what the message was for. Somebody with a
copy of the database still cannot sign in with it.

Rows are kept for **180 days** and then deleted by the nightly job. This is the one thing the
admin ever deletes: it is telemetry about the site, not the site's content, and the git half of
the story is permanent anyway.

## Who sees what

An **owner** sees everything, including the events with no person behind them.

An **editor** sees only their own. That is a filter on the server, not a hidden tab — an editor
asking for somebody else's events gets their own back rather than a refusal, so the screen is
not a way to find out who else has an account.

## The screen

`/admin/activity`, under *Manage* in the sidebar. Both roles are offered it — an editor sees
their own events, which is the filter above and not a hidden tab.

A row is a sentence, not a table cell:

```
AB   Anna Berg published mill-house  EN  778cf4c        Publishing    3h ago
```

The initials belong to whoever did it, the chip names the group, and the time is relative.
A cron job has no person, so it gets a grey gear; somebody who has been removed since keeps
their events and gets a quiet ring, because the log outlives the account and drawing them as
the system would say a person's sign-in was a machine's.

**A time stops counting backwards after a week.** *Just now*, *20 min ago*, *4h ago*,
*Yesterday*, *3 days ago* — and then the date, `16 Aug 2026`, because "1 week ago" is not
something an audit can be read off. The day buckets are calendar days, so an event at 23:00
reads as *Yesterday* from 01:00 and not as *2 days ago*. The exact instant is in the row's
`<time datetime>` and in the tooltip; it is not spoken by a screen reader, which reads the
words.

**A `publish` of one file names the entry and links to it.** A commit with more than one file
in it says how many instead, since there is no single entry to open. Either way the row carries
the first seven characters of the commit, which is how the log and git are lined up by hand.

Three filters, all of them the server's:

| Filter | Takes |
|---|---|
| Kind | One of the six groups. The chip on a row is the same word |
| Person | A member. **Owners only** — an editor is already looking at one person's events |
| Entry | A file path, matched exactly. The box suggests the paths on screen and takes a typed or pasted one for anything older |

Because the match is exact and an entry has one file per language, filtering by entry filters by
*file*: `.../en/mill-house.yaml` and `.../de/mill-house.yaml` are two answers, not one.

Fifty rows at a time; **Load more** adds the next fifty underneath. Changing a filter starts
again from the newest — the cursor belongs to the query that produced it.

**A kind with no sentence of its own still gets a row.** Kinds arrive with the features that
write them, and the screen names one it does not recognise rather than throwing:
*Anna Berg — lock-takeover contact EN*. Adding the sentence is one line beside the others.

## Reading it from your own code

```http
GET /admin/api/activity
```

Answers the newest 50 events for whoever is signed in:

```jsonc
{
  "events": [
    {
      "id": "k3f9d2ab",
      "at": 1755864000000,          // epoch milliseconds
      "kind": "publish",
      "subject": "src/content/listings/en/seaview-cottage.yaml",
      "detail": { "files": 1 },
      "commitSha": "def4567",
      "user": { "id": "usr_1", "name": "Anna Berg", "email": "anna@example.com" }
    }
  ],
  "cursor": "1755863000000.b7x2p1qd"
}
```

- `user` is `null` for an event nothing did on somebody's behalf — a failed send, a cron job.
  A member who has since been removed keeps their events, so `user.name` and `user.email` can
  be `null` beside an `id` that no longer exists: the log outlives the account.
- `subject` is whatever the kind is about — an entry path for a `publish` of one file, the
  member's id for an `invite` or a `role-change`.
- `detail` is small JSON and differs per kind. Never file contents.
- `cursor` is `null` on the last page.

Four optional query parameters:

| Parameter | Takes |
|---|---|
| `cursor` | The `cursor` from the previous answer. Pass it back for the next 50 |
| `group` | `Accounts`, `Publishing`, `Entries`, `Media`, `Settings` or `System`. Anything else is ignored |
| `user` | A member's id. **Only an owner is asked** — an editor's own id is used whatever this says |
| `entry` | A `subject` to match exactly, which for entry events is the file path |

There is no `limit`: the page size is fixed, because a caller-chosen one is a database scan
everybody else on the site pays for.

Paging is by cursor rather than by offset. Two events can happen in the same millisecond, so
the cursor carries the time *and* the row id — an offset would serve one of them twice or skip
it, and would re-read every row already sent.

See also: [Roles and permissions](roles.md) for who is an owner, and
[Sending email](email.md) for what a `mail-failed` row means.
