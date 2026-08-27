# The `handover` CLI

Installed with the package; run it from the site's root with `npx handover …`.

## `handover init`

Once, on a site that has never had Handover. It creates the Cloudflare resources, writes
the two files that point at them, generates and applies the migrations, and puts the first
owner in the database:

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
Wrote wrangler.jsonc
Wrote src/worker.ts
Wrote drizzle.config.ts
migrations/handover.json records schema version 1
you@example.com is an owner. They sign in with an emailed link and set a password on their account page…
```

In order, it:

1. reads the account from `wrangler whoami`. With more than one, it stops and lists them —
   set `CLOUDFLARE_ACCOUNT_ID` to the one you want and run it again, rather than have the
   database created in the wrong account
2. creates the database and the bucket
3. writes `wrangler.jsonc` with the `DB` binding and the bucket's two vars, `src/worker.ts`
   ([the schedule](deploy.md#the-schedule)) and `drizzle.config.ts`
4. runs [`db generate`](#handover-db-generate) and applies the result with
   `wrangler d1 migrations apply`, once `--local` and once `--remote`
5. inserts one `user` row — an owner, no password

A file it would write that is already there is left alone and named on stdout. That
includes `wrangler.jsonc`: a config file you wrote is yours, so the block to paste into it
is printed instead. It refuses outright on a project that already has a `migrations/`
folder, before creating anything, rather than guess how to merge the numbering.

Commit `wrangler.jsonc`, `src/worker.ts`, `drizzle.config.ts` and `migrations/`.

**The first owner has no password.** The row is all there is, so the way in is an emailed
sign-in link, and they set a password from their account page afterwards — which needs a
[mailer](email.md) and `HANDOVER_BASE_URL`. On a site with neither, give them a password by
hand: [Accounts](auth.md#3-create-the-first-account).

What init does not do is the rest of [Deploy](deploy.md): the GitHub App, the secrets, and
the bucket's [CORS rule and hostname](media.md) are yours, and the site cannot serve
`/admin` until they are set.

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
