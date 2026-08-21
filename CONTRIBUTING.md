# Contributing

## Workspace

pnpm monorepo, Node 22+.

```
packages/core    framework-agnostic logic — see packages/core/CONVENTIONS.md
packages/astro   the `astro-handover` integration
packages/ui      admin SPA (Svelte 5), pre-built to static assets
packages/cli     scaffolding and migrations
```

## Commands

```sh
pnpm install
pnpm build       # tsc to dist/, every package (core before astro)
pnpm dev         # the same, watching
pnpm test        # vitest, every package
pnpm typecheck   # tsc --noEmit, every package
pnpm lint        # biome
pnpm format      # biome, writes
```

`pnpm --filter <package-name> test` runs one package.

## Tests

Vitest. A new test is seen failing before it counts; a bug fix comes with a regression
test. Mock only at boundaries (network, clock, DB).

## The demo site

A separate repository installs this package with `"astro-handover": "link:../handover/packages/astro"`
and is how every change is exercised end to end.
