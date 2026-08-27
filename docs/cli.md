# The `handover` CLI

Installed with the package; run it from the site's root with `npx handover …`.

## `handover init`

Once, on a site that has never had Handover. It scaffolds the site's own files, creates the
Cloudflare resources, writes the files that point at them, generates and applies the
migrations, puts the first owner in the database, and prints what is left to do:

```sh
npx handover init you@example.com
```

It needs `wrangler`, `drizzle-kit` and `drizzle-orm` installed here first — both bins are
checked before anything is created, so a missing one costs you nothing:

```sh
pnpm add -D wrangler drizzle-kit drizzle-orm
```

The address is the first owner's. Everything is named after the project — `name` in
`package.json`, or the folder — so `my-site` gets a D1 database called `my-site` and an R2
bucket called `my-site-media`.

```
Wrote src/content/schemas.ts
Wrote src/content.config.ts
Wrote src/blocks/registry.ts
…
Wrote cms.config.ts
Wrote wrangler.jsonc
Wrote src/worker.ts
Wrote drizzle.config.ts
migrations/handover.json records schema version 1
you@example.com is an owner. They sign in with an emailed link and set a password on their account page…
```

In order, it:

1. writes the site's own files ([below](#what-it-writes)) — all of them local, and all of
   them before anything exists in Cloudflare, so a run that stops here leaves nothing behind
2. reads the account from `wrangler whoami`. With more than one, it stops and lists them —
   set `CLOUDFLARE_ACCOUNT_ID` to the one you want and run it again, rather than have the
   database created in the wrong account
3. creates the database and the bucket
4. writes `wrangler.jsonc` with the `DB` binding and the bucket's two vars, `src/worker.ts`
   ([the schedule](deploy.md#the-schedule)) and `drizzle.config.ts`
5. runs [`db generate`](#handover-db-generate) and applies the result with
   `wrangler d1 migrations apply`, once `--local` and once `--remote`
6. inserts one `user` row — an owner, no password
7. prints the [checklist](#what-is-left-to-you)

A file it would write that is already there is left alone and named on stdout. That
includes `wrangler.jsonc`: a config file you wrote is yours, so the block to paste into it
is printed instead. It refuses outright on a project that already has a `migrations/`
folder, before creating anything, rather than guess how to merge the numbering.

Commit everything it wrote, `migrations/` included.

### What it writes

`cms.config.ts` is the one file it always writes, and the languages in it come from
`astro.config.mjs` rather than from a default — the build stops when the two disagree
([Add the integration](getting-started.md#1-add-the-integration)). What goes around it
depends on whether the project has content already.

**A project with no `src/content.config.ts`** gets a starter that builds and renders as it
stands, and is meant to be edited rather than kept:

```
cms.config.ts                             pages, and one global
src/content.config.ts                     the same collections, for Astro
src/content/schemas.ts                    the page schema, two block types, the site global
src/blocks/registry.ts                    _type → component
src/blocks/Hero.astro, TextSection.astro
src/layouts/Page.astro                    props in, no fetching
src/loaders/page.ts                       one load() the route and preview both call
src/pages/[slug].astro                    the route; a second language gets de/[slug].astro
src/content/pages/en/home.yaml            something to open in the admin
src/content/globals/en/site.yaml          one per language, because a declared global owes a file
```

The layout, the loader and the routes are the [template convention](template-convention.md),
which is what lets [preview](preview.md) render an unpublished draft through your own pages.
The last two lines are content. The entry is the first thing to open at `/admin`, and it is
written in the default language only — the other languages' routes answer `404` until you
make the translation there, which is what they are for. The global is written in every
language: without one the build stops, and without one per language a page in the second
language throws as it renders ([Site files](site-files.md#globals)).

**A project that already has `src/content.config.ts`** keeps every file it wrote. That file
is read, not touched: its collections and the schema each one names become `cms.config.ts`,
and nothing else is scaffolded.

```
src/content.config.ts is yours; its collections are read out of it and it is left alone
Wrote cms.config.ts
Nothing in it has a route, an index or a load yet…
```

Two things it cannot do for you there: a collection's `route`, `index`, `load` and
`titleField` are yours to add ([Configuration](configuration.md)), and a collection whose
schema is written inline rather than imported cannot be named in `cms.config.ts` at all, so
it is left out and named on stdout — move it into `src/content/schemas.ts`
([Template convention](template-convention.md#schemasts)).

### What is left to you

The last thing it prints is the checklist, because none of it is Cloudflare's: the
[GitHub App](deploy.md#the-github-app) with the link to create one, the five required
[secrets](deploy.md#secrets) and the `HANDOVER_BASE_URL` var, the optional secrets and what
each turns on, and the bucket's [CORS rule and hostname](media.md). The origin the last two
want is the deployed site's, which `init` cannot know. The site cannot serve `/admin` until
the required secrets are set, and once it can, **Settings** says which of the rest are
missing ([Settings](diagnostics.md)).

**The first owner has no password.** The row is all there is, so the way in is an emailed
sign-in link, and they set a password from their account page afterwards — which needs a
[mailer](email.md) and `HANDOVER_BASE_URL`. On a site with neither, give them a password by
hand: [Accounts](auth.md#3-create-the-first-account).

## `handover migrate`

Every content file under `src/content/` carries `_version` ([content format](content-format.md#reserved-keys)).
When a package release changes what the files look like, it ships a migration step, and
`migrate` brings every file up to the version the installed package writes.

See what would happen first:

```sh
npx handover migrate --dry-run
```

```
src/content/listings/en/mill-house.yaml  none → 1
src/content/pages/en/home.yaml           1
src/content/redirects.yaml               1
3 files: 2 at version 1, 1 without a version. Dry run: 1 would be written.
```

Every `.yaml` under `src/content/` is listed — entries, globals, templates and
`redirects.yaml` — with the version it has and the one it would get. A file with no
`_version` is read as `1` and stamped.

An unquoted date in a hand-written file is reported under the summary and exits `1`,
because Astro's loader reads it as a `Date` and your schema wants a string
([quoting](template-convention.md#quote-dates-in-a-file-you-write-by-hand)):

```
src/content/notes/en/one.yaml › published: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"
```

Then:

```sh
npx handover migrate
git add src/content && git commit -m "Migrate content to format 2"
```

Files are rewritten in place and nothing is committed for you; the commit before the
migration is the way back. Running it again is a no-op: a step only runs on files at the
version it starts from. A file newer than the package knows fails the run, naming the
file — upgrade the package.

## `handover db generate`

The package's own tables live in D1 and change with the package: `drafts`, `media`, `locks`,
`activity`, `settings`, `cron_state`, and the login's own `user`, `session`, `account`,
`verification` and `rate_limit`. After upgrading `astro-handover`:

```sh
npx handover db generate
```

runs `drizzle-kit generate` against `astro-handover/schema` — a new `migrations/*.sql`
when a table changed, "nothing to migrate" when not — and records the package's schema
version in `migrations/handover.json`. Commit both. The deploy command applies the SQL
([deploy](deploy.md#the-database)).

`astro build` refuses to run while `migrations/handover.json` is missing or behind the
installed package, so an upgrade that forgot this step fails in the build log rather than
on the first request:

```
astro-handover's tables are at schema version 2 but migrations/ was generated for 1: run `npx handover db generate` and commit migrations/
```

`npx handover db generate --check` runs the same check on its own, for a CI step.
