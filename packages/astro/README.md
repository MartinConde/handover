# astro-handover

Handover is a git-backed CMS integration for Astro sites on Cloudflare Workers. It adds
the admin routes and UI, content schemas, rendering components, and the `handover` CLI.

This package is private and not published to npm yet. For development from a checkout,
build the Handover workspace first and link this package into the site. For an install
that does not retain the checkout, pack and install all three private packages:

- `astro-handover`
- `@handover/core`
- `@handover/cli`

The consumer must override the latter two names to their local archives because the
`astro-handover` archive records them as version `0.0.0`; they cannot be resolved from
the public registry.

The source checkout contains the complete setup guide in `docs/getting-started.md`.
