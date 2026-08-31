<script lang="ts">
import type { Change, DiffGroup } from '@handover/core';

let { groups }: { groups: DiffGroup[] } = $props();

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const named = (locale: string) => {
  try {
    return LANGUAGES.of(locale) ?? locale;
  } catch {
    return locale;
  }
};

const languages = $derived(groups.filter((g) => g.locale !== undefined).length);
// The shared group is only worth a heading where it is holding something back; empty, it would
// say a language has nothing without being one.
const shown = $derived(groups.filter((g) => g.locale !== undefined || g.changes.length > 0));
</script>

<div class="change-diff">
  {#each shown as group (group.locale ?? '')}
    <!-- h3 and not the mockup's h4: this sits directly under the drawer's own h2 and under the
         history pane's, and a level nobody has is a level a screen reader reports as missing. -->
    <h3>{group.locale ? named(group.locale) : languages === 2 ? 'Both languages' : 'All languages'}</h3>
    <div class="diff">
      {#if group.removed}
        <div class="row is-block"><del>The {named(group.locale ?? '')} version was removed</del></div>
      {:else if group.changes.length === 0}
        <div class="row is-quiet"><small>Everything else</small>unchanged</div>
      {:else}
        {@render rows(group.changes, '')}
      {/if}
    </div>
  {/each}
</div>

{#snippet rows(changes: Change[], prefix: string)}
  {#each changes as change (change.path)}
    {@const label = prefix ? `${prefix} · ${change.label}` : change.label}
    {#if change.kind === 'row'}
      {#if change.at !== 'same'}
        <div class="row is-block">
          <small>{label}</small>
          {#if change.at === 'added'}<ins>added</ins>
          {:else if change.at === 'removed'}<del>removed</del>
          {:else}<span class="badge">moved {change.at === 'moved-up' ? 'up' : 'down'}</span>{/if}
          {#if change.type}<span class="sub">a {change.type} block</span>{/if}
          {#if change.at !== 'removed'}
            <span class="sub">{#if change.above}now above <b>{change.above}</b>{:else}at the end{/if}</span>
          {/if}
          {#if change.changes.length === 0 && change.at !== 'added' && change.at !== 'removed'}
            <span class="sub">nothing inside it changed</span>
          {/if}
        </div>
      {/if}
      {@render rows(change.changes, label)}
    {:else if change.kind === 'words'}
      <div class="row">
        <small>{label}</small>{#each change.parts as part, i (i)}{#if part.mark === 'del'}<del
            >{part.text}</del
          >{:else if part.mark === 'ins'}<ins>{part.text}</ins>{:else}{part.text}{/if}{/each}
      </div>
    {:else if change.kind === 'value'}
      <div class="row">
        <small>{label}</small>{#if change.before !== undefined}<del>{change.before}</del>{/if}{#if change.before !== undefined && change.after !== undefined}<span
            aria-hidden="true"
          >{' → '}</span>{/if}{#if change.after !== undefined}<ins>{change.after}</ins>{/if}
      </div>
    {:else}
      <div class="row"><small>{label}</small>changed</div>
    {/if}
  {/each}
{/snippet}
