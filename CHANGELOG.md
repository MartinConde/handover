# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Helpers that never used the site id no longer take it: drop the leading `'default'` from
  `staticSource`, `entryAt`, `filterLive`, `isLive`, `entryAddress`, `entryUrl`, `globalsAt`,
  `menusAt` and `getEntryLocales`, and from `renameEntry`/`deleteEntry` in `@handover/core`.
- `@handover/core` types use camelCase: `GitFile.blobSha`, `GitClient.publish(files, { baseSha })`
  answering `{ commitSha }`, `BuildStatus`, and the results of `publishDrafts`, `revertCommit`,
  `restoreCommit`, `renameEntry` and `deleteEntry`. The admin API's JSON keys are unchanged.
- An unexpected admin API error is logged (`admin api: <method> <path> failed`) before the 500.
- The admin sidebar shows one icon for every collection, and global cards share one colour,
  instead of special cases for the demo's collection names and card positions.
- A refused machine translation shows the server's plain-text reason as technical detail
  whatever its status, as other editor actions do, not only for `409` and `503`.
- Error notices show the technical detail on its own line in every screen, and who holds an
  entry as part of the sentence.
- On a phone, a redirect's test result wraps its buttons instead of running past its card.
- A redirect the server refuses without a code says it was not saved, with the server's text
  as technical detail, instead of showing that text alone.

## 0.1.0 — first release

A git-backed CMS for Astro sites on Cloudflare Workers. Editors change content in an admin UI,
Handover commits the result to the site's repository, and the normal build publishes it.

### Content model and storage

- One `astro-handover` integration, configured in `cms.config.ts` with `defineConfig()`:
  `collections`, `globals`, `i18n`, `media`, `mailer`, `sitemap`, `checks` and `admin`.
- Content lives in the repository as YAML, one file per entry and language at
  `src/content/<collection>/<locale>/<slug>.yaml`. Unpublished edits live in the site's D1 database.
- The admin form is generated from your Zod schema. Field types: text, `richtext()`, number,
  boolean, date, select, `link`, `image`, `file`, `embed` (YouTube, Vimeo, Google Maps), `seo` and
  `reference()`.
- Nest fields with groups, arrays and `blocks()`. Render blocks with `<Blocks />` and a component
  registry; blocks can nest and can be filled from a global with `_ref`.
- Collections take a `route`, an `index` page, a `load` loader, a `titleField` and names per
  interface language (`label`, `singular`, `newLabel`).
- Globals hold site-wide files under **Site settings**; `_templates/` holds starters for new entries.
- Each content file carries `_version`. `handover migrate` rewrites files when the format changes.
- Entries can be hidden with `_status: "hidden"`; `filterLive()` keeps them off the site.
- Shared menus come from the `navigation` global, edited in a menu builder and drawn with `<Nav />`.
- `redirects.yaml` holds redirect rules, written at build as `_redirects`. Renaming or deleting an
  entry adds one.
- The `seo` field and a `seoDefaults` global feed `<Seo />`. The build writes `sitemap-<locale>.xml`,
  `sitemap-index.xml` and `robots.txt`; set `sitemap: false` to turn that off.
- Rendering helpers: `<Markdown />`, `<Embed />`, `<Seo />`, `<Nav />`, `<LocaleSwitcher />`,
  `load()`, `ContentSource`, `globalsAt()` and `menusAt()`.
- Custom admin pages with `admin.screens`, served at `/admin/x/<key>`.

### Admin editor and Canvas

- Autosaving drafts in D1 that survive a refresh and a closed tab.
- Entry lists with search, filters, a home-page marker, and starters for new entries.
- Create, duplicate, rename, hide and delete entries, and restore a deleted one.
- Dashboard at `/admin` showing unpublished changes, build status, recent edits and translation
  progress.
- Live preview beside the form, rendered on the Worker from the draft through your own `load()` and
  components. Turn it on with `PREVIEW_ENABLED=1` at build time. Preview requires a signed-in session.
