# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- **A delete can be undone.** Every entry list has a **Deleted** tab beside **All**, listing what
  the admin took away in that collection — the whole entry, or one language of it — with who,
  when, and **Restore**. The same button is on the row in the activity log. Restoring undoes that
  commit with a commit of its own: the files come back as they were, the `reason: "deleted"`
  rules it appended come back out of `redirects.yaml`, and there is nothing left to publish
  afterwards. It is refused, naming the path, when something is at one of them again.
  [Entry lifecycle](docs/entry-lifecycle.md#putting-a-deleted-entry-back).

- **Turning a language off can be undone too**, and *Turn German back on* offers it: the German
  words come back from the repository instead of an empty form. What no commit can carry comes
  with it — the mark on the files that stayed goes back into their unpublished edits, so the
  next publish does not write the language straight off again.

- **`locale-off` is an activity kind**, with the languages that went. `entry-delete` now carries
  those languages too, as `detail.locales`, where it carried a file count.
  [Activity log](docs/activity.md).

- `POST /admin/api/restore { "commit_sha" }` and `GET /admin/api/deleted/<collection>`.
  [Admin API](docs/admin-api.md#entries).

- ⚠️ `revertCommit` in `@handover/core` answers with the files it wrote as well as their paths,
  so that `restoreCommit` beside it can read them. A route that answered with the whole result
  would now put file contents on the wire; both of ours answer `{ commit_sha, paths }`.

- The activity read, `GET /admin/api/activity`, is documented in
  [The admin API](docs/admin-api.md#activity) with the other routes rather than on the activity
  page, which is now about what is recorded and how a row reads.

- **Renaming or deleting an entry waits for the colleague who has it open.** Both actions
  commit every locale file at once, so neither runs under somebody else's edit; while they hold
  the entry it is refused with a sentence naming them. The lock then follows the rename, and a
  delete lets it go. [Entry lifecycle](docs/entry-lifecycle.md#renaming-and-deleting-an-entry).

- **A rename and a delete are in the activity log**, as `entry-rename` (with the name it had
  before) and `entry-delete` (with the commit that removed the files). [Activity log](docs/activity.md).

- **A third cron job, daily.** Git and the database cannot share a transaction, so a rename or a
  delete killed between its commit and its database write used to leave a draft row pointing at
  a file no longer in the repository — which the next publish would have written back. The sweep
  removes such rows once they are a day old, and leaves alone the two kinds of row that were
  never files: an entry that has not been published yet, and the row a delete leaves to keep the
  path off the entry list until the build catches up. No new trigger and no migration.
  [The schedule](docs/deploy.md#the-schedule).

- **Deleting a page asks where its visitors should go**, in the same dialog hiding uses: the
  collection's overview, another page picked from the list, a web address, or nowhere. The
  answer becomes one `reason: "deleted"` redirect per language, from the address that language
  served, in the very commit that removes the files. Until now every delete sent every language
  to the collection's overview. [Entry lifecycle](docs/entry-lifecycle.md#renaming-and-deleting-an-entry).

- `DELETE /admin/api/entries/<collection>/<slug>` takes that answer as `{ "redirect": … }`, in
  the four shapes the status route already takes. No body is still the collection's overview.
  [Admin API](docs/admin-api.md#entries).

- ⚠️ `deleteEntry` and `deleteLocales` in `@handover/core` take **a function** for the redirect
  target — `(locale) => string | undefined` — where they took one route for every language. A
  picked page has a different address in each language, and some languages none at all.

- **A listing that is sold comes off the site without being deleted.** The entry header has a
  status selector — **Live** or **Hidden**, and nothing called "draft" — and every row of the
  entry list has a **Hide**; checking several rows hides them together. A hidden entry keeps its
  file, stays in the admin with a badge, and the site stops rendering it.
  [Entry lifecycle](docs/entry-lifecycle.md#hiding-an-entry).

- **Hiding a page asks where its visitors should go.** The collection's overview, another page
  picked from the list, a web address, or nowhere — answered once, and for a batch once for all
  of them. The answer becomes one redirect per language, from the address that language served,
  and lands in `redirects.yaml` in the same commit as the status. Showing the entry again takes
  those rules back out in the commit that puts the page back.
  [Entry lifecycle](docs/entry-lifecycle.md#hiding-an-entry).

- ⚠️ **The schema in `content.config.ts` has to keep the reserved keys** for hidden entries to
  stay off the site. Astro drops what a `z.object` does not declare, so `_status` never reached
  the built data and `filterLive` could not see it. Wrap each collection's schema in a
  `withReserved` helper — [Template convention](docs/template-convention.md#content-configts)
  has the four lines. A collection declared `z.looseObject({})` needs nothing.

- `POST /admin/api/status/<collection>` hides or shows one entry or a batch, and takes the
  redirect answer. `GET /admin/api/entries` now says which rows are `hidden`, the entry route
  answers `hidden` and where it `redirects` while it is, and the list route carries the
  collection's `index`. [Admin API](docs/admin-api.md#entries).

- **Pointing at a page is a search box now.** A `reference` field, the Page / Entry half of a
  `link` field and the rich text toolbar's link button all open the same list: every entry the
  site has, grouped by collection, searchable by title or path, with a chip per language saying
  which ones that entry is written in. A `reference` was read-only JSON until now, and a link
  target was a path typed from memory. [Field types](docs/field-types.md#in-the-admin),
  [Structured fields](docs/structured-fields.md#in-the-admin).

- **A link the site would refuse is refused where it is typed.** `javascript:` and anything else
  outside `http`, `https`, `mailto`, `tel` and paths on the site is named under the box as it is
  typed, in the toolbar and in a `link` field's URL, instead of failing on save.
  [Field types](docs/field-types.md#rich-text).

- `GET /admin/api/entries` answers every collection's entries with the address each language
  serves them at. [Admin API](docs/admin-api.md#entries).

- **The keys the client owns are theirs to change.** Settings gains an **Integrations** section:
  a DeepL key — and, when there is a version with writing help in it, an AI provider's — can be
  pasted, replaced or removed by the site's owner without a deploy. Keys are stored encrypted in
  the site's own database under the new `HANDOVER_SETTINGS_KEY` secret, and are never shown
  again: each card gives the last four characters, who set it and when, which of the three
  sources is in force, and what taking it away falls back to. A DeepL key is tried against DeepL
  before it is stored. Every change is a line in the activity log naming the key and never its
  value. [Settings](docs/diagnostics.md#integrations).

- **A DeepL key pasted in Settings is the one that translates**, ahead of `DEEPL_API_KEY` on the
  Worker. A site that hands in its own `i18n.translate` is still translated by that code.
  [Translating](docs/translating.md#a-machines-first-draft).

- **Settings says what is connected.** The Manage group's Settings is now the owner's read-only
  view of the site: `cms.config.ts` as it came out, and a card per connection — GitHub, the
  bucket, email, translation, build status, the database — each tried for real when the page
  opens and again on **Test**. A check the site never configured reads *Not in use* rather than
  failing; one that was configured and refused shows the refusal itself, which is the sentence to
  forward. The failures are counted at the top with what stops working while they stand.
  [Settings](docs/diagnostics.md).

- **Send a test email has a button.** It is the one check that never runs on its own, and it goes
  to the address of whoever is signed in. **Simulate a conflict** has one too, under *Developer
  tools*, while the site is running in development. [Settings](docs/diagnostics.md).

- **An invite the mailer refused points at Settings.** The notice on the Members screen said to
  ask your developer; it now names the screen where the mailer's own sentence says which
  credential is missing.

- **The editor previews the page.** **Preview** in the entry header opens the page beside the
  form, in the language on screen: it follows the autosave, refreshes on demand, opens in a tab
  and can be read at three widths. An entry the site has never published previews at the address
  it will get, with a banner saying so, and a draft the schema still refuses is a card naming
  each field instead of half a page. A build without `PREVIEW_ENABLED` says so in the pane
  rather than framing a 404. [Preview](docs/preview.md).

- **Preview renders the page.** `/_preview/<path>` now calls the `load()` your own loader
  exports, over a source that lays the D1 drafts on the build's content, and renders the
  component that loader names — so an unpublished edit shows in the real templates, and the
  page around it is whole. A draft its collection's schema refuses is `422` naming the field.
  For that, a loader exports its component beside its `load` (`Page`, and `loadIndex`/`Index`
  for a collection index), and every page's data-gathering — globals included — is in the
  loader rather than in the layout.
  [Preview](docs/preview.md), [Loaders and pages](docs/loaders.md).

- **`Template convention` is two pages.** The rules and the two schema files stay in
  [Template convention](docs/template-convention.md); loaders, pages and layouts are
  [Loaders and pages](docs/loaders.md).

- **The build pill stops counting on an old commit.** The host's build list can only be asked
  for a worker's recent builds — there is no commit filter — so a commit that had scrolled off
  it read as *Building…* for as long as the admin was open, and the draft rows that build was
  carrying were never cleared. Ten minutes without a build naming a commit is now as long as
  the pill waits; past that it reports the worker's newest deploy.
  [When a commit goes live](docs/publishing.md#when-a-commit-goes-live).

- **Preview has a route and a gate.** `/_preview/<path>` is injected only where
  `PREVIEW_ENABLED` is set on the build, needs an admin session, serves only addresses the
  site's own routes serve, and answers `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex, nofollow` and `Content-Security-Policy: frame-ancestors 'self'` on
  every response.
  [Preview](docs/preview.md).

- **Conflicts are answered field by field.** An entry somebody changed in the repository used
  to have one way out — throw your draft away and take theirs. The drawer's **Resolve** now
  opens the entry as two questions rather than two versions: fields only one side changed are
  merged and counted (*Merged for you 3*), fields both sides changed are asked one at a time,
  each naming what you both started from, and **Keep all mine** / **Take all theirs** answer
  them all at once. Blocks are matched by `_id`, so a block added in the code and a block
  edited in the draft are not a disagreement. Answering writes a new draft over the
  repository's file and the entry publishes normally; nothing is committed by the answer.
  [Working together](docs/working-together.md#resolving-it-field-by-field).

- **A drawer row opens into what it would publish.** The per-field diff below is now on every
  row of the pending-changes drawer, with the redirect rules riding along under *Riding along*.

- **`POST /admin/api/checks/conflict`** makes a conflict to look at on a scratch entry, so the
  three-way view can be tried on a live site without hand-crafting commits. Owner only, and it
  commits: [the admin API](docs/admin-api.md#publishing) says what it leaves behind.

- **Per-field diff.** `diffEntry()` in `@handover/core` says what changed between two states of
  one entry — the draft against the file in git, or one version against another — as fields
  rather than as lines, so nothing about the file format reaches the screen. The changes are
  grouped by language with the values every language shares lifted into a group of their own, a
  language nothing happened in says so rather than going quiet, and blocks are addressed by
  `_id`, so a block that moved says it moved instead of arriving as one deletion plus one
  addition. `pnpm --filter @handover/ui fixtures` renders every field type's diff on a page of
  its own.

- **Background jobs.** One Cron Trigger every five minutes, one `scheduled` handler, and a
  registry that decides what is due: media reconciliation hourly, activity-log retention
  daily. A job that does something or throws writes a `cron-<job>` row in the activity log;
  a quiet tick writes nothing, and one failing job cannot hold up the others.
  ⚠️ **A site upgrading to this needs two lines in `wrangler.jsonc`** — `triggers.crons` and
  a `main` pointing at its own four-line `src/worker.ts` — both in
  [Deploy](docs/deploy.md#the-schedule). Without them nothing breaks; nothing runs either.

- **Site settings.** The globals a site declares in `cms.config.ts` are editable in the admin,
  above the collections: one card per global, and a form that is the entry editor without the
  parts a file the schema names cannot have — no hide, no rename, no duplicate, no delete.
  Locks, the language switcher, side by side, "Not ready yet" and one-commit publish are that
  screen's and work unchanged. What a card is called comes from the schema:
  `.meta({ label, description })`, falling back to the key
  ([Site files](docs/site-files.md#globals)).

- **`_ref` blocks render.** A block with `_ref: "globals/<key>"` is filled from that global in
  the language the page is in, so one call to action can be edited once and shown on every page
  that points at it. `<Blocks />` takes a `globals` map for it — `globalsAt()` builds one — and
  fills every `_ref` in the tree, so a block component that nests `<Blocks />` is unchanged
  ([Blocks](docs/blocks.md)). ⚠️ A page whose blocks contain a `_ref` now needs that prop.

- **Two build-time refusals about globals**: a `_ref` naming a global `cms.config.ts` does not
  declare, and a declared global with no file in the default language. Both name the file and
  the key, the way an unregistered block type already did.

- Docs: `content-format.md` split — hiding, creating, renaming and deleting an entry are
  [Entry lifecycle](docs/entry-lifecycle.md); `rendering.md` split — `<Blocks />` and the
  component registry are [Blocks](docs/blocks.md).

- **`image` and `file` fields are editable.** A filled one is a card — the picture at the
  field's own ratio with its focal dot, or the file's type and size — carrying the alt text or
  the display name, Replace and Remove. An empty one is a drop zone that takes a file dropped
  on it and opens the picker otherwise. The picker is the library scoped to the field that
  opened it: upload there or choose what is already stored. A language being translated gets
  the alt or the display name and nothing else
  ([Pictures and files in a field](docs/media-fields.md)).

- **A field carries its own preset**, `image({ ratio, max, min })`: the ratio it is shown and
  cropped at, the cap an upload is downscaled to on the way in, and the optional floor the
  picker refuses under. The floor is measured on the *crop* — the widest crop at the field's
  ratio the picture can yield — so a 900 × 1600 phone photo cannot pass a 1600 hero sideways,
  and the refusal says both numbers. A field without a floor refuses nothing, and a picture the
  library has no size for is refused by every image field, since the field stores those numbers.
  ⚠️ **Breaking:** `image` and `file` are now functions — `image()` and `file()` where they
  used to be bare schemas.

- **PDFs and other files upload**, under `files/` keys and through the same pipeline minus the
  canvas step. A file is stored as a download (`content-disposition: attachment`) and its first
  bytes are read back on confirm: an object whose signature is not the type it was uploaded as
  is deleted, so a renamed `.html` never reaches the CDN domain. ⚠️ The bucket's CORS rule needs
  `content-disposition` in `allowed.headers` or every file upload fails the preflight
  ([Media](docs/media.md#2-let-the-admins-origin-write-to-it)).

- **A file's display name is optional.** It is the translatable half, so a picture or a PDF
  chosen in one language no longer leaves another language's file invalid and unpublishable
  until somebody types a name for it ([Languages](docs/i18n.md)).

- **`GET /admin/api/media?kind=images|files`** is the library the picker reads: newest first,
  archived left out ([The admin API](docs/admin-api.md#media)).

- **`media.md` is two pages.** The bucket, its setup and what an upload does stay;
  what a field asks of a picture and how a client chooses one are
  [Pictures and files in a field](docs/media-fields.md).

- **Pictures upload to R2.** The browser normalises what was chosen — downscaled to 2400px,
  re-encoded as WebP, EXIF stripped — hashes it, and asks the admin whether the site already
  has those bytes; if it does, nothing is uploaded at all. Otherwise it PUTs them straight to
  the bucket on a URL signed for five minutes, and the Worker reads the object back afterwards:
  an object that is not the size or the type that was declared is **deleted** and no row is
  written. Objects are named by the SHA-256 of their own bytes, so the same picture is one
  object and one row however many times it is chosen. The setup — bucket, CORS rule, hostname,
  four env values — is [Media](docs/media.md), and the widgets that will call this are next.

- **`POST /admin/api/media`** answers either the asset the site already holds or a presigned
  PUT for a key it chose, and **`PUT /admin/api/media/:hash`** is the verify-or-delete that
  turns the object into a row ([The admin API](docs/admin-api.md#media)).

- **`media.publicBase` in `cms.config.ts`** — where the bucket is served from, so content files
  keep storing `media/…` keys and never URLs ([Configuration](docs/configuration.md#media)).
  Beside it, `R2_ACCOUNT_ID` and `R2_BUCKET` are vars and `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY` are secrets; without all four the admin refuses uploads and names
  what is missing ([Deploy](docs/deploy.md#secrets)).

- **`upload` in the activity log**, named by the file it was chosen as. Choosing a picture the
  site already holds is a reuse rather than an upload, and writes no row.

- **`field-types.md` is two pages.** The scalars, rich text, links and labels stay; `image`,
  `file`, `embed`, `seo`, `reference` and the three nesting types are now
  [Structured fields](docs/structured-fields.md).

- **The endpoints have a page of their own.** `docs/admin-api.md` collects every route the
  admin drives — entries, drafts, publishing, locks — where they had been split between
  `publishing.md` and `working-together.md`, and `publishing.md` had become half API listing.
  Nothing about the routes changed; both pages now point at it.

- **The top bar says whether the site has caught up with the commit.** A publish is a commit and
  a commit is not a live site — there is a one-to-three minute host build behind it — so the
  shell now polls **Workers Builds** and shows *Building… 1m 20s* · *Live since 14:02* · *Build failed*,
  with a banner while a build is running saying the admin may reload briefly under you. It needs
  a read-only `CLOUDFLARE_API_TOKEN` and a `CLOUDFLARE_WORKER` var; without them no pill is
  drawn and everything else is unchanged ([Deploy](docs/deploy.md#secrets)). Before anyone has
  published, it reports your own last deploy instead, which is still what the site is serving.

- **One-tap revert.** *Revert last publish* sits in the failed pill and *Revert this publish*
  in the drawer's result panel. It is **not `git revert`** — the trees API has no three-way
  merge, so the inverse is composed: every file the commit touched goes back to its blob at the
  parent (a rename counting as both of its names), `redirects.yaml` is recomputed rather than
  restored, and a file that has moved on since is refused rather than overwritten. The changes
  the commit carried come back as unpublished changes
  ([Drafts and publishing](docs/publishing.md#when-a-commit-goes-live)).

- **Draft rows are cleared when the build carrying them is live.** Green is not enough: a row is
  also what an open tab publishes against, so an entry somebody is still editing keeps its row
  until their lock runs out.

- **`GET /admin/api/build`** answers `{ "commit_sha", "state", "started_at", "live_at", "committed_at" }`,
  and **`POST /admin/api/revert`** takes `{ "commit_sha" }` and answers the inverse commit, `409`
  naming a file that has moved on since
  ([Drafts and publishing](docs/publishing.md#the-endpoints)).

- **The pending-changes drawer picks what goes out.** It lists **entries** rather than files
  now — one row per entry, with its title, the languages of it that are waiting and what its
  address changes owe — and each row has a checkbox. Everything is checked except entries on
  hold, so "publish all of it" is still one press; checking a held entry includes it and
  releases the hold, which the drawer says before the button is pressed. Selection is per
  publish and is not stored ([Drafts and publishing](docs/publishing.md#publishing)).

- **Publish this entry.** The entry header's button now commits that entry on its own instead
  of opening the drawer. It confirms first, naming every language file that goes with it.

- **A refused entry no longer blocks the batch.** An entry somebody changed in the repository,
  or one the schema is not done with, takes itself out of the checked set and says why on its
  own row, so pressing Publish again sends the rest. Taking theirs whole with Discard is still
  the only way out of a conflict — there is no three-way merge
  ([Working together](docs/working-together.md#a-file-that-changed-in-the-repository)).

- **`GET /admin/api/drafts` answers entries, not files.** `{ "entries": [{ "key", "title",
  "collection", "locales", "files", "redirects", "updated_at", "held_by" }] }`. The grouping is
  done on the server because an entry's title comes from the build's content index, which
  nothing outside the Worker can read ([Drafts and publishing](docs/publishing.md#the-endpoints)).

- **Every read a write is made from names a commit.** GitHub answers the contents API from a
  replica, cached under the ref it was asked for, so two reads of the branch seconds apart can be
  two different commits. A publish took `base_sha` from one read and the blobs it compares against
  it from others: if the blob read was the older one, a colleague's commit was reported as no
  change at all and the publish quietly wrote over it — the ref update had nothing to refuse,
  since the parent was current. A publish, an autosave's first read of a file, and a rename,
  delete or language-off now read every file at the one commit they are made against, and
  `getFile` takes that commit ([Working together](docs/working-together.md#a-file-that-changed-in-the-repository)).

- **A publish can be of one entry or a chosen set.** `POST /admin/api/publish` now takes
  `{ "entries": ["listings/mill-house"] }` and commits those entries — every language of each,
  with the redirect rules they owe; the entries left out keep theirs until they are published
  themselves. No body still publishes everything pending that is not on hold. An entry that is
  **on hold** goes out when it is named, which releases the hold and logs `hold-released`
  against whoever set it. The drawer's checkboxes that will send this arrive next
  ([Drafts and publishing](docs/publishing.md#the-endpoints)).

- **Your own publish no longer looks like a conflict.** The rows a publish commits are re-seeded
  on that commit rather than thrown away — on the bytes it actually wrote, so a translation the
  publish stamped on the way past does not report a conflict with itself. Carry on typing in an
  entry after publishing it and the next publish goes through; a commit somebody *else* made is
  still caught. Rows are kept until the build carrying them is live, so a title you published
  reads right in the entry list straight away
  ([Working together](docs/working-together.md#your-own-publish-is-not-a-conflict)).

- **A publish that made no commit is in the activity log.** `publish-conflict` when a file had
  changed in the repository since it was opened, `publish-failed` when the repository turned the
  commit down (`detail.reason` is `ref-moved` when another change got there first), and both rows
  expand on the activity screen to say what happened. A draft the schema is not done with is not
  a row — that is answered to whoever pressed the button. `lock-takeover` and `hold-released` read
  as sentences now instead of naming their kind ([Activity log](docs/activity.md)).

- **Take over an entry somebody else is editing.** The *Being edited by…* banner now carries
  **Take over**, which confirms first and then moves the lock: the entry is re-read, so the form
  opens on what the other person had typed — there is one shared draft and nothing is copied or
  thrown away. They find out when the save their tab makes next is refused, under *Anna Berg took
  over this entry. Everything you wrote is in the shared draft*, with the inputs quiet and
  **Reload** the way back in. `POST /admin/api/locks/:collection/:slug` takes `{ "take": true }`
  for it, and both draft endpoints now answer `409` with the lock when the caller does not hold
  it — the saves are the half the server enforces. Logged as `lock-takeover`
  ([Working together](docs/working-together.md#take-over)).

- **"Not ready yet" holds an entry back from everybody's publish.** A toggle in the entry header,
  next to the status: the header tints and a batch publish leaves that entry out — every language
  of it, and its schema is not checked either, so a half-written page nobody is holding back is
  still the only thing that can refuse a publish. The drawer lists held files under **On hold**,
  badged with who holds them, and the button counts what is actually going out. It is a courtesy
  rather than a permission — anybody can take it off, which is logged as `hold-released` — and it
  is cleared with the draft when the entry publishes or is discarded.
  `POST /admin/api/hold/:collection/:slug` takes `{ "hold": true }`
  ([Drafts and publishing](docs/publishing.md#holding-an-entry-back)).

- **Two people can no longer type over each other.** Opening an entry takes a soft lock on it
  — every language at once, since they share a structure — and the lock is held by typing: the
  admin extends it while somebody edits and it frees itself about two minutes after the last
  keystroke, so a tab left open lets go on its own. The second person gets the entry read-only
  under *Being edited by Anna Berg — active a few seconds ago*, which ages into *nothing typed
  for a minute; the lock frees itself after two* because that is the whole of the decision; when
  it lapses the banner says so and offers **Reload**. What goes quiet is everything that writes
  to any of the entry's files — the form, the second language's column, the web address,
  **Publish…** and the answers to a language with no file. `POST /admin/api/locks/:collection/:slug`
  is the heartbeat and `GET` the same answer taking nothing; both carry the `base_sha`/`base_blob`
  each of the entry's files was loaded against. Removing a member releases their locks, and the
  remove dialog names the entries first ([Working together](docs/working-together.md)).

- **An Activity screen at `/admin/activity`.** The log now has a page over it, and both roles
  get it: an owner sees everybody, an editor sees their own, and which is which stays the
  server's filter rather than the screen's. Each row is a sentence — *Anna Berg published
  mill-house EN 778cf4c*, *Martin invited lea@example.com as an editor*, *An invite could not be
  sent* — with the group as a chip, a relative time that **becomes a date once a row is a week
  old**, and the exact instant in `<time datetime>`. A publish of one file links to the entry;
  every publish carries its short commit. Filters for kind group, person (owners only, since an
  editor is already looking at one person) and entry path, and **Load more** for the next fifty.
  A kind nothing has written a sentence for yet is still drawn, named by its kind, so a screen
  does not break on the row that adds one ([Activity log](docs/activity.md#the-screen)).

- **An activity log, and the first events in it.** Signing in, being invited, having a role
  changed, setting a first password and publishing each write one row to the `activity` table
  the Phase 3 migration created — no new migration, and nothing to turn on. `GET
  /admin/api/activity` reads the newest 50 for whoever is signed in: **an owner sees everybody
  and an editor sees only their own**, filtered on the server, so an editor naming somebody else
  in the query string gets their own events back rather than a refusal. Paging is by cursor
  rather than offset, because two events can share a millisecond. **No one-time link and no
  token reaches a row** — an `invite` names the address and the role, and a message the provider
  refused leaves a `mail-failed` row naming only what it was for, which is the first time a
  failed reset is visible anywhere but `wrangler tail`. Removing somebody, and revoking an invite
  nobody opened, are recorded with the address, which is the only record left once the `user` row
  is deleted; a password being **changed** or **reset** is recorded as well as a first one being
  set. The members screen's **Last sign-in** is
  now the newer of a live session and a `login` event, so signing out everywhere no longer erases
  it ([Activity log](docs/activity.md), [Roles and permissions](docs/roles.md#how-somebody-signs-in)).

- **A Members screen at `/admin/members`.** Owners can now invite people, change a role between
  owner and editor, resend an invite and remove somebody, without a `wrangler d1 execute` in
  sight. An invite is a `user` row and an emailed link: the person opens it, which signs them in,
  and their account page offers them a first password. That link works once and lasts **three
  days**, where an ordinary sign-in link lasts fifteen minutes. The list's **Sign-in method**
  column is worked out from the account rows rather than stored, so it says `GitHub`,
  `Password + email link` or `Email link only` and cannot go stale. Two rules are refused by the
  server rather than only greyed out in the menu: **the last owner cannot be demoted or removed**,
  and **nobody can remove themselves**. The first is one database statement rather than a count
  read beside a write, so two owners demoting each other at the same instant cannot both succeed. Removing somebody ends every session and deletes their
  password and linked accounts; their unpublished drafts stay, because a draft belongs to the
  site ([Roles and permissions](docs/roles.md#members--adminmembers)).

- **Two more mailers: SMTP and Cloudflare.** `mailer` in `cms.config.ts` now takes
  `{ provider: 'smtp', from, host, port? }` on `SMTP_USER` and `SMTP_PASS`, or
  `{ provider: 'cloudflare', from }` on a `send_email` binding named `EMAIL` and no secret at
  all. A provider named without its credential is treated as no mailer, so the login never draws
  a sign-in-link button that cannot work, and the settings check answers `503` naming the half
  that is missing. SMTP speaks implicit TLS only — the port has to be encrypted from the first
  byte, since a session that starts in plaintext and is refused its upgrade would hand the
  server your password in the clear. Cloudflare sending to anyone but yourself needs the Workers
  Paid plan, and the refusal says so in as many words ([Sending email](docs/email.md),
  [Configuration](docs/configuration.md#mailer), [Deploy](docs/deploy.md#secrets)).

- **Three ways into `/admin`, and an account page.** The login now offers an emailed sign-in
  link and *Continue with GitHub* beside the password, and *Forgot password?* mails a link to a
  reset page at `/admin/reset`. Every one of them is closed to strangers: a link is mailed only
  to an address that already has an account, opening one minted for an address that does not
  makes no user, and GitHub signs in only against a row that already carries the same verified
  email. `/admin/account` is everyone's own page — display name, email and role, a password form,
  and the sessions they are signed in on with *Sign out everywhere*. Somebody who arrived by an
  emailed link and has no password is offered one there.

- **`HANDOVER_BASE_URL` is a new var, and the two emailing methods need it.** It is the site's
  own origin, stated in `wrangler.jsonc` rather than read off the request, because a `Host`
  header is written by whoever sent the request and an emailed sign-in link built from one is a
  working credential pointing somewhere else. Without it the login shows the password form and
  nothing else — the same answer a missing key gets. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
  turn on GitHub; the callback URL is `<HANDOVER_BASE_URL>/admin/api/auth/callback/github`. The
  trip to GitHub and back has five minutes on it, and running out of them now comes back to the
  login rather than to Better Auth's own error page
  ([Accounts and signing in](docs/auth.md), [Deploy](docs/deploy.md#secrets)).

- `docs/auth.md` split three ways as it grew: [Accounts and signing in](docs/auth.md) is the ways
  in, [Roles and permissions](docs/roles.md) is who may do what, and [Sending email](docs/email.md)
  is the `mailer` block and the check that proves a key. Existing links to `auth.md` still land on
  the right page; the seeding recipe moved from `#2-` to `#3-create-the-first-account`.

- **Handover can send email.** `mailer` in `cms.config.ts` names who sends it — the provider the
  package ships, `{ provider: 'resend', from: 'You <hello@your-site.com>' }` on a
  `RESEND_API_KEY` secret, or a function of your own given the message. With one configured, an
  owner can `POST /admin/api/checks/email` and the admin mails them at their own account's
  address, answering with the provider's id for the message; the settings screen puts a button
  on it later. Editors get `403`, a site with no mailer gets `503` naming what is missing, and a
  provider that refuses gets `502` carrying the provider's own words — an unverified sending
  domain reads as itself rather than as a number
  ([Configuration](docs/configuration.md#mailer), [Sending email](docs/email.md)).

- **`/admin` has accounts instead of one shared password.** Sign in with an email address and a
  password against the site's own D1; sessions are signed with `BETTER_AUTH_SECRET`, which
  replaces the old shared-password variable in `.dev.vars` and in `wrangler secret put`. Nobody
  can create an account: `POST /admin/api/auth/sign-up/email` answers 400 and writes no row, and inviting
  people is an owner-only endpoint. Two roles live in `user.role` — `owner` and `editor`, and an
  unrecognised value reads as `editor`. The sidebar's new **Manage** group hides *Members* and
  *Settings* from an editor, and the top bar shows who is signed in with a *Sign out* button.
  Password sign-in allows three attempts per ten seconds per address before a 429, and the
  session cookie is `Secure` whenever the request arrived over https.
  **Upgrading: set `BETTER_AUTH_SECRET` and insert the first owner by hand** — there is no
  sign-up, so a site with no rows in `user` cannot be signed in to
  ([Accounts and signing in](docs/auth.md)).

- `astro-handover/schema` exports the tables the rest of the CMS runs on — `media`, `locks`,
  `activity`, `settings` and `cron_state` — plus the login's `user`, `session`, `account`,
  `verification` and `rate_limit`, generated from the Better Auth config. Upgrading needs one
  `handover db generate`; the build fails until it has run. Nothing drops or changes an existing
  column, so a database holding drafts keeps them.

- `docs/rendering.md` shows the language switcher on a page that is not an entry.
  `getEntryLocales()` answers about a collection and a slug, so an index builds its own pair
  from `entryUrl()` and the site's locales.

- `entryAddress()` is exported: the address one file serves at, which is the `slug` in its data
  or its file name. A prerendered route on a `localizedSlugs` collection builds its
  `getStaticPaths` from it, and it is the only safe way to read that key — Astro puts a warning
  getter on `slug` for every entry without one.

- **A language that already has a file can now be turned off.** The second column's header offers
  *Turn German off*, and confirming it commits: the German file leaves the repository, the
  languages the entry keeps go into the files that stay, and the URL German served redirects to
  the collection's `index` under its own language segment — none where the collection has no
  `index`, which the dialog says before you press. Turning off the last language an entry has a
  published file in is refused with `409` — that is deleting the entry, which is what `DELETE` is
  for, and a language whose file is only a draft does not stand in for a published one. An
  `_i18n` naming a language that went is dropped from the files that carry it, and a language
  whose file is only an unpublished draft makes no commit — the draft is thrown away. The entry
  response gained `route`, `index` and `prefixDefaultLocale` for the URLs the dialog names.

- **An entry with no file in the site's default language can now be opened.** The language an
  entry's structure is edited in — and that its translations are made from — is the entry's own
  rather than the site's: the default language where the entry has a file in it, and otherwise
  the first declared language it does. A German-only page used to be listed in the admin and
  answer *No such entry* on click, with no way in: Create from English refused to create the
  English. It now opens in German and offers *Create from German*. The entry response carries
  `sourceLocale` beside `defaultLocale`, which stays the site's and stays what decides whether a
  language's URLs carry its segment. `POST /admin/api/drafts/:collection/:slug/:locale` no longer
  refuses the site's default language on sight — it refuses any language the entry already has a
  file in, with `409` — and `SourceOf`, the callback `publishDrafts` takes, now returns a promise.

- Renaming or deleting an entry writes one redirect per language, under that language's own
  segment, from the URL that language actually served: on a `localizedSlugs` collection that is
  the `slug` in the language's own file, so a rename leaves a language whose address is its own
  alone. A delete sends each language to its own copy of the collection's `index`. `renameEntry`,
  `deleteEntry` and `duplicateEntry` take `i18n` and `localizedSlugs` on their `EntryLocation`
  where they took `locales`, and `setEntryAddress` takes the collection's form. A duplicate no
  longer copies the original's address.

- Reading a collection whose `glob` loader is missing `generateId` now throws, naming the option,
  instead of quietly matching no entry: Astro files an entry with a `slug` under its address, and
  a `localizedSlugs` collection keeps its address there. **A loader's miss is now a value rather
  than a thrown error** — `return undefined` and let the page answer `404`, instead of throwing
  and catching it in the route. A `.catch()` around the call swallows everything, which is what
  turned this new message back into a silent 404. `template-convention.md` shows the new shape.

- Every write stamps `_version` and writes the file's keys in schema order, not the editor's save
  alone: reconciling drift, turning a language off, setting an address and duplicating an entry
  all leave a file the way `content-format.md` describes it. A file written by an earlier version
  has its keys reordered by the first write that touches it.

- A web address per language, per collection: `localizedSlugs: true` beside a collection's
  `route` lets each language's file carry an optional `slug` overriding the file name in the
  URL. Empty falls back to the file name, so turning it on changes no URL until somebody fills
  one in; the file name stays the entry's id across the languages. The schema has to declare
  `slug: z.string().optional()` or the build stops, the way a bad `titleField` does. The
  address is edited in the entry header rather than in the form, validated like a file name and
  unique within its collection and language with drafts counted, and publishing a change to a
  live one writes one `slug-change` redirect for that language alone. Sites resolve their own
  route with `entryAt('default', source, cms, collection, locale, address)`, and
  `<LocaleSwitcher />` links each language at the address that language serves.
  `POST /admin/api/entries/:collection/:slug/address/:locale` is the write. Such a collection's
  `glob` loader needs a `generateId` that returns the file's path: Astro's default files an
  entry under its `slug`, which is where the address lives.

- A language switcher for the site. `<LocaleSwitcher locales current />` from
  `astro-handover/LocaleSwitcher.astro` draws the languages one entry can actually be read in;
  `getEntryLocales('default', source, cms, collection, slug)` is what answers that — a file in
  that language's folder, not hidden — and `entryUrl()` is one of its URLs on its own, with the
  language segment `prefixDefaultLocale` asks for. An entry that exists in one language draws no
  switcher at all. `isLive()` takes an optional third argument, the language, for a caller that
  holds an entry rather than a file.

- A top-level `_locales` that the entry's files contradict — a hand edit or a bad merge naming
  fewer languages than the entry has files in, or a code the site does not declare — is
  reported instead of being read two ways. The files win: a language with a file is offered in
  it, the entry list no longer strikes it through, and the entry says what is wrong above its
  form. `GET /admin/api/entries/:collection/:slug` carries the messages in `offerProblems`, and
  Create from English refuses citing them rather than "this entry is not offered in de".

- Machine translation, behind a `translate(from, to)` hook. **Translate what's empty** in the
  second language's header fills every field that language has nothing in yet, a **Translate**
  button beside a field fills that one, and **Create and pre-fill** does both in one go from
  the offer a language with no file draws — `POST /admin/api/translate/:collection/:slug/:locale`,
  with an optional `{ "paths": [...] }` naming the fields. What a machine wrote is listed in the
  file's `_machine` and badged in the form until somebody types over it, one path at a time.
  DeepL is the implementation: set `DEEPL_API_KEY` and it is used, free keys (`…:fx`) included.
  Another provider goes in `i18n.translate` in `cms.config.ts` — texts in, the same texts
  translated out. With neither, none of the buttons is drawn, and the entry response says so
  in `translator`.

- An entry's **Publish…** is offered when any of its languages has an unpublished draft, not
  only the default one. `GET /admin/api/entries/:collection/:slug` answers `pending` with the
  languages that are ahead of the repository — `["de"]`, `[]` — where it used to answer
  `true`/`false` about the default language's file alone. Create from English therefore leaves
  the entry publishable without the second column being typed in, and a translation drafted
  last time offers Publish the moment the entry opens. The `pending` of the draft writes is
  unchanged: still `true`/`false`, still about the one file that write touched.

- A language an entry has no file in now offers two answers instead of an empty form.
  **Create from English** — `POST /admin/api/drafts/:collection/:slug/:locale` — writes that
  language's file as a draft: the same blocks in the same order, every value the languages
  share, and none of the words. **Not offering the entry in that language** —
  `POST /admin/api/entries/:collection/:slug/locales` — writes no file for it at all and marks
  the languages the entry is offered in with a top-level `_locales` in the files it has;
  turning them all back on takes the key out again. `_locales` is therefore now valid at the
  top of a file as well as on a block, and a language that already has a file cannot be turned
  off. The entry response carries `offered`, the entry list strikes a turned-off language
  through rather than listing it as one still to write, and the switcher strikes it through
  too. Duplicating an entry copies every language of it with one shared map of new `_id`s, so
  the copy is still one entry across its files.

- A second language is edited beside the first. The entry header carries a language switcher —
  buttons up to four languages, a menu above that — with a mark against a language the entry has
  no file in and against one whose source language has moved on since it was translated.
  **Side by side** opens that language in the right-hand column: its own file, its own autosave
  to `PUT /admin/api/drafts/:collection/:slug/:locale`, and both columns stored before the
  publish drawer opens. The column shows what the language owns — a shared field as the value
  it shares, a field the default language keeps to itself not at all, a link's label without its
  target — and blocks are translated there but added, removed and reordered in the default
  language alone. The entry list gains a chip per language saying which ones an entry is written
  in, and lists an entry written in one language only by the words it has. **A site that
  declares one language draws none of this**, and the rule is on the config: two languages and
  no second file still draws every control. The entry response now carries `defaultLocale` and
  the entry's other languages, the collection listing carries the site's `locales`, and a drift
  card shows the words each language has for the block it is deciding about. `docs/i18n.md` is
  now the half a developer configures and the new `docs/translating.md` the half the client
  works in.

- A translation says which English it was made from. Publishing a translated file writes
  `_i18n` into it — `sourceLocale`, the `sourceBlob` of the source language's file as that same
  commit leaves it, a `sourceHash` of the values inside it a translation is made from, and
  `translatedAt`. Opening the entry hashes the source language it now has and reports every
  language whose translation was made from an older one, so the German goes stale when the
  English heading changes and stops being stale when somebody translates it again. A shared
  value, a field the default language keeps to itself, a block moved and a file requoted all
  leave it current, and a translation the publish only carries along — rewritten because English
  added a block — keeps the mark it had rather than claiming to be up to date. Staleness is a
  warning and never a refusal: a stale file publishes and builds like any other. See
  `docs/translating.md`.

- Drift is answered in the entry. An entry whose languages disagree about its blocks opens on a
  reconciliation panel instead of its form, one card per block with the answers that block
  allows — derived from which languages have it against which should, so a block nothing marks
  offers *add it to English*, *keep it in German only* or *remove it from German*, and one
  marked for German that English has as well offers only the two the mark allows. Answering
  every card writes each language the answers change in one batch: a block arrives in a new
  language with the values every language shares and nothing to read yet, so what its schema
  still wants comes back as ordinary validation problems rather than another refusal. A mark
  naming a language the entry has no file in survives. Nothing is marked resolved — the entry is
  read again and the banner goes because there is nothing left to report, which is also how a
  fix made in the repository clears it. `POST /admin/api/drift/:collection/:slug` is the route
  behind it, and the entry response now also carries the site's `locales`. See
  `docs/translating.md`.

- An entry's languages are compared when it opens. The structure is shared, so a block one
  language's file has and another's does not — with no `_locales` to say it belongs to that
  language alone — is two files that have drifted apart, and the entry now comes back with
  every one of them named. Publishing such an entry is refused with `409`, and the drawer marks
  the row *Languages disagree* rather than offering Discard — it is the one refusal besides an
  unfinished schema, because committing the file would bake the difference into git. A save
  still resolves nothing by itself. A site that declares one language reads nothing extra and
  is never refused for this. See `docs/translating.md`.

- An entry's languages keep one structure. Adding a block, removing one or moving one is an
  edit to every language's file of that entry, written in the same autosave: the German file
  is reordered with the English one and keeps its German, a block that arrives brings the
  shared values it has and nothing to read yet. A block with `_locales` is written to the
  languages it names and to no others, and holds its place among its neighbours when the
  others reorder around it. A block only one language has *without* `_locales` is two files
  that have drifted apart, and a save leaves it exactly where it stands rather than copying
  or dropping it. A save that changed neither the structure nor a shared value does not
  touch the other files, and a language the entry has no file in is not created by one.
  Renaming, deleting or discarding an entry now covers every declared language's file, not
  only the default one. A site that declares one language writes what it always did. See
  `docs/i18n.md`.

- A field says how it translates. `.meta({ i18n: 'duplicate' })` on a schema field makes it
  one value shared by every language, `.meta({ i18n: false })` keeps it in the default
  language alone, and everything else is translated as before. An object hands its mode to
  the fields inside it and a field inside can say otherwise. `image`, `file`, `embed`, `link`
  and `seo` split down the middle — an image's `alt` is translated and its `src`, `width`,
  `height` and `focal` are the same everywhere — so nobody retypes an image URL per language.
  A save of a translation writes the fields that language owns and reads the rest off the
  file, instead of dropping what its form never showed (decap-cms#6978). See `docs/i18n.md`.

- `cms.config.ts` declares its languages: `i18n: { locales: ['en', 'de'], defaultLocale:
  'en' }`, with an optional `prefixDefaultLocale`. It is required, a site with one language
  included — content files sit in a folder per language either way, so a second language is
  later a config change and a copy rather than a move of every file. The same block has to
  be in `astro.config.mjs`, since Astro routes from its copy and Handover writes files and
  preview paths from ours; where they disagree the build stops in `astro:config:setup`
  naming both files and the key. Add the block to both files when you upgrade. See
  `docs/i18n.md`.

- Nothing in the package changed. The two i18n mistakes other CMSs shipped — a field
  configured to duplicate disappearing from a translated file on save, and duplicating an
  entry copying only the default locale — now have tests in the repo, written before the
  feature and skipped until the sessions that make them pass.

- Editing an entry keeps a key your schema no longer declares. The editor writes back the
  file it read rather than the fields it drew, so a field renamed in `schemas.ts` before
  its `handover migrate` step keeps its old value in the file instead of being dropped on
  the first save. This was already how it behaved; it is now a documented guarantee with a
  test behind it. See `docs/content-format.md`.

- `docs/content-format.md` said a `_ref` block's content is filled at build time. It is
  not yet: the key is reserved, and `<Blocks />` skips the block until the globals
  collection exists, which is what `docs/template-convention.md` already said.

- The content format is locked at `_version: 1`. The shape of a content file — reserved
  keys, field types, block structure, how the serialiser writes them — does not change
  under you any more: a later release that changes it ships a `handover migrate` step that
  rewrites your files and raises their `_version`, and nothing reinterprets a file it has
  not migrated. See `docs/content-format.md`.

- The admin says when the GitHub App cannot see the repository. GitHub answers `404` for a
  repository outside the App's installation exactly as it does for a missing file, so every
  entry used to open onto "No such entry" with nothing pointing at the installation. The
  admin now names the repository and the installation instead — on opening an entry, on
  creating, renaming or deleting one, and on publishing. See `docs/deploy.md`.

- An unquoted date in a content file fails the build with a message that says to quote it.
  `published: 2026-07-14` is a YAML timestamp: Astro's loader reads it as a `Date`, your
  `z.iso.date()` wants a string, and the build used to stop on
  `Expected type "string", received "object"` without mentioning quoting. The build now
  refuses it first, naming the file and the key, and `handover migrate --dry-run` reports
  the same files and exits `1`. Only hand-written files are affected — the CMS always
  quotes. `docs/template-convention.md` now shows a `content.config.ts`, including what a
  `base` that does not match the collection folder does.

- A collection can say which field is its entry's title. `titleField: 'name'` on a
  collection in `cms.config.ts` makes the entry list, the editor's heading and **New
  entry** all use `name`, so a collection keyed on something other than `title` no longer
  lists file names and no longer drops the name you typed into the dialog; it has to name a
  text field of that collection's schema, and the build fails saying so if it does not. The
  integration now takes that config — `astro.config.mjs` imports `cms.config.ts` and passes
  it to `handover(cms)`, because the build reads the titles and cannot execute your config
  on its own. See `docs/configuration.md`.

- Autosave no longer refuses an entry the schema is not happy with. A draft holds what you
  typed — a new entry whose required `reference` has no picker yet, or a required
  `positive()` number still at nothing, used to answer "Not saved" and lose the rest of the
  form. What is missing is named on the field instead and counted in the entry's header,
  and the **publish** is where the schema blocks: *Publish…* is disabled on an entry with
  problems, and the drawer refuses the whole set while any file in it is not ready. A new
  entry now starts with its title alone rather than a guessed blank per required field.
  A save also keeps content keys your schema no longer declares, so renaming a field before
  writing its migration no longer loses the value on the first edit. See
  `docs/publishing.md`.

- A link can only point somewhere safe. In a `richtext()` field and in a `link` field's
  `href`, the target must be `http`, `https`, `mailto`, `tel` or a path on your own site;
  `javascript:` and `data:` are refused when the entry is saved, naming the scheme and the
  line. `<Markdown />` checks again as it renders, so a file written by hand keeps the
  link's text and loses the link. See `docs/field-types.md`.

- `<Markdown />` runs on Cloudflare. It no longer goes through Astro's Markdown pipeline,
  which is a native binary the Workers runtime cannot run (`The WASI method is not
  implemented`), and renders the richtext constructs from the Markdown the field is
  validated against instead. Headings still get ids; anything outside the tier's construct
  list, raw HTML above all, comes out as text and never as markup.

- The `handover` command. `npx handover migrate --dry-run` lists every content file with
  its `_version`; `npx handover migrate` rewrites the ones behind the package (today that
  only stamps `_version: 1` on files that have none). `npx handover db generate` replaces
  running `drizzle-kit generate` yourself: it generates and records the package's schema
  version in `migrations/handover.json`, and **`astro build` now fails** while that file is
  missing or behind the installed package — run `npx handover db generate` once after
  upgrading and commit `migrations/`. See `docs/cli.md`.

- A content file with no `_version` is read as version 1, and a save through the admin
  writes `_version: 1` into it, so every file the CMS has touched says which format it is
  in. See `docs/content-format.md`.

- A publish that is refused because someone changed a file in the repository is no longer a
  dead end. The drawer marks the file it was refused over, and **Discard** on that row
  throws the unpublished changes away and reads the entry from the repository again, so the
  next publish goes through; the open entry reloads with it rather than saving the old
  values back. Retrying is not offered where it cannot work. New endpoint:
  `DELETE /admin/api/drafts/:collection/:slug`, and `POST /admin/api/publish` answers a
  conflict with `{ error, paths }` instead of a sentence. Keeping your version over theirs,
  or choosing field by field, is still to come. See `docs/publishing.md`.

- The entry list is right the moment a rename or a delete is committed: the renamed entry
  is listed under its new name and a deleted one is gone, instead of waiting for the site
  to rebuild. Both write a row that says what the commit did to that file, laid over the
  build's index and dropped once the build has caught up; neither shows up as an
  unpublished change. A rename still carries the entry's unpublished edits to the new path.
  See `docs/publishing.md`.

- A field's label in the admin is its key, humanised: `availableFrom` reads "Available
  from". `.meta({ label: 'SEO' })` on the field names it yourself, on any type including
  the `image`, `file`, `embed`, `seo` and `reference` helpers. See `docs/field-types.md`.

- The entry list's columns line up with their headers again, and a read-only field says why
  it is read-only: `image`, `file`, `embed`, `seo` and `reference` show one line under the
  stored value naming the release that brings their editor. See `docs/field-types.md`.

- The admin has an entry list. Every collection in `cms.config.ts` is a link in the
  sidebar, and `/admin/c/:collection` lists its entries with the titles the content index
  and the pending drafts give it. **New entry** takes a title, shows the filename derived
  from it — collisions included — and opens the entry; the entry is a **draft until its
  first publish**, so an abandoned one never reaches the repository and its filename can
  still change. **Rename** and **Delete** are per row and are one commit each, with the
  redirect the [content format](docs/content-format.md#renaming-and-deleting-an-entry)
  describes; a rename carries the entry's unpublished edits to the new path and a delete
  discards them. New endpoints: `POST /admin/api/entries/:collection`,
  `POST /admin/api/entries/:collection/:slug/rename` and
  `DELETE /admin/api/entries/:collection/:slug`. `GET /admin/api/entries/:collection/:slug`
  now answers for an entry that exists only as a draft instead of 404. See
  `docs/publishing.md`.

- The admin can list a collection without fetching every file from GitHub. The build reads
  every entry's title and `_status` out of `src/content/` — one row per entry across
  locales — and the new `GET /admin/api/entries/:collection` serves that with the pending
  drafts laid over it, so an entry you have edited but not published lists under the title
  you typed. Titles come from the entry's `title` field; a collection without one lists by
  filename. The index lives inside the Worker and is never served as a file, so your entry
  titles are not public. `astro dev` rebuilds it when a content file changes.
- **The build now fails on a content file that is not
  `src/content/<collection>/<locale>/<name>.yaml`**, naming the file. An entry is one file
  per locale with no folders below the locale folder; a file anywhere else could not be
  opened as `collection/slug` and would have been missing from the entry list without
  saying so. Move such files into the locale folder, or out of `src/content/`.
  See `docs/publishing.md`.
- Publishing commits what is stored, not what the form holds. The top bar counts the files
  waiting ("3 unpublished changes") and opens a pending-changes drawer that lists them and
  publishes the whole set in one commit through `POST /admin/api/publish`; the draft rows
  are cleared once it lands, and a file that changed in the repository since its draft was
  loaded refuses the publish with 409 rather than overwriting it. The entry header's
  button is now **Publish…**: it stores the current edit and opens the drawer. The old
  `PUT /admin/api/entries/:collection/:slug` is gone, and with it an endpoint that let the
  browser hand arbitrary paths and file contents to the repository; publishing takes no
  body at all. `GET /admin/api/entries/:collection/:slug` no longer returns `blob_sha` or
  `head_sha`, and `GET /admin/api/drafts` is new. See `docs/publishing.md`.
- Edits are autosaved. Two seconds after the last keystroke the admin sends the form to
  `PUT /admin/api/drafts/:collection/:slug`, which validates it, merges it into the entry
  and stores the serialised file in D1; reopening the entry shows the draft rather than
  the file in git, so a reload, a crash or a change of machine loses nothing. The reserved
  keys a schema does not declare (`_version`, `_status`, `_machine`) are carried over on
  every save, and the commit and blob sha a draft was loaded from are recorded by the
  server, never sent by the browser. `GET /admin/api/entries/:collection/:slug` gains
  `pending`. See `docs/publishing.md`.
- Unpublished edits get a home: the `drafts` table ships as a Drizzle schema at
  `astro-handover/schema`, so a site points `drizzle.config.ts` at it, runs `drizzle-kit
  generate` once and commits `migrations/`. The site needs a D1 database bound as `DB`,
  and the deploy command becomes `wrangler d1 migrations apply <db> --remote && wrangler
  deploy`. Nothing writes rows yet. See `docs/deploy.md`.
- The admin edits `array` and `blocks`: rows and block cards with Add, Remove and move
  up / down, and a block-type picker built from your registry. Every `_id` survives a
  move and a new row or block gets a fresh one. A block with `_ref`, or one whose `_type`
  has left the registry, is read-only. `image`, `file`, `embed`, `seo` and `reference`
  show their stored value as read-only JSON until their pickers arrive.
  See `docs/field-types.md`.
- The admin edits every scalar field and `group`: text, number, boolean, date, select, link
  and rich text each have a widget, and a rich text body with formatting outside its tier is
  shown read-only instead of being rewritten. See `docs/field-types.md`.
- The form descriptor is complete: `formOf` from `@handover/core` returns `{ fields, blocks }`,
  a nested `z.object()` is a `group` with its own relative `fields`, `$ref`s from recursive
  schemas are resolved, and `blocks` maps each block type to its fields by name. `formSchema`
  from `astro-handover` is the `z.toJSONSchema()` call to feed it (input side; `z.date()` is
  a date; a `z.custom()` tagged `.meta({ handover: 'text' | 'number' | 'boolean' | 'date' })`
  gets that widget). `GET /admin/api/entries/:collection/:slug` now returns `blocks` next to
  `fields`. See `docs/field-types.md`.
- Site files: `cms.config.ts` takes `globals: { site, navigation }`, one schema per file
  under `src/content/globals/<locale>/`; `navigation` from `astro-handover` is the schema
  for the menus file (`menus[].items[]`, nesting through `children`, `newTab` on the item);
  `redirects` validates `src/content/redirects.yaml` (`from` a path, `to` a path or absolute
  URL, `status` 301, `reason` one of `slug-change | hidden | deleted | manual`) and the build
  writes its rules to `_redirects` in the output directory, failing with the rule's path on a
  bad one. Entry templates live in `src/content/_templates/<collection>/` without `_id`s and
  are outside every collection. See `docs/site-files.md`.
- `renameEntry` and `deleteEntry` from `@handover/core` move or remove every locale file of
  an entry in one commit and append the redirect rule to `src/content/redirects.yaml` in the
  same commit (`slug-change` on rename, `deleted` on delete when a target is given; chains
  collapse, a rename back drops the rule). `GitClient.publish` takes `contents: null` to
  remove a path. See `docs/content-format.md`.
- `cms.config.ts` collections take `route` (`'/blog/[slug]'`), `index` (`'/blog'`) and
  `load` (`'post'`); `defineConfig` validates them and throws a message naming the key,
  e.g. `cms.config.ts › collections.posts.route: …`. Entry filenames are derived from the
  title (transliterated, lowercased, dashed, capped at 80, `-2`/`-3` on collision, `untitled`
  when empty) by `entryName` from `@handover/core`. See `docs/configuration.md`.
- `<Blocks />` (`astro-handover/Blocks.astro`) renders a `blocks()` field: pass the list and a
  `{ _type: component }` map; each component gets `block` and `components`, so nested
  `blocks` render by calling `<Blocks />` again. An unmapped `_type` throws naming the type;
  a `_ref` block is skipped until globals exist. See `docs/template-convention.md`.
- Rich text: `richtext()` and `richtext('full')` from `astro-handover` store Markdown and
  validate it against the tier's construct list (basic: paragraphs, bold, italic, links,
  bullet and numbered lists; full adds `##`/`###` headings and blockquotes). Anything else
  — images, raw HTML, code, tables, other heading levels — fails validation naming the
  construct and line. `<Markdown />` (`astro-handover/Markdown.astro`) renders a field
  through Astro's own Sätteri pipeline. `fieldsFrom` reports `richtext` with its `tier`.
  See `docs/field-types.md` and `docs/template-convention.md`.
- Nesting field types: a `group` is a plain `z.object`, an `array` holds groups or scalars
  (never another array), and `blocks(() => registry)` holds blocks declared with
  `defineBlock(type, fields)`, both exported from `astro-handover` together with the `Block`
  and `BlockRegistry` types. A block with `_ref: "globals/<key>"` validates with no fields of
  its own; an unregistered `_type` is rejected. `fieldsFrom` now reports `array` (with its
  item fields) and `blocks` (with its block types) instead of `unsupported`. See
  `docs/field-types.md`.
- Structured field types: `image` (`{ src, alt?, width, height, focal? }`, `src` a
  `media/` key), `file` (`{ src, name, bytes, mime }`, `src` a `files/` key), `embed`
  (`{ provider, id, title?, start? }`, providers `youtube | vimeo | google-maps`, raw HTML
  rejected), `seo` (`{ title?, description?, image?, noindex?, canonical? }`) and
  `reference(collection)` (`"collection/slug"`) are exported from `astro-handover` and
  detected from the schema. See `docs/field-types.md`.
- Scalar field types in the admin form: `number`, `boolean`, `date` (`z.iso.date()`,
  stored as a `"YYYY-MM-DD"` string), `select` (`z.enum`) and `link` (`link` from
  `astro-handover`: `{ type: url | entry | page, href | ref, label?, newTab? }`) are
  detected from the schema alongside `text`. Passing a JS `Date` to `stringifyEntry`
  throws. See `docs/content-format.md`.
- Reserved keys are checked on read: `parseEntry` throws, naming the path, when `_version`
  is not a number, `_status` is anything but `hidden`, `_id` is not eight characters from
  `0-9a-z`, `_locales` is empty or at the top level, or `_machine`/`_i18n`/`_ref` have the
  wrong shape. See `docs/content-format.md`.
- `_status: hidden` in an entry file keeps it out of the site. `filterLive(siteId, entries)`
  and `isLive(siteId, data)` are exported from `astro-handover` for loaders and
  `getStaticPaths`.
- `newId(siteId)` and `regenerateIds(siteId, data, ids?)` in core: fresh block ids, and a
  deep copy of an entry with every `_id` replaced (`_machine` paths follow). Pass one `ids`
  map across an entry's locale files so the copies share a skeleton.
- Content files are written in one canonical shape: strings double-quoted, multi-line text
  as a `|-` block, `_`-prefixed keys first, `null`/empty keys omitted, two-space indent, no
  line folding. Text is normalised on write (`\r\n` → `\n`, trailing whitespace and
  control characters stripped), and an array directly inside an array is rejected with an
  error naming the path. Reading a file and writing it back is byte-identical, so an
  unchanged entry never shows as a pending change.
- Publish works end to end: **Publish this entry** in the editor is enabled once a field
  changes and sends the entry to `PUT /admin/api/entries/:collection/:slug` with
  `{ data, base_sha }`. The route validates `data` against the collection schema (400 if
  it fails), writes `src/content/<collection>/en/<slug>.yaml` as one commit
  (`Update <collection>/<slug>`) on top of `base_sha` and returns `{ commit_sha }`; 409 if
  the branch moved first, and the editor says so. `GET …/entries/:collection/:slug` now
  also returns `head_sha`, the value to publish against.
- `stringifyEntry(siteId, data)` in core: YAML with long lines unfolded, so an edit to one
  field is a one-line diff.
- Docs: `docs/getting-started.md`, `docs/deploy.md` (GitHub App, secrets, Workers Builds),
  `docs/how-it-works.md`.
- `POST /admin/api/publish` with `{ files: [{ path, contents }], base_sha, message }` writes
  the files to the site's repo as one commit on top of `base_sha` and returns `{ commit_sha }`.
  If the branch moved past `base_sha` in the meantime the response is 409 and nothing is
  written; a malformed body is 400. Commits carry no author/committer so GitHub shows them
  as Verified.
- `GitClient` in core gains `getHead()`, `publish(files, { base_sha, message })` (Git Data
  API: tree with `base_tree` → commit → non-force ref update, throws `RefMovedError` on a
  stale base) and `request(path, init)` for other authenticated API calls.
- `/admin/c/<collection>/<slug>` opens the entry editor: a form with one text input per
  `z.string()` field, filled from the entry; other fields show "Not editable here yet".
  Edits are kept in the page only — nothing is saved yet and Publish is disabled.
- The admin UI now ships its stylesheet (design tokens, shell, forms).
- `GET /admin/api/entries/:collection/:slug` returns `{ fields, data, blob_sha }` for
  `src/content/<collection>/en/<slug>.yaml` read from the site's GitHub repo. `fields` lists
  every `z.string()` in the collection's schema as `{ path, type: 'text', required }`; any
  other field is `{ path, type: 'unsupported' }`. Needs `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`,
  `GITHUB_PRIVATE_KEY` (PKCS#8 PEM) and `GITHUB_REPO` (`owner/repo`), optional `GITHUB_BRANCH`,
  set with `wrangler secret put` (or `.dev.vars`).
- `fieldsFrom(siteId, jsonSchema)` and `parseEntry(siteId, yaml)` in core.
- Temporary password gate (replaced before the first release by the accounts above):
  `/admin/api/*` was behind a single shared password in one environment variable.
- `createGitClient(siteId, app, { fetch?, now? })` in core: mints a GitHub App installation
  token on demand (RS256 JWT via WebCrypto, cached on the client until it expires) and
  `getFile(path)` returns `{ contents, blob_sha }` or `undefined` for a missing path. Not yet
  exported from `astro-handover`.
- `/admin` serves the pre-built Svelte admin shell (sidebar, top bar, no screens yet); its
  hashed JS/CSS are served from `/admin/_assets/*` by the same Worker and inlined at build
  time via `virtual:handover/ui`, so the site's own build config is untouched.
- `/admin/[...path]` and `/admin/api/[...path]` are injected as SSR routes; `GET /admin/api/ping`
  returns `{ ok, collections }`. The integration requires a root `cms.config.ts` exporting
  `defineConfig({ collections: { name: { schema } } })` (from `astro-handover`), exposed to the
  Worker as `virtual:handover/config`.
- `ContentSource`, `ContentEntry` and `staticSource(siteId, { getEntry, getCollection })`
  exported from `astro-handover`; see `docs/template-convention.md`.
- `astro-handover` integration skeleton: logs on `astro:config:setup` and throws
  `astro-handover needs an SSR adapter: …` when `adapter` is missing. Built to `dist/`
  with `pnpm build`; `pnpm dev` watches.
- Monorepo skeleton: `packages/{core,astro,ui,cli}`, Vitest, Biome, CI. No product code yet.
