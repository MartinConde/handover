<script lang="ts">
import { unsafeLinkScheme } from '@handover/core';
import type { Snippet } from 'svelte';
import PagePicker from '../../content/PagePicker.svelte';
import * as m from '../../paraglide/messages.js';
import type { FieldLevel } from './field-level.js';

type Card = Snippet<
  [id: string, labelId: string, says: string | undefined, what: string, open: () => void]
>;
let {
  level,
  id,
  at,
  text,
  says,
  chosen,
  empty,
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  text: string;
  says?: string;
  /** The reference widget's entry card and empty state, which a link to an entry shares. */
  chosen: Card;
  empty: Card;
} = $props();
const options = $derived(level.options);
const type = $derived(level.read([...at, 'type']) === 'url' ? 'url' : 'entry');
const ref = $derived(level.str([...at, 'ref']));
const href = $derived(level.str([...at, 'href']));

function setType(next: 'url' | 'entry') {
  level.writeMany(at, [
    { path: ['type'], value: next },
    { path: [next === 'url' ? 'ref' : 'href'], value: undefined },
  ]);
}
</script>

<div class="link-field-controls">
  <fieldset class="link-destination">
    <legend>{m.field_link_destination({}, options)}</legend>
    <div class="seg" role="group" aria-label={m.field_link_type({}, options)}>
      <button type="button" aria-pressed={type === 'entry'} onclick={() => setType('entry')}
        >{m.field_link_page_entry({}, options)}</button
      >
      <button type="button" aria-pressed={type === 'url'} onclick={() => setType('url')}>URL</button
      >
    </div>
    {#if type === 'url'}
      {@const scheme = unsafeLinkScheme('default', href)}
      <div class={['field', { 'is-invalid': scheme }]}>
        <div class="label-row"
          ><label for="{id}.href">{m.field_link_address({}, options)}</label></div
        >
        <input
          class="input"
          id="{id}.href"
          type="url"
          placeholder={m.field_link_address_placeholder({}, options)}
          aria-invalid={scheme ? 'true' : undefined}
          aria-describedby={scheme ? `${id}.href-err` : undefined}
          value={href}
          oninput={(e) =>
            level.writeMany(at, [
              { path: ['type'], value: 'url' },
              { path: ['href'], value: e.currentTarget.value },
            ])}
        />
        {#if scheme}<p class="error" id="{id}.href-err"
            >{m.field_link_scheme_not_allowed({ scheme }, options)}</p
          >{/if}
      </div>
    {:else if level.picker === id}
      <PagePicker
        {id}
        label={text}
        labelId="{id}-l"
        uiLocale={level.uiLocale}
        chosen={ref}
        onpick={(e) => {
          level.writeMany(at, [
            { path: ['type'], value: 'entry' },
            { path: ['ref'], value: e.path },
          ]);
          level.picker = '';
        }}
        onclose={() => (level.picker = '')}
      />
    {:else if ref}
      {@render chosen(`${id}.ref`, `${id}-l`, says, ref, () => (level.picker = id))}
    {:else}
      {@render empty(
        `${id}.ref`,
        `${id}-l`,
        says,
        m.field_link_choose({}, options),
        () => (level.picker = id),
      )}
    {/if}
  </fieldset>
  <div class="field"
    ><div class="label-row"><label for="{id}.label">{m.field_link_label({}, options)}</label></div
    ><input
      class="input"
      id="{id}.label"
      type="text"
      value={level.str([...at, 'label'])}
      oninput={(e) => level.write([...at, 'label'], e.currentTarget.value || undefined)}
    /></div
  >
  <label class="check" for="{id}.newTab"
    ><input
      type="checkbox"
      id="{id}.newTab"
      checked={level.read([...at, 'newTab']) === true}
      onchange={(e) => level.write([...at, 'newTab'], e.currentTarget.checked || undefined)}
    /><span>{m.field_link_new_tab({}, options)}</span></label
  >
</div>
