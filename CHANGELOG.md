# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
