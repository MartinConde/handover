# Admin screens

A page of your own inside the admin, at `/admin/x/<key>`: an analytics view, a board that
reads a booking system, a status screen — anything that is not content. It is a Svelte
component in your repo. The admin serves it inside its own shell, so it has the sidebar, the
top bar, the session and the same stylesheet as every other screen.

**Not finished yet.** The admin serves the address and draws the sidebar link, but the build
that compiles your component into it is not in the package. Until it is, `/admin/x/<key>`
answers with the dashboard. The config, the props and the styling below are what your
component will be handed.

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

const visitors = request('/admin/api/analytics').then((r) => r.json());
</script>

<h1>Analytics</h1>
{#await visitors then data}
  <p>{data.visitors} visitors</p>
{/await}
```

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
endpoints see them.

A screen is browser code, so anything it must not hold — an API key, a provider token — is
read in that endpoint and never sent to it ([Secrets](secrets.md)).

## Who sees it

`roles` hides the link and answers the address with the dashboard for a role that is not
listed. That is a courtesy, not a permission: the browser is not where authorisation happens.
Whatever your endpoint does has to check `locals.handover.role` itself ([Roles](roles.md)).

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
