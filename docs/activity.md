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
| Accounts | `login` (by password, by emailed link or through GitHub) · `invite` · `role-change` · `password-set` |
| Publishing | `publish`, with the commit it made and how many files were in it |
| System | `mail-failed` — a message the provider would not take |

**Per-field edits are not logged.** Typing in the editor autosaves every couple of seconds; a
row per keystroke would tell an owner nothing and would spend a site's whole daily write budget
on one busy afternoon. What an entry used to say is git's job, and the pending-changes drawer
shows what a publish is about to change.

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
