# Deploy

The site is one Cloudflare Worker: static pages as assets, `/admin` and `/admin/api` as
SSR routes. Handover needs one binding — a D1 database for unpublished edits — five
required secrets, and one more per optional feature.

## wrangler.jsonc

```jsonc
{
  "name": "your-site",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "main": "@astrojs/cloudflare/entrypoints/server",
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

## The database

Edits are held in D1 until they are published, so the admin survives a refresh, a crash
and a change of device. Create the database and take the id from the output:

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
| `DEEPL_API_KEY` | [machine translation](translating.md#a-machines-first-draft) from the admin — a free key ends in `:fx` and is recognised as one. Without it the translate buttons are not drawn |
| `RESEND_API_KEY` | sending mail, when `cms.config.ts` says `mailer: { provider: 'resend', … }` ([Configuration](configuration.md#mailer)). Verify the sending domain at `resend.com/domains` and put an address on it in `from` — until you do, Resend only delivers to the address its own account was created with |

`/admin/api` requests fail with an explicit error naming the missing secret. For local
`astro dev`, the same names go in `.dev.vars`.

A repository the App was never installed on answers `404` on every path, which looks the
same to GitHub's API as a file that does not exist. The admin tells them apart: it says
*The GitHub App cannot see owner/repo* and names the installation, so a wrong
`GITHUB_REPO` or a missing step 3 shows up as itself rather than as an entry that will not
open.

## Building on push

Connect the repository to the Worker under **Workers & Pages → your Worker → Settings →
Builds** so every commit — including the ones Handover makes — rebuilds and deploys:

- Build command: `pnpm build`
- Deploy command: `npx wrangler d1 migrations apply your-site --remote && npx wrangler deploy`

Migrations run before the new code is live, so a deploy can never reach a database that is
missing a column, and applying an already-applied file does nothing.

Commits an editor publishes are ordinary pushes to `main`; one publish is one build. A
first deploy from your machine is `pnpm astro build && wrangler deploy`.
