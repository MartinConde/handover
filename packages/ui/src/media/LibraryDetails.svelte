<script lang="ts">
import { formatMediaDate, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { sitePath } from '../request.js';
import MediaImage from '../shared/MediaImage.svelte';
import type { MetadataChange } from './metadata-lanes.svelte';
import { extension, fileSize, type LibraryItem, name } from './upload.js';

let {
  chosen,
  kind,
  base = '',
  uiLocale = 'en',
  recovered,
  usage,
  panel = $bindable(),
  tag = $bindable(),
  copied = $bindable(),
  describe,
  onclose,
  onframe,
  oncrop,
  ondelete,
}: {
  chosen: LibraryItem;
  kind: 'images' | 'files';
  /** Where a stored key is served from. */
  base?: string;
  uiLocale?: UiLocale;
  /** A picture the reconciliation job wrote, with no measured size. */
  recovered: boolean;
  /** How many places use the picture, as the sentence the library shows. */
  usage: string;
  panel?: HTMLElement;
  tag: string;
  copied: string;
  describe: (change: MetadataChange) => void;
  onclose: () => void;
  onframe: () => void;
  oncrop: () => void;
  ondelete: () => void;
} = $props();

const options = $derived(messageOptions(uiLocale));
// Percentages, which is what the dot and `object-position` want.
const dot = (item: LibraryItem) => [(item.focal?.[0] ?? 0.5) * 100, (item.focal?.[1] ?? 0.5) * 100];
const when = (at?: number) => (at ? formatMediaDate(at, uiLocale) : '');

function addTag() {
  const word = tag.trim();
  if (!word || chosen?.tags?.includes(word)) {
    tag = '';
    return;
  }
  describe({ tags: [...(chosen?.tags ?? []), word] });
  tag = '';
}

async function copyUrl(item: LibraryItem) {
  await navigator.clipboard?.writeText(item.url ?? `${base}/${item.src}`);
  copied = item.id;
}
</script>

<aside
  class={['lib-side', { 'is-recovered': recovered }]}
  tabindex="-1"
  bind:this={panel}
  aria-labelledby="lib-side-h"
>
  <div class="side-head">
    <button
      class="btn btn-ghost btn-icon inspector-close"
      type="button"
      aria-label={m.media_library_close_details({}, options)}
      onclick={onclose}>×</button
    >
    <p class="side-title" id="lib-side-h">{name(chosen)}</p>
    <p class="side-meta">
      {[
        chosen.width ? `${chosen.width} × ${chosen.height}` : '',
        fileSize(chosen.bytes, uiLocale),
        extension(chosen),
        chosen.createdAt
          ? m.media_library_uploaded({ date: when(chosen.createdAt) }, options)
          : '',
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  </div>
  {#if kind === 'images'}
    <div class="preview">
      <MediaImage src={chosen.url} alt="" {uiLocale} />
      <span
        class="focal"
        style="left: {dot(chosen)[0]}%; top: {dot(chosen)[1]}%"
        aria-hidden="true"
      ></span>
    </div>
    <p class="hint">{m.media_library_focal_hint({}, options)}</p>
    <div class="actions">
      <button class="action" type="button" onclick={onframe}>
        <svg aria-hidden="true" viewBox="0 0 24 24"
          ><circle cx="12" cy="12" r="9" /><circle
            cx="12"
            cy="12"
            r="3"
            fill="currentColor"
            stroke="none"
          /></svg
        >
        {m.media_library_focal({}, options)}
      </button>
      <!-- A picture nobody measured cannot be cropped. -->
      <button
        class="action"
        type="button"
        disabled={!(chosen.width && chosen.height)}
        onclick={oncrop}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24"
          ><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></svg
        >
        {m.media_library_crop({}, options)}
      </button>
      <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
        {#if copied === chosen.id}
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          {m.media_library_copied({}, options)}
        {:else}
          <svg aria-hidden="true" viewBox="0 0 24 24"
            ><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path
              d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
            /></svg
          >
          {m.media_library_copy_url({}, options)}
        {/if}
      </button>
    </div>
  {:else}
    <span class="file-icon is-big" aria-hidden="true">{extension(chosen)}</span>
    <div class="actions">
      <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
        {#if copied === chosen.id}
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          {m.media_library_copied({}, options)}
        {:else}
          <svg aria-hidden="true" viewBox="0 0 24 24"
            ><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path
              d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
            /></svg
          >
          {m.media_library_copy_url({}, options)}
        {/if}
      </button>
    </div>
  {/if}
  {#if recovered}
    <p class="notice">{m.media_library_recovered_hint({}, options)}</p>
  {/if}
  <dl class="facts">
    <div class="usage">
      <dt>{m.media_library_used({}, options)}</dt>
      <dd>
        {#if chosen.uses?.length}
          <details>
            <summary><span class="badge">{usage}</span></summary>
            <ul class="usage-list">
              {#each chosen.uses as use (use.entry)}
                <li><a href={sitePath(use.href)}>{use.title}</a><span class="where">{use.entry.split('/')[0]}</span></li>
              {/each}
            </ul>
          </details>
        {:else}
          <span class="badge">{m.media_library_not_used({}, options)}</span>
        {/if}
      </dd>
    </div>
    <div class="stored"><dt>{m.media_library_stored_as({}, options)}</dt><dd class="sub" title={chosen.src}>{chosen.src}</dd></div>
  </dl>
  <div class="field">
    <label for="lib-tags">{m.media_library_tags({}, options)}</label>
    <div class="tag-row">
      {#each chosen.tags ?? [] as word (word)}
        <span class="badge"
          >{word}
          <button
            type="button"
            aria-label={m.media_library_remove_tag({ tag: word }, options)}
            onclick={() => describe({ tags: (chosen?.tags ?? []).filter((t) => t !== word) })}
            >×</button
          ></span
        >
      {/each}
      <input
        id="lib-tags"
        type="text"
        placeholder={m.media_library_add_tag({}, options)}
        bind:value={tag}
        onblur={addTag}
        onkeydown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          addTag();
        }}
      />
    </div>
    <span class="hint">{m.media_library_tags_hint({}, options)}</span>
  </div>
  {#if kind === 'images'}
    <div class="field">
      <label for="lib-alt">{m.media_library_default_alt({}, options)}</label>
      <textarea
        class="input textarea"
        id="lib-alt"
        value={chosen.alt ?? ''}
        onchange={(e) => describe({ alt: e.currentTarget.value })}></textarea>
      <span class="hint">{m.media_library_alt_hint({}, options)}</span>
    </div>
  {/if}
  <div class="actions is-keep">
    <button
      class="btn btn-sm btn-ghost archive"
      type="button"
      onclick={() => describe({ archived: !chosen?.archived })}
    >
      {#if chosen.archived}
        <svg aria-hidden="true" viewBox="0 0 24 24"
          ><rect width="20" height="5" x="2" y="3" rx="1" /><path
            d="M4 8v11a2 2 0 0 0 2 2h2"
          /><path d="M20 8v11a2 2 0 0 1-2 2h-2" /><path d="m9 15 3-3 3 3" /><path
            d="M12 12v9"
          /></svg
        >
        {m.media_library_unarchive({}, options)}
      {:else}
        <svg aria-hidden="true" viewBox="0 0 24 24"
          ><rect width="20" height="5" x="2" y="3" rx="1" /><path
            d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"
          /><path d="M10 12h4" /></svg
        >
        {m.media_library_archive({}, options)}
      {/if}
    </button>
    <button
      class="btn btn-sm btn-ghost btn-quiet-danger delete"
      type="button"
      disabled={!!chosen.uses?.length}
      onclick={ondelete}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"
        ><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path
          d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        /><path d="M10 11v6" /><path d="M14 11v6" /></svg
      >
      {m.media_library_delete({}, options)}
    </button>
  </div>
  <p class="hint delete-hint">
    {#if chosen.uses?.length}
      {kind === 'images' ? m.media_library_delete_used_image({ usage }, options) : m.media_library_delete_used_file({ usage }, options)}
    {:else}
      {kind === 'images' ? m.media_library_delete_unused_image({}, options) : m.media_library_delete_unused_file({}, options)}
    {/if}
  </p>
</aside>
