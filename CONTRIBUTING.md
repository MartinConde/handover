# Contributing

## Workspace

pnpm monorepo, Node 22+.

```
packages/core    framework-agnostic logic — see packages/core/CONVENTIONS.md
packages/astro   the `astro-handover` integration
packages/ui      admin SPA (Svelte 5 + Vite), built into packages/astro/dist/ui/
packages/cli     scaffolding and migrations
```

## Commands

```sh
pnpm install
git config core.hooksPath .githooks   # once per checkout: the pre-push format-lock check
pnpm build       # every package: tsc to dist/, vite for ui (core, ui before astro)
pnpm dev         # the same, watching
pnpm test        # vitest, every package
pnpm typecheck   # tsc --noEmit (svelte-check in ui), every package
pnpm lint        # biome
pnpm format      # biome, writes
```

`pnpm --filter <package-name> test` runs one package.

`pnpm --filter @handover/ui fixtures` serves `packages/ui/index.html`: the per-field diff over
one fixture entry, and the page picker in the shapes the fields open it in — the only way to see
either component outside the admin. It is a dev server only — the admin bundle's entry is
`src/main.ts` and never that page.

## Tests

Vitest. A new test is seen failing before it counts; a bug fix comes with a regression
test. Mock only at boundaries (network, clock, DB). The GitHub integration tests in `packages/core` run only when `.env.test`
exists at the repo root — copy `.env.test.example` and point it at a private throwaway repo
the App is installed on.

### Golden files

`packages/core/test/golden/` holds the serialiser's byte-for-byte output for each shape, and
the content format is locked. Changing a golden means every content file already written in
that shape now round-trips differently, so CI refuses it unless the same commit raises
`FORMAT_VERSION` in `packages/core/src/content.ts` — which in turn needs the `from: N` step
in `migrate.ts` that `migrate.test.ts` checks for. Adding a golden is free. The check is
`scripts/format-lock.sh`, run by the `format-lock` job against the base of the push or pull
request, and by `.githooks/pre-push` against the commit `main` is at on the remote — so the
push is refused here rather than the run going red afterwards. The hook needs enabling once
per checkout, since git does not install hooks on clone:

```sh
git config core.hooksPath .githooks
```

`git push --no-verify` skips it. That is deliberate: the hook is there to catch the
accident, and CI is what catches the decision.

## The demo site

A separate repository installs this package with `"astro-handover": "link:../handover/packages/astro"`
and is how every change is exercised end to end. Its deploy cannot see this checkout, so it
commits `pnpm pack` tarballs of `core` and `astro` under `vendor/` (`pnpm vendor` there)
and swaps them in at build time.
