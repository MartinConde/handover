<script lang="ts">
import type { Snippet } from 'svelte';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

let {
  saving,
  failed,
  unsaved,
  uiLocale = 'en',
  short = false,
  announce = false,
  failure,
}: {
  saving: boolean;
  failed: boolean;
  unsaved: boolean;
  uiLocale?: UiLocale;
  /** "Unsaved" for the narrow canvas bar, "Unsaved changes" elsewhere. */
  short?: boolean;
  /** Puts role="status" on the text; the translation pane has its own live region. */
  announce?: boolean;
  /** What follows "Not saved", such as a retry button. */
  failure?: Snippet;
} = $props();
const options = $derived(messageOptions(uiLocale));
</script>

<span
  class={['autosave', { 'is-saving': saving, 'is-offline': failed }]}
  role={announce ? 'status' : undefined}
>
  {#if saving}{m.editor_save_saving({}, options)}{:else if failed}{m.editor_save_not_saved(
      {},
      options,
    )}{#if failure}{' '}{@render failure()}{/if}{:else if unsaved}{short
      ? m.editor_save_unsaved({}, options)
      : m.editor_save_unsaved_changes({}, options)}{:else}{m.editor_save_saved({}, options)}{/if}
</span>
