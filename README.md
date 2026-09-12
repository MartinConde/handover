# Handover

A git-backed CMS for Astro sites on Cloudflare Workers: editors change content in an
admin UI, Handover commits the result to the site's repository, and the normal build
publishes it. One `astro-handover` integration, no database for content, no separate server.

Editors sign in with an account, edit two or more languages side by side, write rich text,
put pictures and files in R2, keep drafts that survive a refresh, see the page before it goes
out, and publish as one commit. Pre-1.0: the file format and `cms.config.ts` still move
between releases, and every change is in [CHANGELOG.md](CHANGELOG.md).

```sh
pnpm add --save-prod link:../handover/packages/astro
```

It is not on npm yet. Build the checkout before linking it, or install the three private
package archives using the [getting-started recipe](docs/getting-started.md#install-the-unpublished-package).

Docs: [Getting started](docs/getting-started.md) · [Setting a site up](docs/init.md) · [Template convention](docs/template-convention.md) · [Canvas editing](docs/canvas.md) · [Deploy](docs/deploy.md) · [How it works](docs/how-it-works.md)
