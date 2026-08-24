# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
