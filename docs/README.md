# Handover docs

- [Getting started](getting-started.md) — install the integration, describe a collection, edit and publish an entry.
- [Configuration](configuration.md) — `cms.config.ts`: `collections`, `route`, `index`, `load`; how entry filenames are derived.
- [Content format](content-format.md) — what the YAML files look like, the reserved `_` keys, `_id` on blocks, hiding an entry.
- [Field types](field-types.md) — every field type, its schema and how it is stored; groups, arrays and blocks.
- [Template convention](template-convention.md) — `schemas.ts`, `load()` and `ContentSource`, layouts that take `data` as a prop, `<Blocks />` and `<Markdown />`.
- [Deploy](deploy.md) — `wrangler.jsonc`, the GitHub App, secrets, building on push.
- [How it works](how-it-works.md) — packages, injected routes, virtual config, the publish path. For contributors.
