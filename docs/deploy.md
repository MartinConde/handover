# Deploy

The site is one Cloudflare Worker: static pages as assets, `/admin` and `/admin/api` as
SSR routes, and `/_preview` where [preview](preview.md) is turned on. Handover needs one
binding — a D1 database for unpublished edits — five required [secrets](secrets.md), and one more
per optional feature.

## wrangler.jsonc

[`handover init`](init.md) writes this file and `src/worker.ts` below. Where a
config file already exists it is left alone, and the `d1_databases` binding and the bucket's
`vars` are printed to paste in.

```jsonc
{
  "name": "your-site",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "main": "./src/worker.ts",
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "binding": "ASSETS", "directory": "./dist" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "your-site",
      "database_id": "the id wrangler prints when you create it"
    }
  ]
}
```

`main` is the site's own Worker rather than the adapter's, because Handover has background jobs
as well as routes:

```ts
// src/worker.ts
import handler from '@astrojs/cloudflare/entrypoints/server';
import { scheduled } from 'astro-handover/cron';

export default { ...handler, scheduled };
```

## The schedule

One Cron Trigger runs every five minutes and one handler decides what is due: media
reconciliation hourly, activity-log retention daily, daily a sweep of the draft rows a
rename or a delete left behind when the request died between its commit and its database
write, and daily the hidden-page check behind the drawer's `hidden-long` note
([Pending changes](pending-changes.md#checks-before-a-publish)). A package upgrade that adds
a job adds no trigger, so `wrangler.jsonc` is written once.

To fire a tick by hand, build first and ask for one. `--bundle` is not optional — the Astro
build ships its own, and `--test-scheduled` only reaches a Worker wrangler bundled itself:

```sh
pnpm build
npx wrangler dev -c dist/server/wrangler.json --persist-to .wrangler/state --test-scheduled --bundle
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'
```

`--persist-to` keeps the local D1 beside the project rather than under `dist/`, where the next
build would delete it.

What ran is one line on stdout; what a job did is a `cron-<job>` row in the
[activity log](activity.md).

## The database

Edits are held in D1 until they are published, so the admin survives a refresh, a crash
and a change of device. [`handover init`](init.md) does the whole of this
section on a new site — the steps below are what it runs, and what to do by hand on a site
it could not finish. Create the database and take the id from the output:

```sh
npx wrangler d1 create your-site
```

The tables come from the package. `drizzle-kit` reads them from `astro-handover/schema`
and writes plain SQL into `migrations/`, which `wrangler` applies:

```sh
pnpm add -D drizzle-kit drizzle-orm
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './node_modules/astro-handover/dist/schema.js',
  out: './migrations',
});
```

```sh
npx handover db generate                                # writes migrations/0000_*.sql and handover.json
npx wrangler d1 migrations apply your-site --local      # your machine
npx wrangler d1 migrations apply your-site --remote     # the deployed site
```

Commit `migrations/` — the whole folder, `meta/` and `handover.json` included. Migration
files are written by the generator, never by hand, and an applied one is never edited.
After a package upgrade adds a table or a column, run `handover db generate` again; the
new SQL file is part of the upgrade's diff, and the build fails until it exists
([CLI](cli.md#handover-db-generate)). Applying is idempotent, which is why it belongs in
the deploy command below.

## The GitHub App

Handover commits as a GitHub App, so every commit shows as **Verified** and the site's
repository is the only thing the App can touch.

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. Any name,
   any homepage URL, webhook off. Repository permissions: **Contents: Read and write**.
   Nothing else.
2. After creating it, note the **App ID** and generate a **private key** (a `.pem`
   download).
3. **Install App** on the site's repository only. The number at the end of the
   installation URL (`…/installations/12345678`) is the installation id.
4. GitHub's key is PKCS#1; Workers' WebCrypto needs PKCS#8:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out key.pem
   ```

## Secrets

Five required, one var, and one more per optional feature — every one of them, with where
its value comes from, is on [Secrets](secrets.md). `/admin/api` requests fail naming the
missing one, and once the site is up **Settings** says which of the rest are missing
([Settings](diagnostics.md)).

## Building on push

Connect the repository to the Worker under **Workers & Pages → your Worker → Settings →
Builds** so every commit — including the ones Handover makes — rebuilds and deploys:

- Build command: `pnpm build` — with `PREVIEW_ENABLED=1` in front of it, or in the script, to
  ship the preview route ([Preview](preview.md))
- Deploy command: `npx wrangler d1 migrations apply your-site --remote && npx wrangler deploy`

Migrations run before the new code is live, so a deploy can never reach a database that is
missing a column, and applying an already-applied file does nothing.

Commits an editor publishes are ordinary pushes to `main`; one publish is one build. A
first deploy from your machine is `pnpm astro build && wrangler deploy`.
