# The `handover` CLI

Installed with the package; run it from the site's root with `npx handover …`.

- [`handover init`](init.md) — once, to set a new site up. Its own page.
- [`handover migrate`](#handover-migrate) — after a release changes what content files look like.
- [`handover db generate`](#handover-db-generate) — after a release changes the package's tables.

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
astro-handover's tables are at schema version 3 but migrations/ was generated for 2: run `npx handover db generate` and commit migrations/
```

`npx handover db generate --check` runs the same check on its own, for a CI step.
