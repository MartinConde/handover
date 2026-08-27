# Deploy

The site is one Cloudflare Worker: static pages as assets, `/admin` and `/admin/api` as
SSR routes, and `/_preview` where [preview](preview.md) is turned on. Handover needs one
binding — a D1 database for unpublished edits — five required secrets, and one more per
optional feature.

## wrangler.jsonc

[`handover init`](cli.md#handover-init) writes this file and `src/worker.ts` below. Where a
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
reconciliation hourly, activity-log retention daily, and daily a sweep of the draft rows a
rename or a delete left behind when the request died between its commit and its database write. A package upgrade that adds a job
adds no trigger, so `wrangler.jsonc` is written once.

To fire a tick by hand, build first and ask for one. `--bundle` is not optional — the Astro
build ships its own, and `--test-scheduled` only reaches a Worker wrangler bundled itself:

```sh
pnpm build
npx wrangler dev -c dist/server/wrangler.json --test-scheduled --bundle
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'
```

What ran is one line on stdout; what a job did is a `cron-<job>` row in the
[activity log](activity.md).

## The database

Edits are held in D1 until they are published, so the admin survives a refresh, a crash
and a change of device. [`handover init`](cli.md#handover-init) does the whole of this
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

Set each with `wrangler secret put <NAME>` (paste the value when prompted). For the key,
paste the whole PKCS#8 PEM including its header lines — newlines are fine, and so is
the `\n`-escaped one-line form.

| Secret | Value |
|---|---|
| `BETTER_AUTH_SECRET` | signs the admin's sessions — `openssl rand -base64 32`. Changing it signs everyone out ([Accounts](auth.md)) |
| `GITHUB_APP_ID` | App ID from step 2 |
| `GITHUB_INSTALLATION_ID` | installation id from step 3 |
| `GITHUB_PRIVATE_KEY` | the PKCS#8 PEM |
| `GITHUB_REPO` | `owner/repo` of the site |

Optional, each turning on the feature that reads it:

| Secret | Value |
|---|---|
| `GITHUB_BRANCH` | the live branch, if it is not `main` |
| `CLOUDFLARE_API_TOKEN` | build status and revert in the admin. A **read-only** token: dashboard → My Profile → API Tokens → Create Token → Custom token, permission **Account → Workers Scripts → Read**, scoped to the one account. It needs `CLOUDFLARE_WORKER` beside it (below); without both, no build pill is drawn |
| `DEEPL_API_KEY` | [machine translation](translating.md#a-machines-first-draft) from the admin — a free key ends in `:fx` and is recognised as one. Without it the translate buttons are not drawn. The owner can paste a key of their own in **Settings**, which overrides this one ([Integrations](diagnostics.md#integrations)) |
| `HANDOVER_SETTINGS_KEY` | what a key the owner pastes in **Settings** is encrypted with: 32 random bytes, `openssl rand -base64 32`. Only needed if they ever do; without it that section says so and stores nothing. Changing it later makes the keys stored under it unreadable, and they are pasted again |
| `RESEND_API_KEY` | sending mail, when `cms.config.ts` says `mailer: { provider: 'resend', … }` ([Sending email](email.md)). Verify the sending domain at `resend.com/domains` and put an address on it in `from` — until you do, Resend only delivers to the address its own account was created with |
| `SMTP_USER` | the login for `mailer: { provider: 'smtp', … }` — Resend's own relay, for one, wants the literal `resend` |
| `SMTP_PASS` | the password for that login. Without both, the admin treats the site as having no mailer ([Sending email](email.md#smtp)) |
| `GITHUB_CLIENT_ID` | *Continue with GitHub* on the login. An OAuth app whose callback URL is `<HANDOVER_BASE_URL>/admin/api/auth/callback/github`; one app per origin, so local dev needs its own ([Accounts](auth.md#continue-with-github)) |
| `GITHUB_CLIENT_SECRET` | the same app's client secret. Without both, GitHub is not offered |
| `R2_ACCESS_KEY_ID` | uploading pictures. An **R2 API token** with *Object Read & Write* on the one bucket: dashboard → R2 → API → Manage API tokens ([Media](media.md)) |
| `R2_SECRET_ACCESS_KEY` | the same token's secret. Without both, the admin refuses uploads and names what is missing |

`mailer: { provider: 'cloudflare', … }` has no secret at all: it sends through a `send_email`
binding in `wrangler.jsonc`, so it is set up in the dashboard rather than here
([Sending email](email.md#cloudflare)).

One more is a **var rather than a secret**, because an origin is not private — and without it the
emailed sign-in link and GitHub are not offered at all:

```jsonc
// wrangler.jsonc
"vars": { "HANDOVER_BASE_URL": "https://your-site.example" }
```

It is what an emailed link points at, and it is stated rather than read off the request so a
forged `Host` cannot decide where a sign-in link goes ([Accounts](auth.md#2-say-where-the-site-is)).

A second var goes with `CLOUDFLARE_API_TOKEN`, for the same reason — an account id is not private:

```jsonc
// wrangler.jsonc
"vars": { "CLOUDFLARE_WORKER": "<account-id>/<worker-name>" }
```

Two more go with the R2 secrets, for the same reason — an account id and a bucket name are not
private:

```jsonc
// wrangler.jsonc
"vars": { "R2_ACCOUNT_ID": "<account-id>", "R2_BUCKET": "your-site-media" }
```

The bucket also needs a CORS rule and a hostname of its own before anything can be uploaded to
it; [Media](media.md) is the whole setup in four steps.

One value is neither a secret nor a var: `PREVIEW_ENABLED` belongs to the **build**, because
the integration reads it while it sets up and leaves the `/_preview` route out of the bundle
where it is unset. Setting it on the deployed Worker does nothing; it goes in the build command
(below) or in the script that command runs ([Preview](preview.md#turning-it-on)).

The account id is in the dashboard's sidebar; the worker name is this file's own `name`. ⚠️ The
Workers Builds API is keyed on the worker's **tag**, not its name, and answers `200` with an
empty list for a name — which reads as "this commit never built" forever. The name is what you
put here and the admin looks the tag up, so you never have to find one.

`/admin/api` requests fail with an explicit error naming the missing secret. For local
`astro dev`, the same names go in `.dev.vars`. Once the site is up, **Settings** in the admin
checks every one of them and says which is missing ([Settings](diagnostics.md)).

A repository the App was never installed on answers `404` on every path, which looks the
same to GitHub's API as a file that does not exist. The admin tells them apart: it says
*The GitHub App cannot see owner/repo* and names the installation, so a wrong
`GITHUB_REPO` or a missing step 3 shows up as itself rather than as an entry that will not
open.

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
