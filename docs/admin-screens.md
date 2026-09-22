# Admin screens

A page of your own inside the admin, at `/admin/x/<key>`: an analytics view, a board that
reads a booking system, a status screen — anything that is not content. It is a Svelte
component in your repo. The admin serves it inside its own shell, so it has the sidebar, the
top bar, the session and the same stylesheet as every other screen.

## What your site needs

A site with screens rebuilds the admin during its own build, so two things go in the site
once, whether or not you use pnpm:

```jsonc
// package.json
"dependencies": {
  "svelte": "…",
  "@inlang/paraglide-js-svelte": "…"
}
```

Take both versions from `@handover/ui`'s own `peerDependencies`, in
`node_modules/@handover/ui/package.json`. `svelte` has to be yours: everything must resolve to
one copy, and the build stops and names them if it finds two. `@inlang/paraglide-js-svelte` is
what the admin's own media screens use to print a message.

On pnpm, add one setting beside it:

```yaml
# pnpm-workspace.yaml
autoInstallPeers: false
```

Without it pnpm installs a peer of that message component and pulls in about 600 MB of
translation compiler your site never runs. It is a blunt setting — peer auto-install is off
for every dependency you have — so anything that was relying on it has to be listed by hand.

## Declare it

```ts
// cms.config.ts
admin: {
  screens: {
    analytics: {
      component: './src/admin/Analytics.svelte',
      label: { en: 'Analytics', de: 'Statistik' },
      roles: ['owner'],
    },
  },
},
```

The key is the address segment — `/admin/x/analytics` — and the label is what the sidebar
calls it, under **Site**. Every key is checked at build time, including that the component
file is there; see [`admin`](configuration.md#admin) for each key.

## Write it

```svelte
<!-- src/admin/Analytics.svelte -->
<script lang="ts">
import type { ScreenProps } from 'astro-handover/screen';

let { session, request, uiLocale }: ScreenProps = $props();

type Answer =
  | { configured: false }
  | { configured: true; error: string }
  | { configured: true; page: unknown };

const answer = request('/admin/api/openpanel').then((r) => r.json() as Promise<Answer>);

// The screen brings its own strings: the admin translates its shell, not a site's pages.
const t = {
  en: { title: 'Analytics', off: 'Not connected.', on: 'The last ten events:' },
  de: { title: 'Statistik', off: 'Nicht verbunden.', on: 'Die letzten zehn Ereignisse:' },
}[uiLocale];
</script>

<h1>{t.title}</h1>
<p>Signed in as {session.user.name}.</p>

{#await answer then data}
  {#if !data.configured}
    <p>{t.off}</p>
  {:else if 'error' in data}
    <p>{data.error}</p>
  {:else}
    <p>{t.on}</p>
    <pre>{JSON.stringify(data.page, null, 2)}</pre>
  {/if}
{/await}
```

The demo's copy of this file says more in each language and scopes a panel in a `<style>` block.

Four props, and nothing else:

| Prop | What it is |
|---|---|
| `session` | `{ user, role }` for whoever is signed in, as `/admin/api/ping` answered it. |
| `request` | The admin's own `fetch`. It carries the session and resolves a path against the site's base, so `'/admin/api/…'` is all you write. |
| `navigate` | `navigate(to)` moves the admin to another of its addresses without a page load. It resolves `false` when an open editor refuses to leave. |
| `uiLocale` | The language the admin is being read in, `'en'` or `'de'`. |

The admin draws the `<main>` landmark around your component, so start at `<h1>` and write
content only. The component is mounted when the address is opened and thrown away when it is
left; it gets no other context from the shell.

## Its data

Put the endpoint it reads in your own site, at `src/pages/admin/api/<name>.ts`. Everything
under `/admin/api/` is behind the admin's session: your endpoint answers `401` without one,
and `locals.handover` holds the signed-in user and their role, the same as the admin's own
endpoints see them. It is typed for you — the integration writes the declaration into `.astro/`.

A screen is browser code, so anything it must not hold — an API key, a provider token — is
read in that endpoint and never sent to it ([Secrets](secrets.md)).

```ts
// src/pages/admin/api/openpanel.ts
import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  if (locals.handover?.role !== 'owner') {
    return Response.json({ error: 'Owners only' }, { status: 403 });
  }

  const { OPENPANEL_CLIENT_ID: clientId, OPENPANEL_SECRET: secret } = env;
  if (!clientId || !secret) return Response.json({ configured: false });

  const answer = await fetch('https://api.openpanel.dev/export/events?limit=10', {
    headers: { 'openpanel-client-id': clientId, 'openpanel-client-secret': secret },
  });
  if (!answer.ok) {
    return Response.json({ configured: true, error: `OpenPanel answered ${answer.status}` });
  }
  return Response.json({ configured: true, page: await answer.json() });
};
```

Secrets reach a Worker through `cloudflare:workers`. If your site does not generate Worker types
with `wrangler types`, declare the module once, anywhere under `src/`:

```ts
// src/env.d.ts
declare module 'cloudflare:workers' {
  export const env: Record<string, string | undefined>;
}
```

## Who sees it

`roles` hides the link and answers the address with the dashboard for a role that is not
listed. That is a courtesy, not a permission: the browser is not where authorisation happens.
Whatever your endpoint does has to check `locals.handover.role` itself ([Roles](roles.md)).

## The build and the dev loop

`astro build` builds the admin again inside your site with your components compiled in, before
it builds the site itself. The output goes to `.astro/handover/ui/` (git-ignore `.astro/`, which
Astro already tells you to) and is inlined into the Worker like the shipped one. It costs about
two seconds a build. A site with no screens builds nothing extra and ships the admin as it came.

`astro dev` runs the same build once at startup and then watches: save your component, wait for
the rebuild, reload the page. There is no hot reload — the admin is one bundle, not a module
graph the site's dev server owns.

Three things stop the build, each naming the file:

- a `component` path that is not there, refused before anything is built
- a Svelte error in your component
- two copies of `svelte`, which would put two runtimes in one document

## Styling

Your component is in the same document as the admin, so its stylesheet applies and the
variables below are the ones to build with. Use them rather than your own colours and the
screen keeps up with the admin.

| Variable | For |
|---|---|
| `--bg`, `--surface` | the canvas behind a panel, and the panel |
| `--ink`, `--ink-2`, `--ink-3` | body text, secondary text, tertiary text |
| `--accent`, `--accent-ink`, `--accent-soft` | the accent, text on it, a tinted background |
| `--border`, `--radius`, `--radius-lg`, `--shadow-panel` | a hairline, a control, a panel, a panel's shadow |
| `--text-xs` … `--text-xl` | the type scale; `--text-md` is body |
| `--s-1` … `--s-12` | space, on a 4px base |

Scope your own CSS to your component — Svelte does that for you in a `<style>` block.
