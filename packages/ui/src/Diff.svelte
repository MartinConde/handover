<script lang="ts">
import type { Change, DiffGroup } from '@handover/core';

let {
  groups,
  mediaBase = '',
}: {
  groups: DiffGroup[];
  /** Where a stored media key is served from; without it a replaced picture has no thumbnails. */
  mediaBase?: string;
} = $props();

const basename = (key: string) => key.slice(key.lastIndexOf('/') + 1);

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
    {:else if change.kind === 'picture'}
      <!-- A picture has no history of its own — its key never changes — so the change is the
           two pictures, named, and never the two keys. -->
      <div class="row is-block">
        <small>{label}</small>
        <span>photo {change.before && change.after ? 'replaced' : change.after ? 'added' : 'removed'}</span>
        <div class="pair">
          {#if change.before}
            <div><span class="lbl">Before · {basename(change.before)}</span><div class="ratio-preview is-16x9 is-old"><img src="{mediaBase}/{change.before}" alt="" loading="lazy" /></div></div>
          {/if}
          {#if change.after}
            <div><span class="lbl">After · {basename(change.after)}</span><div class="ratio-preview is-16x9"><img src="{mediaBase}/{change.after}" alt="" loading="lazy" /></div></div>
          {/if}
        </div>
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
