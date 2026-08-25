# Handover docs

- [Getting started](getting-started.md) — install the integration, describe a collection, edit and publish an entry.
- [Configuration](configuration.md) — `cms.config.ts`: `collections`, `route`, `index`, `load`; how entry filenames are derived.
- [Languages](i18n.md) — the `i18n` block, why it has to match `astro.config.mjs`, the folder per language, which fields are translated, and the structure every language shares.
- [Translating](translating.md) — the language switcher, side by side, what a save of a translation writes, making the languages agree, machine translation, staleness.
- [Content format](content-format.md) — what the YAML files look like, the reserved `_` keys, `_id` on blocks, hiding an entry.
- [Site files](site-files.md) — globals, the `navigation` menus, `redirects.yaml` and `_templates/`.
- [Field types](field-types.md) — every field type, its schema and how it is stored; groups, arrays and blocks.
- [Template convention](template-convention.md) — `schemas.ts` and `content.config.ts`, `load()` and `ContentSource`, layouts that take `data` as a prop.
- [Rendering content](rendering.md) — `<Blocks />`, `<Markdown />`, `<LocaleSwitcher />` and hidden entries.
- [Drafts and publishing](publishing.md) — autosave into D1, what a draft holds, the pending-changes drawer, publishing in one commit, the endpoints, the content index.
- [Working together](working-together.md) — the soft lock on an entry, what "Being edited by…" takes away, and a file somebody changed in the repository.
- [Accounts and signing in](auth.md) — the secrets, `HANDOVER_BASE_URL`, seeding the first owner, the three ways in, the account page, closed sign-up and rate limiting.
- [Roles and permissions](roles.md) — the two roles, what each may do, and what is behind the session and what is deliberately not.
- [Sending email](email.md) — the `mailer` block, verifying a sending domain, and the check that proves a key.
- [Activity log](activity.md) — what is recorded and what is not, who sees whose events, the read endpoint and its filters.
- [CLI](cli.md) — `handover migrate` for content files, `handover db generate` for the package's tables.
- [Deploy](deploy.md) — `wrangler.jsonc`, the GitHub App, secrets, building on push.
- [How it works](how-it-works.md) — packages, injected routes, virtual config, the publish path. For contributors.
