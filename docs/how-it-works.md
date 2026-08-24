# How it works

One page for contributors. The public surface is `astro-handover`; everything below it is
free to change.

## Packages

- `packages/core` — logic with no Astro or Cloudflare imports (a test enforces it):
  `ContentSource`, the Zod → field walker, YAML parse/stringify, the GitHub client.
  Every function takes a `siteId` first, unused until multi-site.
- `packages/astro` — the integration. Re-exports what sites need from core.
- `packages/ui` — the admin SPA (Svelte 5 + Vite), built into `packages/astro/dist/ui/`.
- `packages/cli` — the `handover` bin (`migrate`, `db generate`), declared on `astro-handover` so
  `npx handover` resolves in a site.

## Routes

`astro:config:setup` injects two SSR routes and one `pre` middleware:

- `/admin/[...path]` serves the SPA shell and its hashed JS/CSS (`/admin/_assets/*`). The
  built assets are inlined into the Worker bundle through a virtual module, so the site's
  own Vite config never knows about them.
- `/admin/api/[...path]` is the JSON API the SPA talks to. Routes are matched by hand on
  `params.path`.
- The middleware is the temporary password gate on `/admin/api/*`.

The integration refuses to load without an SSR adapter, because the routes are SSR.

## Config

`cms.config.ts` at the site root is resolved as `virtual:handover/config`, so the Worker
holds the site's real Zod schemas. `formSchema()` runs `z.toJSONSchema()` on a collection
schema (input side, so a transform shows what the editor types; `z.date()` named a date)
and `formOf()` from `@handover/core` turns that into the descriptor tree the form is built
from: `{ fields, blocks }`, where `fields` is one descriptor per field (`group` and `array`
carry their own relative `fields` / `item`) and `blocks` maps every block type in the
registry to its fields by name, so a block that nests `blocks` is not an infinite tree.
Anything the walker does not know is `unsupported` and shown read-only.

## Content

Content never leaves git. Reading `GET /admin/api/entries/:collection/:slug` fetches
`src/content/<collection>/en/<slug>.yaml` through the GitHub contents API and returns the
parsed data — or, when the entry has a draft row, that row's contents instead. It reads every
language the site declares in the one pass, so `pending` comes back as the languages of the
entry that have a draft ahead of the repository, not as a yes or no about one file. No sha goes
to the browser: publishing works from the stored rows, so the bases stay server-side.

`PUT /admin/api/drafts/:collection/:slug` is the autosave. `saveDraft` in core merges the
validated field values over the reserved keys of the entry as it stands, serialises the
result and upserts one row keyed by `(site_id, path)`. `base_sha` and `base_blob` come
from GitHub on the first write of a row and are then left alone, so the base is the
server's fact and not something a stale tab can assert. `blobSha()` computes a git object
id from bytes (`sha1("blob <length>\0" + bytes)`), which is what makes "does this draft
still match the file?" a string comparison rather than a fetch.

`GET /admin/api/entries/:collection` is the entry list and does not touch GitHub at all. It
reads `virtual:handover/index`, a module the integration's Vite plugin builds by walking
every `.yaml` under `src/content/` and handing the files to `indexFrom` in core, which
decides what is an entry — so `_templates/` and `globals/` drop out in one place — and lays
the pending draft rows over it with `collectionEntries`. A file that is neither an entry
nor a site file fails the build through `contentPathErrors`, because a path the CMS cannot
address would otherwise be missing from a list that claims to hold every entry.

The index is a virtual module and **not** a static asset: written into the output it would
be a public list of every entry's title, hidden ones included, and no site config should be
what keeps that private. The cost is bundle bytes: the index is a JSON string in the `api`
chunk, roughly 120 per entry per locale (371 for the demo's three). Dev has no build, so
the plugin watches `src/content/` and invalidates the module on a change; one code path
for both.

Publishing (`POST /admin/api/publish`) takes no body at all: `publishDrafts` in core reads
every draft row whose bytes differ from the file it was loaded from, checks each one's
`base_blob` against the file at HEAD, and commits them through the Git Data API — a tree
with `base_tree` set (so nothing else in the repo is touched), a commit whose parent is
HEAD, and a non-force ref update. One file changed in the repository since it was opened
refuses the whole set with 409, as does a branch that moves under the ref update; either
way nothing is written. The rows are deleted once the commit lands, so the next open reads
the file that was just written. Commits carry no author, so GitHub signs them for the App
and shows them as Verified.

The GitHub client mints an installation token per request from the App's private key
(RS256 via WebCrypto) and caches it on the client object only.
