# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Edits are autosaved. Two seconds after the last keystroke the admin sends the form to
  `PUT /admin/api/drafts/:collection/:slug`, which validates it, merges it into the entry
  and stores the serialised file in D1; reopening the entry shows the draft rather than
  the file in git, so a reload, a crash or a change of machine loses nothing. The reserved
  keys a schema does not declare (`_version`, `_status`, `_machine`) are carried over on
  every save, and the commit and blob sha a draft was loaded from are recorded by the
  server, never sent by the browser. `GET /admin/api/entries/:collection/:slug` gains
  `pending`. Publishing still commits what the form holds rather than the stored draft, but
  it now keeps those reserved keys too — before, publishing an entry with a `_version` or a
  `_status` silently dropped it. See `docs/publishing.md`.
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
