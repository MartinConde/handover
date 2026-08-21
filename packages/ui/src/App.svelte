<script lang="ts">
import Login from './Login.svelte';

let { authed }: { authed: boolean } = $props();
// svelte-ignore state_referenced_locally -- the prop is the initial value on purpose
let loggedIn = $state(authed);
</script>

{#if !loggedIn}
  <Login onlogin={() => (loggedIn = true)} />
{:else}
<div class="shell">
  <aside class="sidebar" aria-label="Main">
    <div class="site-name">Handover</div>
    <nav class="nav">
      <a href="/admin" aria-current="page">Dashboard</a>
    </nav>
    <nav class="nav" aria-labelledby="nav-content">
      <div class="nav-label" id="nav-content">Content</div>
    </nav>
  </aside>
  <div class="shell-body">
    <header class="topbar">
      <button class="indicator" type="button">No unpublished changes</button>
      <span class="spacer"></span>
      <span class="pill">Live</span>
      <div class="user-menu"></div>
    </header>
    <main class="main">
      <h1>Dashboard</h1>
    </main>
  </div>
</div>
{/if}

<style>
  /* Layout only; the 0.5d tokens arrive with the first real screen. */
  .shell { display: grid; grid-template-columns: 15rem 1fr; min-height: 100vh; }
  .topbar { display: flex; align-items: center; gap: 0.5rem; }
  .spacer { flex: 1; }
</style>
