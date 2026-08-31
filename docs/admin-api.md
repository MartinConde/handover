# The admin API

Every route under `/admin/api` is behind the admin session: without one they answer `401`,
and there is no other way in. They are the package's own surface — the admin talks to
itself through them — so they are here to be *debugged*, not to be built against from
outside. They can change between versions, and `CHANGELOG.md` says when they do.

Conventions across all of them:

- **`:collection` is a key from `cms.config.ts` and `:slug` is an entry's file name.**
  `404` whenever the collection is not configured, and generally when the entry has no
  file at all. A [global](site-files.md#globals) is addressed the same way, with `globals`
  as the collection and its file name as the slug
- **The browser never sends file contents to a publish.** What is committed is what the
  server has stored; a body says only *which* of it
- **`409` is somebody else's work in the way** — a lock, a file that moved in the
  repository, a name already taken. Where more than one kind of `409` is possible the body
  carries a `reason`, so they can be told apart
- Times are epoch milliseconds

Accounts, members and the mailer check are not here: they are Better Auth's, and what a site
has to set up for them is [Accounts and signing in](auth.md). The one exception to *not to be
built against* is [the activity read](#activity), which is meant to be called from your own
code; what it records is [Activity log](activity.md).

## The routes, by page

- [Entries](admin-api-entries.md) — reading a collection, an entry and its history; creating one; a language's own address
- [Entry lifecycle](admin-api-lifecycle.md) — rename, delete, duplicate, turning a language off, hiding, the deleted list, and the redirects table
- [Drafts](admin-api-drafts.md) — autosave, Create from English, machine translation, discard, drift, the per-field diff, the three-way view, holds
- [Publishing](admin-api-publishing.md) — what is waiting, the dashboard, publish and its checks, build status, revert and restore
- [Media](admin-api-media.md) — the library, the two calls around an upload, tags and archive, delete
- [Settings](admin-api-settings.md) — what the Settings screen reads, the connection checks, the client's integration keys

Locks and the activity read are below.

## Locks

The soft lock on an entry, and what it does to a save. What it means for two people
working at once is [Working together](working-together.md).

```
POST /admin/api/locks/:collection/:slug  { "tab": "…" }  →  { "held_by", "mine", "expires_at", "base" }
```

The heartbeat. It takes the entry when nobody is editing it and pushes the caller's own
lock further out when they are, and it is what the editor sends as it opens and again
while somebody types in it. `tab` is a token the tab made up once — the lock is the tab's,
so the same person's second tab is refused like anybody else's and reads `held_by` as
themselves with `mine` false. `held_by` is `{ "id", "name" }` for the person editing it and
`null` when nobody is, `mine` says whether that is the caller's tab, and `expires_at` is when
the lock lapses — epoch milliseconds, about two minutes out. `base` is what each of the
entry's files was loaded against, `{ "src/content/listings/en/seaview-cottage.yaml":
{ "sha", "blob" } }`, so a tab open across somebody else's publish knows its diff base;
a language with no draft is not in it. `404` if the collection is not configured.

```
GET /admin/api/locks/:collection/:slug?tab=…   →  { "held_by", "mine", "expires_at", "base" }
```

The same answer, taking nothing. This is what the person waiting polls: an entry changes
hands when somebody asks for it, never because their tab was watching when the last beat
lapsed.

```
POST /admin/api/locks/:collection/:slug  { "take": true, "tab": "…" }
```

Take over. The lock moves whatever it says, and the answer is the same shape with
`"mine": true`. Without the body it is an ordinary beat, so a tab that asks first is still
not a way to take an entry off somebody.

```
PUT /admin/api/drafts/:collection/:slug  →  409  { "held_by", "mine", "expires_at" }
```

What a save looks like once somebody else holds the lock: nothing is written, and the
answer names them so the screen can say who. Both draft endpoints answer this way — the
entry's own language and a translation ([Drafts](admin-api-drafts.md)).

## Activity

The read behind the [activity log](activity.md), and the one route here meant to be called from
your own code.

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
