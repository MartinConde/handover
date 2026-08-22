# Deploy

The site is one Cloudflare Worker: static pages as assets, `/admin` and `/admin/api` as
SSR routes. Handover adds no bindings; it needs five secrets.

## wrangler.jsonc

```jsonc
{
  "name": "handover-demo",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "main": "@astrojs/cloudflare/entrypoints/server",
  "assets": { "binding": "ASSETS", "directory": "./dist" }
}
```

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
| `ADMIN_PASSWORD` | the admin password — temporary, a later release replaces it |
| `GITHUB_APP_ID` | App ID from step 2 |
| `GITHUB_INSTALLATION_ID` | installation id from step 3 |
| `GITHUB_PRIVATE_KEY` | the PKCS#8 PEM |
| `GITHUB_REPO` | `owner/repo` of the site |

Optional: `GITHUB_BRANCH` if the live branch is not `main`.

`/admin/api` requests fail with an explicit error naming the missing secret. For local
`astro dev`, the same names go in `.dev.vars`.

## Building on push

Connect the repository to the Worker under **Workers & Pages → your Worker → Settings →
Builds** so every commit — including the ones Handover makes — rebuilds and deploys:

- Build command: `pnpm build`
- Deploy command: `npx wrangler deploy`

Commits an editor publishes are ordinary pushes to `main`; one publish is one build. A
first deploy from your machine is `pnpm astro build && wrangler deploy`.