- Canvas editing: the real page inside the editor, with click-to-edit fields, a Structure panel, an
  Inspector and undo. Annotate templates with `createEditContext()`.
- Version history per entry: compare two versions field by field and restore one as unpublished
  changes.
- Settings screen for owners showing which connected services answer, with a test email.
- Activity log at `/admin/activity` recording sign-ins, invites, role changes, publishes and conflicts.
- Admin interface in English and German, chosen per account and independent of the content language.

### Translations

- `i18n` with `locales` and `defaultLocale`, checked against `astro.config.mjs` at build.
- Edit a translation beside its source, with a third language beside each field.
- Every entry has a source language. Files that disagree about it open on a panel that lets you
  choose.
- Translate a field, or everything still empty, with DeepL (`DEEPL_API_KEY`) or your own
  `i18n.translate` function. Machine-written text is marked until someone edits it.
- Fields whose source has changed since the translation was written are marked as behind.
- Entry-list language chips and filters show what each entry still needs.
- Create a missing language file empty or pre-filled, and offer an entry in only some languages.
- Optional `localizedSlugs` per collection gives each language its own web address, resolved with
  `entryAt()` and `entryAddress()`.
- Language switcher through `getEntryLocales()` and `<LocaleSwitcher />`.

### Media

- Pictures and files go to a private R2 staging bucket, then a public bucket served from
  `media.publicBase`. Content files store `media/…` keys, never URLs.
- Pictures are resized, converted to WebP and stripped of EXIF in the browser. Identical bytes are
  stored once.
- The media library at `/admin/media` lists, archives and deletes files, and refuses to delete
  one that is still in use.
- Focal point per picture, and cropping a copy.
- Presets on `image()` set the aspect ratio, the size cap and the minimum size, with a drop zone and
  a picker in the form.
- An hourly job recovers uploads that were interrupted.

### Publishing and conflicts

- Publishing writes one Git commit through a GitHub App; the host builds and deploys from that push.
- A pending-changes drawer lists unpublished entries and publishes the ones you tick. An entry
  publishes in all its languages at once.
- Turning **Ready to publish** off holds an entry back from the drawer.
- Pre-publish checks cover missing media, broken links, missing alt text, empty or stale
  translations and incomplete SEO. Switch checks off by id with `checks.ignore`.
- Build status in the sidebar (`CLOUDFLARE_API_TOKEN`), and **Revert last publish** when a build fails.
- Soft locks show who is editing an entry, and let a colleague take over.
- A publish is refused when a file changed in the repository after it was opened. Resolve it field
  by field, or discard your draft.
- Discard an entry's unpublished changes from its row in the drawer or from its publish menu.

### Accounts and roles

- Accounts live in the site's D1 database; there is no public sign-up.
- Sign in with an emailed link, a password, or GitHub (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`).
- Two roles: `owner` and `editor`. Owners manage members and settings.
- The Members screen invites people, resends and revokes invites, changes roles and removes
  members. The last owner cannot be demoted or removed.
- Account page for a first password, a changed password and the interface language.
- Sign-in attempts are rate limited.
- `mailer` supports `resend`, `smtp`, `cloudflare` or a function of your own.
- Secrets: `BETTER_AUTH_SECRET`, `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` and
  `GITHUB_REPO`, plus one per optional feature.

### CLI

- `handover init <email>` sets a new site up. It creates the D1 database and R2 buckets, writes
  `cms.config.ts`, `wrangler.jsonc` and the scaffold files, applies migrations and creates the
  first owner. `--jurisdiction eu` keeps the resources in Cloudflare's EU jurisdiction.
- `handover migrate` brings content files up to the current format; `--dry-run` shows what would
  change.
- `handover db generate` writes the migrations for the package's tables; `--check` verifies them
  in CI. `astro build` refuses to run when they are behind.
