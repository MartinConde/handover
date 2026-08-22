# Handover

A git-backed CMS for Astro sites on Cloudflare Workers: editors change content in an
admin UI, Handover commits the result to the site's repository, and the normal build
publishes it. One `astro-handover` integration, no database for content, no separate server.

Early: text fields only, one locale, a password instead of accounts. See [CHANGELOG.md](CHANGELOG.md).

```sh
pnpm add astro-handover   # not on npm yet — install from a checkout, see docs/getting-started.md
```

Docs: [Getting started](docs/getting-started.md) · [Template convention](docs/template-convention.md) · [Deploy](docs/deploy.md) · [How it works](docs/how-it-works.md)
