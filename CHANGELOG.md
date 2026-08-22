# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
