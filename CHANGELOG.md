# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Temporary password gate (removed in a later release): every `/admin/api/*` request except
  `POST /admin/api/login` needs `Authorization: Bearer <ADMIN_PASSWORD>` or the session cookie
  that `login` sets; otherwise it is 401. `/admin` shows a login form when no session exists.
  Set the secret with `wrangler secret put ADMIN_PASSWORD` (and `ADMIN_PASSWORD=…` in
  `.dev.vars` for `astro dev`); requests fail with an explicit error if it is unset.
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
