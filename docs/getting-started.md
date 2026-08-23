# Getting started

Handover is an Astro integration. It adds an admin UI at `/admin` that reads your content
files from the site's GitHub repository and commits edits back; your normal build then
publishes them. Nothing else runs.

Requirements: Astro 7, `@astrojs/cloudflare` 14, a GitHub repository for the site, and a
Cloudflare account with a D1 database for the site's unpublished edits ([Deploy](deploy.md#the-database)). Until the package is on npm, install it from a checkout:

```sh
pnpm add ../handover/packages/astro   # or a tarball from `pnpm pack` in that folder
```

## 1. Add the integration

It takes your `cms.config.ts` — step 2 writes it — and needs the SSR adapter; without one
it throws at startup.

```js
// astro.config.mjs
import cloudflare from '@astrojs/cloudflare';
import handover from 'astro-handover';
import { defineConfig } from 'astro/config';
import cms from './cms.config.ts';

export default defineConfig({
  session: false,
  adapter: cloudflare(),
  // The same block goes in cms.config.ts; the build stops if the two disagree.
  i18n: { locales: ['en'], defaultLocale: 'en' },
  integrations: [handover(cms)],
});
```

## 2. Describe your content

Schemas are plain Zod in `src/content/schemas.ts`, shared by Astro's `content.config.ts`
([what that file looks like](template-convention.md#contentconfigts)) and Handover's
`cms.config.ts` at the project root:

```ts
// cms.config.ts
import { defineConfig } from 'astro-handover';
import { listing } from './src/content/schemas';

export default defineConfig({
  i18n: { locales: ['en'], defaultLocale: 'en' },
  collections: {
    listings: { schema: listing },
  },
});
```

Entries are YAML files at `src/content/<collection>/<locale>/<slug>.yaml`, one key per
field — one folder per language, `en/` here ([Languages](i18n.md)):

```yaml
# src/content/listings/en/seaview-cottage.yaml
title: Seaview Cottage
location: Port Isaac, Cornwall
price: £1,200 per week
summary: A whitewashed two-bedroom cottage above the harbour.
```

Hand-written files like this are fine to start with. When Handover writes a file back it
uses one fixed shape — strings double-quoted, multi-line text as a `|-` block, keys
starting with `_` first, empty keys left out — so the first publish normalises the file
and every later edit is a diff of just the lines that changed.

Pages render them through a loader and a layout that takes `data` as a prop — see
[Template convention](template-convention.md). Each collection can also declare its
`route`, `index` and `load` — see [Configuration](configuration.md).

## 3. Connect GitHub, the database and the password

Handover reads and writes through a GitHub App installed on the site's repository. Create
the App and the secrets as described in [Deploy](deploy.md), then for local development
put the same values in `.dev.vars` (gitignored):

```ini
ADMIN_PASSWORD=choose-something
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
GITHUB_REPO=you/your-site
```

`ADMIN_PASSWORD` is a temporary gate that a later release replaces with real accounts.

Handover keeps edits in D1 until they are published, so create the database, bind it as
`DB` and apply the migrations before the first deploy — all three steps are in
[Deploy](deploy.md#the-database).

## 4. Edit and publish

```sh
pnpm astro dev
```

Open `http://localhost:4321/admin` and sign in with the password. Each collection is a
link in the sidebar; **Listings** lists every entry with its title, and each row opens the
editor. **New listing** asks for a title, shows the filename it derives from it and opens
the new entry — which is a draft until you publish it, so nothing is in git yet. **Rename**
and **Delete** are on the row.

In the editor each field gets the widget for its type ([Field types](field-types.md#in-the-admin));
the five that need a picker — `image`, `file`, `embed`, `seo` and `reference` — show their
stored value read-only until it arrives, saying so under the value. Change a value: two
seconds later the edit is saved into D1, and it is still there if you reload — see
[Drafts and publishing](publishing.md). Click **Publish…**: the pending-changes
drawer lists every edit waiting to go out, and **Publish 1 file** writes them back as one
commit on `main`. If someone changed one of those files in the repository since you opened
it, the publish is refused and nothing is overwritten; **Discard** on that row gives up
your changes to it and takes theirs, which is the only way out of that refusal today.

Your build pipeline picks the commit up like any other push.
