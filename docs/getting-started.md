# Getting started

Handover is an Astro integration. It adds an admin UI at `/admin` that reads your content
files from the site's GitHub repository and commits edits back; your normal build then
publishes them. Nothing else runs.

Requirements: Astro 7, `@astrojs/cloudflare` 14, a GitHub repository for the site, and a
Cloudflare account. Until the package is on npm, install it from a checkout:

```sh
pnpm add ../handover/packages/astro   # or a tarball from `pnpm pack` in that folder
```

## 1. Add the integration

It needs the SSR adapter; without one it throws at startup.

```js
// astro.config.mjs
import cloudflare from '@astrojs/cloudflare';
import handover from 'astro-handover';
import { defineConfig } from 'astro/config';

export default defineConfig({
  session: false,
  adapter: cloudflare(),
  integrations: [handover()],
});
```

## 2. Describe your content

Schemas are plain Zod in `src/content/schemas.ts`, shared by Astro's `content.config.ts`
and Handover's `cms.config.ts` at the project root:

```ts
// cms.config.ts
import { defineConfig } from 'astro-handover';
import { listing } from './src/content/schemas';

export default defineConfig({
  collections: {
    listings: { schema: listing },
  },
});
```

Entries are YAML files at `src/content/<collection>/en/<slug>.yaml`, one key per field:

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

## 3. Connect GitHub and set the password

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

## 4. Edit and publish

```sh
pnpm astro dev
```

Open `http://localhost:4321/admin`, sign in with the password, then go to
`/admin/c/listings/seaview-cottage`. Every `z.string()` field in the schema is an input;
other field types show "Not editable here yet". Change a value and click **Publish this
entry**: Handover writes the YAML file back as one commit on `main` (message
`Update listings/seaview-cottage`) and shows the short commit sha. When two people edit
the same entry, the second Publish is refused with "Someone else published this entry
since you opened it" and nothing is overwritten.

Your build pipeline picks the commit up like any other push.
