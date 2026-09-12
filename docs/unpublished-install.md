# Install from archives

Use this path while Handover's packages are private and a build machine cannot access the
source checkout. A local development site can use the shorter checkout link in
[Getting started](getting-started.md#install-the-unpublished-package).

Build before packing: each archive contains generated JavaScript and declarations, and
`astro-handover` also contains the built admin assets. From the site directory:

```sh
pnpm -C ../handover install --frozen-lockfile
pnpm -C ../handover build
mkdir -p vendor
pnpm -C ../handover/packages/core pack --pack-destination "$PWD/vendor"
pnpm -C ../handover/packages/cli pack --pack-destination "$PWD/vendor"
pnpm -C ../handover/packages/astro pack --pack-destination "$PWD/vendor"
```

Point the direct dependency at its archive in `package.json`:

```json
{
  "dependencies": {
    "astro-handover": "file:vendor/astro-handover-0.0.0.tgz"
  }
}
```

The packed manifest names `@handover/core` and `@handover/cli` as version `0.0.0` too.
They are private packages, so add root overrides in `pnpm-workspace.yaml`; merge these with
any existing workspace settings:

```yaml
overrides:
  '@handover/core': file:vendor/handover-core-0.0.0.tgz
  '@handover/cli': file:vendor/handover-cli-0.0.0.tgz
```

Run `pnpm install`. Commit the three archives, `package.json`, `pnpm-workspace.yaml`, and the
updated lockfile when the site builds without the source checkout. Rebuild and repack all three
archives together after a Handover source change.

The `0.0.0` filenames are the current pre-release names. If the package version changes, use
the filenames printed by `pnpm pack` in both manifests.
