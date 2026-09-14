<script lang="ts">
import type { Change, DiffGroup } from '@handover/core';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

let {
  groups,
  mediaBase = '',
  uiLocale = 'en',
}: {
  groups: DiffGroup[];
  /** Where a stored media key is served from; without it a replaced picture has no thumbnails. */
  mediaBase?: string;
  uiLocale?: UiLocale;
} = $props();
const options = $derived(messageOptions(uiLocale));

const basename = (key: string) => key.slice(key.lastIndexOf('/') + 1);

const named = (locale: string) => formatLanguageName(locale, uiLocale);

const languages = $derived(groups.filter((g) => g.locale !== undefined).length);
// The shared group is only worth a heading where it is holding something back.
const shown = $derived(groups.filter((g) => g.locale !== undefined || g.changes.length > 0));
</script>

<div class="change-diff">
  {#each shown as group (group.locale ?? '')}
    <!-- h3 follows the surrounding h2. -->
    <h3>{group.locale ? named(group.locale) : languages === 2 ? m.diff_both_languages({}, options) : m.diff_all_languages({}, options)}</h3>
    <div class="diff">
      {#if group.removed}
        <div class="row is-block"><del>{m.diff_language_removed({ language: named(group.locale ?? '') }, options)}</del></div>
      {:else if group.changes.length === 0}
        <div class="row is-quiet"><small>{m.diff_everything_else({}, options)}</small>{m.diff_unchanged({}, options)}</div>
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
          {#if change.at === 'added'}<ins>{m.diff_added({}, options)}</ins>
          {:else if change.at === 'removed'}<del>{m.diff_removed({}, options)}</del>
          {:else}<span class="badge">{change.at === 'moved-up' ? m.diff_moved_up({}, options) : m.diff_moved_down({}, options)}</span>{/if}
          {#if change.type}<span class="sub">{m.diff_block_type({ type: change.type }, options)}</span>{/if}
          {#if change.at !== 'removed'}
            <span class="sub">{#if change.above}{m.diff_now_above({ label: change.above }, options)}{:else}{m.diff_at_end({}, options)}{/if}</span>
          {/if}
          {#if change.changes.length === 0 && change.at !== 'added' && change.at !== 'removed'}
            <span class="sub">{m.diff_nothing_inside({}, options)}</span>
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
      <!-- A picture has no history of its own. -->
      <div class="row is-block">
        <small>{label}</small>
        <span>{change.before && change.after ? m.diff_photo_replaced({}, options) : change.after ? m.diff_photo_added({}, options) : m.diff_photo_removed({}, options)}</span>
        <div class="pair">
          {#if change.before}
            <div><span class="lbl">{m.diff_before({}, options)} · {basename(change.before)}</span><div class="ratio-preview is-16x9 is-old"><img src="{mediaBase}/{change.before}" alt="" loading="lazy" /></div></div>
          {/if}
          {#if change.after}
            <div><span class="lbl">{m.diff_after({}, options)} · {basename(change.after)}</span><div class="ratio-preview is-16x9"><img src="{mediaBase}/{change.after}" alt="" loading="lazy" /></div></div>
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
      <div class="row"><small>{label}</small>{m.diff_changed({}, options)}</div>
    {/if}
  {/each}
{/snippet}
