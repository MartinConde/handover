# How it works

One page for contributors. The public surface is `astro-handover`; everything below it is
free to change.

## Packages

- `packages/core` — logic with no Astro or Cloudflare imports (a test enforces it):
  `ContentSource`, the Zod → field walker, YAML parse/stringify, the GitHub client.
  Every function takes a `siteId` first, unused until multi-site.
- `packages/astro` — the integration. Re-exports what sites need from core.
- `packages/ui` — the admin SPA (Svelte 5 + Vite), built into `packages/astro/dist/ui/`.
- `packages/cli` — empty so far.

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
holds the site's real Zod schemas. `fieldsFrom()` turns `z.toJSONSchema()` of a
collection schema into a flat field list: `z.string()` leaves become `text` fields,
anything else is `unsupported` and shown read-only.

## Content

Content never leaves git. Reading `GET /admin/api/entries/:collection/:slug` fetches
`src/content/<collection>/en/<slug>.yaml` through the GitHub contents API and returns the
parsed data with the file's blob sha and the branch's head sha.

Publishing (`PUT` on the same path) validates the data against the collection schema,
serialises it back to YAML and makes one commit through the Git Data API: a tree with
`base_tree` set (so nothing else in the repo is touched), a commit whose parent is the
head sha the editor loaded against, and a non-force ref update. If `main` moved in
between, GitHub refuses the update, the API answers 409 and nothing is written. Commits
carry no author, so GitHub signs them for the App and shows them as Verified.

The GitHub client mints an installation token per request from the App's private key
(RS256 via WebCrypto) and caches it on the client object only.
