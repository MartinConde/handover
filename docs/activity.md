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
| Accounts | `login` (by password, by emailed link or through GitHub) · `invite` · `role-change`, naming the member as well as their id, so the row still reads once they are renamed or gone · `member-removed` · `password-set` (a first one, a change or a reset) |
| Publishing | `publish`, with the commit it made and how many files were in it · `publish-conflict`, when a file had changed in the repository since it was opened · `publish-failed`, when the repository turned the commit down · `lock-takeover`, naming who the entry was taken from · `hold-released` · `draft-discard`, when unpublished changes were thrown away — by **Discard** in the drawer, or by an older version restored over them, which `detail.restore` names by its commit |
| Entries | `entry-rename` and `entry-duplicate`, each with the name it had before or was copied from · `entry-delete` and `locale-off`, each with the commit that took the files away and the languages that went — which is what a **Restore** on the row puts back ([Entry lifecycle](entry-lifecycle.md#putting-a-deleted-entry-back)) |
| Media | `upload` — a picture stored, named by the file it was chosen as. Choosing one the site already holds is not an upload and is not a row · `media-archive` — put away or taken back out · `media-delete` — bytes and row gone, which only happens when nothing names them |
| Site | `redirect-added`, `redirect-changed` and `redirect-deleted` — a rule the client wrote by hand under Site settings → Redirects, each with the commit it made. A rule a rename or a hide wrote is part of that publish and is not a row of its own |
| Settings | `setting-changed` — one of the client's own [integration keys](diagnostics.md#integrations) set, replaced or removed. The name of the key, never its value |
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

Rows are kept for **180 days** and then deleted by a daily job ([Deploy](deploy.md#the-schedule)). This is the one thing the
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

**A publish that made no commit is a row too, and it expands.** The two that are recorded are
the two that are somebody else's work rather than your own drafts: `publish-conflict`, where a
file had changed in the repository since it was opened, and `publish-failed`, where the
repository would not take the commit — `detail.reason` is `ref-moved` when another change got
there first. Both rows open on a sentence saying what happened and what to do about it; nothing
was written either way. A publish refused because a draft is missing something its schema needs
is **not** a row: that is answered to whoever pressed the button, in the same response.

A hold that a publish took off is logged as `hold-released` the same way the toggle logs it,
with `detail.from` naming whoever had set it.

**A `publish` of one file names the entry and links to it.** A commit with more than one file
in it says how many instead, since there is no single entry to open. Either way the row carries
the first seven characters of the commit, which is how the log and git are lined up by hand,
and `detail.entries` lists the entries it carried — capped at eight, which is what the
[dashboard](dashboard.md) reads back once the draft rows are gone. **The row opens on what
the commit changed**, field by field and one entry at a time, in the same diff the
pending-changes drawer and version history draw: *Rooms 2 → 4*, never a YAML hunk. It is read
from git when the row is opened rather than with the page, and shows the first eight entries of
the commit with the rest counted.

**A delete carries its own way back.** The two rows that take a file away — `entry-delete` and
`locale-off` — have a **Restore** beside them, which undoes that commit with a commit of its own.
It is refused, in the server's own words, when something is at one of the paths again; nothing
is written either way. The entry list's **Deleted** tab is the same undo with a collection's
chrome around it ([Entry lifecycle](entry-lifecycle.md#putting-a-deleted-entry-back)).

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
*Anna Berg — template-saved contact EN*. Adding the sentence is one line beside the others.

## Reading it from your own code

The one route in the admin API meant to be called from outside the admin, and the one that does
not change between versions without a line in `CHANGELOG.md`:
`GET /admin/api/activity` — the newest fifty events for whoever is signed in, its four query
parameters and its cursor are in [The admin API](admin-api.md#activity).

See also: [Roles and permissions](roles.md) for who is an owner, and
[Sending email](email.md) for what a `mail-failed` row means.
